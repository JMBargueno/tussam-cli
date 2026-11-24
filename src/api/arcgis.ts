import type {
  Line,
  LineDirectionInfo,
  LineStop,
  NetworkTopology,
  Stop,
  StopLineRef,
  SyncProgressCallback,
} from '../types.js';
import { haversineMeters } from '../utils/geo.js';
import { TussamApiError } from './errors.js';

export const ARCGIS_LINES_URL =
  'https://services1.arcgis.com/hcmP7kr0Cx3AcTJk/arcgis/rest/services/TUSSAM_Lineas/FeatureServer/0/query?where=1%3D1&outFields=Linea,LabelLinea,Sublinea,Ruta,NombreLinea,NombreRuta,DestinoRuta,Color,Package&returnGeometry=false&f=json';

export const ARCGIS_PARADAS_BASE_URL =
  'https://services1.arcgis.com/hcmP7kr0Cx3AcTJk/arcgis/rest/services/TUSSAM_Paradas/FeatureServer/0/query';

const PAGE_SIZE = 2_000;

interface ArcGisLineAttributes {
  Linea?: number;
  LabelLinea?: string;
  Sublinea?: number;
  Ruta?: number;
  NombreLinea?: string;
  NombreRuta?: string;
  DestinoRuta?: string;
  Color?: string;
  Package?: number;
}

interface ArcGisStopAttributes {
  Linea?: number;
  LabelLinea?: string;
  Sublinea?: number;
  Ruta?: number;
  Nodo?: number | string;
  Nombre?: string;
  Distancia?: number;
  Package?: number;
}

interface ArcGisQueryResponse<TAttrs> {
  exceededTransferLimit?: boolean;
  error?: { code?: number; message?: string };
  features?: Array<{
    attributes?: TAttrs;
    geometry?: { x?: number; y?: number } | null;
  }>;
}

export interface ArcGisTopologyOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onProgress?: SyncProgressCallback;
}

export function cleanArcGisStopName(rawName: string): { name: string; icons: string[] } {
  const icons = new Set<string>();
  const tagRegex = /\[([RCM])\]/gi;
  for (const match of rawName.matchAll(tagRegex)) {
    const code = match[1]?.toUpperCase();
    if (code === 'R') {
      icons.add('renfe');
    } else if (code === 'C') {
      icons.add('consorcio');
    } else if (code === 'M') {
      icons.add('metro');
    }
  }

  const name = rawName
    .replace(/(\s*\[[RCM]\])+\s*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { name, icons: Array.from(icons) };
}

export function cleanArcGisLineDescription(rawDesc: string): string {
  return rawDesc
    .replace(/\s*\[[DV]\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanArcGisDestination(rawDest: string): string {
  return rawDest
    .replace(/\s*\.\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getMaxPackage<T extends { Package?: number }>(items: readonly T[]): number | null {
  let maxPkg: number | null = null;
  for (const item of items) {
    if (typeof item.Package === 'number' && Number.isFinite(item.Package)) {
      if (maxPkg === null || item.Package > maxPkg) {
        maxPkg = item.Package;
      }
    }
  }
  return maxPkg;
}

async function fetchArcGisJson<TAttrs>(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ArcGisQueryResponse<TAttrs>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TussamApiError(
      `Network error requesting ArcGIS (${url}): ${err instanceof Error ? err.message : String(err)}`,
      undefined,
      url,
    );
  }

  if (!response.ok) {
    throw new TussamApiError(`ArcGIS returned HTTP ${response.status}`, response.status, url);
  }

  const payload = (await response.json()) as ArcGisQueryResponse<TAttrs>;
  if (payload.error) {
    throw new TussamApiError(
      payload.error.message || 'ArcGIS query returned an error',
      payload.error.code,
      url,
    );
  }
  return payload;
}

function deduplicateConsecutiveStops(stops: readonly LineStop[]): LineStop[] {
  const result: LineStop[] = [];
  for (const stop of stops) {
    const prev = result[result.length - 1];
    if (prev && prev.code === stop.code) {
      continue;
    }
    result.push(stop);
  }
  return result;
}

interface SortedRutaEntry {
  ruta: number;
  stops: LineStop[];
}

function buildSortedRutas(rutaMap: Map<number, LineStop[]>): SortedRutaEntry[] {
  return Array.from(rutaMap.entries())
    .sort(([rA], [rB]) => rA - rB)
    .map(([ruta, stops]) => ({
      ruta,
      stops: deduplicateConsecutiveStops(
        [...stops].sort((a, b) => a.distanceMeters - b.distanceMeters),
      ),
    }))
    .filter((entry) => entry.stops.length >= 2);
}

function selectBestRutaForParity(
  rutas: readonly SortedRutaEntry[],
  isOdd: boolean,
): SortedRutaEntry | undefined {
  const matching = rutas.filter((r) => (isOdd ? r.ruta % 2 === 1 : r.ruta % 2 === 0));
  if (matching.length === 0) {
    return undefined;
  }
  return [...matching].sort((a, b) => b.stops.length - a.stops.length || a.ruta - b.ruta)[0];
}

function selectPrimarySublinea(
  lineId: number,
  subMap: Map<number, Map<number, LineStop[]>>,
): { sublinea: number; sortedRutas: SortedRutaEntry[] } | null {
  interface SublineaCandidate {
    sublinea: number;
    sortedRutas: SortedRutaEntry[];
    hasBothDirections: boolean;
    totalStops: number;
    isCanonical: boolean;
  }

  const candidates: SublineaCandidate[] = [];
  for (const [sublinea, rutaMap] of subMap.entries()) {
    const sortedRutas = buildSortedRutas(rutaMap);
    if (sortedRutas.length === 0) {
      continue;
    }
    const bestOdd = selectBestRutaForParity(sortedRutas, true);
    const bestEven = selectBestRutaForParity(sortedRutas, false);
    const hasBothDirections = Boolean(bestOdd && bestEven);
    const totalStops = (bestOdd?.stops.length ?? 0) + (bestEven?.stops.length ?? 0);
    const isCanonical = sublinea === lineId * 100 + 10 || sublinea % 100 === 10;
    candidates.push({
      sublinea,
      sortedRutas,
      hasBothDirections,
      totalStops,
      isCanonical,
    });
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    if (a.hasBothDirections !== b.hasBothDirections) {
      return a.hasBothDirections ? -1 : 1;
    }
    if (a.totalStops !== b.totalStops) {
      return b.totalStops - a.totalStops;
    }
    if (a.isCanonical !== b.isCanonical) {
      return a.isCanonical ? -1 : 1;
    }
    return a.sublinea - b.sublinea;
  });

  const best = candidates[0]!;
  return { sublinea: best.sublinea, sortedRutas: best.sortedRutas };
}

export async function fetchArcGisTopology(
  options: ArcGisTopologyOptions = {},
): Promise<NetworkTopology> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 20_000);

  const linesPayload = await fetchArcGisJson<ArcGisLineAttributes>(
    ARCGIS_LINES_URL,
    fetchImpl,
    timeoutMs,
  );
  options.onProgress?.(1, 3, 'ArcGIS lines');

  const rawLineRows = (linesPayload.features ?? [])
    .map((f) => f.attributes)
    .filter((a): a is ArcGisLineAttributes => Boolean(a));

  if (rawLineRows.length === 0) {
    throw new TussamApiError('ArcGIS TUSSAM_Lineas returned no features');
  }

  const maxLinePkg = getMaxPackage(rawLineRows);
  const lineRows =
    maxLinePkg !== null
      ? rawLineRows.filter((r) => r.Package === undefined || r.Package === maxLinePkg)
      : rawLineRows;

  interface RawStopFeature {
    attrs: ArcGisStopAttributes;
    lat: number | null;
    lon: number | null;
  }

  const rawStopFeatures: RawStopFeature[] = [];
  let offset = 0;
  let pageNum = 0;

  while (true) {
    pageNum += 1;
    const stopUrl =
      `${ARCGIS_PARADAS_BASE_URL}?where=1%3D1` +
      `&outFields=Linea,LabelLinea,Sublinea,Ruta,Nodo,Nombre,Distancia,Package` +
      `&returnGeometry=true&outSR=4326&orderByFields=ObjectId` +
      `&resultRecordCount=${PAGE_SIZE}&resultOffset=${offset}&f=json`;

    const stopPayload = await fetchArcGisJson<ArcGisStopAttributes>(stopUrl, fetchImpl, timeoutMs);
    options.onProgress?.(Math.min(3, 1 + pageNum), 3, `ArcGIS stops page ${pageNum}`);

    const features = stopPayload.features ?? [];
    for (const feature of features) {
      if (!feature.attributes) {
        continue;
      }
      const x = feature.geometry?.x;
      const y = feature.geometry?.y;
      const validCoords =
        typeof x === 'number' &&
        typeof y === 'number' &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x !== 0 &&
        y !== 0;
      rawStopFeatures.push({
        attrs: feature.attributes,
        lat: validCoords ? y : null,
        lon: validCoords ? x : null,
      });
    }

    if (!stopPayload.exceededTransferLimit || features.length === 0) {
      break;
    }
    offset += features.length;
  }

  if (rawStopFeatures.length === 0) {
    throw new TussamApiError('ArcGIS TUSSAM_Paradas returned no features');
  }

  const maxStopPkg = getMaxPackage(rawStopFeatures.map((s) => s.attrs));
  const stopFeatures =
    maxStopPkg !== null
      ? rawStopFeatures.filter(
          (s) => s.attrs.Package === undefined || s.attrs.Package === maxStopPkg,
        )
      : rawStopFeatures;

  const stopsRecord: Record<string, Stop> = {};
  const lineMetaById = new Map<number, ArcGisLineAttributes[]>();
  for (const row of lineRows) {
    if (typeof row.Linea !== 'number') {
      continue;
    }
    const list = lineMetaById.get(row.Linea) ?? [];
    list.push(row);
    lineMetaById.set(row.Linea, list);
  }

  // Group stop features by Linea -> Sublinea -> Ruta, while accumulating global stop index.
  const stopsByLineSubRuta = new Map<number, Map<number, Map<number, LineStop[]>>>();

  for (const feat of stopFeatures) {
    const a = feat.attrs;
    if (
      typeof a.Linea !== 'number' ||
      typeof a.Ruta !== 'number' ||
      a.Nodo === undefined ||
      a.Nodo === null
    ) {
      continue;
    }

    const code = String(a.Nodo);
    const label = String(a.LabelLinea ?? '').trim();
    const { name, icons } = cleanArcGisStopName(a.Nombre ?? '');
    const sublinea = typeof a.Sublinea === 'number' ? a.Sublinea : a.Linea * 10;

    const lineMetaList = lineMetaById.get(a.Linea) ?? [];
    const color = lineMetaList[0]?.Color ?? '#000000';
    const lineRef: StopLineRef = { lineId: a.Linea, label, color };

    const existingStop = stopsRecord[code];
    if (!existingStop) {
      stopsRecord[code] = {
        code,
        name,
        lat: feat.lat,
        lon: feat.lon,
        lines: label ? [lineRef] : [],
        ...(icons.length > 0 ? { icons: [...icons] } : {}),
      };
    } else {
      if (!existingStop.name && name) {
        existingStop.name = name;
      }
      if (
        (existingStop.lat === null || existingStop.lon === null) &&
        feat.lat !== null &&
        feat.lon !== null
      ) {
        existingStop.lat = feat.lat;
        existingStop.lon = feat.lon;
      }
      if (label && !existingStop.lines.some((l) => l.lineId === a.Linea)) {
        existingStop.lines.push(lineRef);
      }
      if (icons.length > 0) {
        existingStop.icons = Array.from(new Set([...(existingStop.icons ?? []), ...icons]));
      }
    }

    let subMap = stopsByLineSubRuta.get(a.Linea);
    if (!subMap) {
      subMap = new Map();
      stopsByLineSubRuta.set(a.Linea, subMap);
    }
    let rutaMap = subMap.get(sublinea);
    if (!rutaMap) {
      rutaMap = new Map();
      subMap.set(sublinea, rutaMap);
    }
    let list = rutaMap.get(a.Ruta);
    if (!list) {
      list = [];
      rutaMap.set(a.Ruta, list);
    }
    list.push({
      code,
      name,
      lat: feat.lat,
      lon: feat.lon,
      distanceMeters: typeof a.Distancia === 'number' ? a.Distancia : 0,
      startTime: null,
      endTime: null,
      icons,
    });
  }

  for (const stop of Object.values(stopsRecord)) {
    stop.lines.sort((a, b) => a.label.localeCompare(b.label));
  }

  const linesRecord: Record<string, Line> = {};
  const lineStopsRecord: Record<string, LineStop[]> = {};

  for (const [lineId, subMap] of stopsByLineSubRuta.entries()) {
    const primary = selectPrimarySublinea(lineId, subMap);
    if (!primary) {
      continue;
    }
    const { sublinea: primarySublinea, sortedRutas } = primary;

    const lineMetas = (lineMetaById.get(lineId) ?? []).filter(
      (m) => m.Sublinea === undefined || m.Sublinea === primarySublinea,
    );
    const metaAny = lineMetas[0] ?? lineMetaById.get(lineId)?.[0];
    const label = String(metaAny?.LabelLinea ?? '').trim();
    const description = cleanArcGisLineDescription(metaAny?.NombreLinea ?? '');
    const color = metaAny?.Color ?? '#000000';

    const oddHalf = selectBestRutaForParity(sortedRutas, true);
    const evenHalf = selectBestRutaForParity(sortedRutas, false);
    const singleLoopRuta =
      sortedRutas.length === 1 &&
      sortedRutas[0]!.stops.length >= 4 &&
      sortedRutas[0]!.stops[0]!.code ===
        sortedRutas[0]!.stops[sortedRutas[0]!.stops.length - 1]!.code;
    const isCircular = /^C\d/i.test(label) || /\bcircular\b/i.test(description) || singleLoopRuta;

    if (isCircular) {
      let loopStops: LineStop[];
      if (oddHalf && evenHalf) {
        const lastOddStop = oddHalf.stops[oddHalf.stops.length - 1]!;
        const firstEvenStop = evenHalf.stops[0]!;
        const sharesHandover = firstEvenStop.code === lastOddStop.code;
        const sharesOrigin =
          evenHalf.stops[evenHalf.stops.length - 1]!.code === oddHalf.stops[0]!.code;

        const secondTrimmed = evenHalf.stops.slice(
          sharesHandover ? 1 : 0,
          sharesOrigin ? -1 : undefined,
        );

        let handoverOffset = lastOddStop.distanceMeters;
        if (!sharesHandover && secondTrimmed.length > 0) {
          let gapMeters = 150;
          if (
            lastOddStop.lat !== null &&
            lastOddStop.lon !== null &&
            firstEvenStop.lat !== null &&
            firstEvenStop.lon !== null
          ) {
            const computed = Math.round(
              haversineMeters(
                lastOddStop.lat,
                lastOddStop.lon,
                firstEvenStop.lat,
                firstEvenStop.lon,
              ),
            );
            if (Number.isFinite(computed) && computed > 0) {
              gapMeters = computed;
            }
          }
          handoverOffset = lastOddStop.distanceMeters + gapMeters - firstEvenStop.distanceMeters;
        }

        loopStops = [
          ...oddHalf.stops,
          ...secondTrimmed.map((s) => ({
            ...s,
            distanceMeters: Math.max(
              lastOddStop.distanceMeters + 1,
              handoverOffset + s.distanceMeters,
            ),
          })),
        ];
      } else {
        const single = sortedRutas[0]!.stops;
        loopStops =
          single.length >= 2 && single[single.length - 1]!.code === single[0]!.code
            ? single.slice(0, -1)
            : single;
      }

      lineStopsRecord[`${lineId}:99`] = loopStops;
      linesRecord[String(lineId)] = {
        id: lineId,
        label,
        subline: primarySublinea,
        description,
        color,
        isCircular: true,
        directions: [
          {
            direction: 99,
            destination: 'CIRCULAR',
            startTime: '',
            endTime: '',
          },
        ],
      };
    } else {
      const directions: LineDirectionInfo[] = [];
      const selectedDirs = [oddHalf, evenHalf].filter((entry): entry is SortedRutaEntry =>
        Boolean(entry),
      );
      for (const { ruta, stops } of selectedDirs) {
        const direction = ruta % 2 === 1 ? 1 : 2;
        if (lineStopsRecord[`${lineId}:${direction}`]) {
          continue;
        }
        lineStopsRecord[`${lineId}:${direction}`] = stops;

        const dirMeta = lineMetas.find((m) => m.Ruta === ruta);
        const dest = cleanArcGisDestination(dirMeta?.DestinoRuta || dirMeta?.NombreRuta || '');
        directions.push({
          direction,
          destination: dest,
          startTime: '',
          endTime: '',
        });
      }

      directions.sort((a, b) => a.direction - b.direction);
      linesRecord[String(lineId)] = {
        id: lineId,
        label,
        subline: primarySublinea,
        description,
        color,
        isCircular: false,
        directions,
      };
    }
  }

  return {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    includesNight: true,
    lines: linesRecord,
    stops: stopsRecord,
    lineStops: lineStopsRecord,
  };
}
