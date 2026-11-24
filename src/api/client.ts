import type {
  Line,
  LineDirectionInfo,
  LineStop,
  NearbyStop,
  ServiceAlert,
  Stop,
  StopArrival,
  StopArrivalsResult,
  StopLineRef,
} from '../types.js';
import { coordsFromE6, coordsToE6, haversineMeters } from '../utils/geo.js';
import { formatTussamDateTime } from '../utils/time.js';
import { TussamApiError, TussamValidationError } from './errors.js';

export const DEFAULT_BASE_URL = 'https://reddelineas.tussam.es';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

interface RawArrayParada {
  nombre?: string;
  datos?: Array<{ color?: string; numero?: number; label?: string }>;
  vLat?: number;
  vLon?: number;
}

interface RawApiEnvelope<T> {
  result?: T;
  response?: boolean;
  error?: boolean;
  message?: string;
  status?: string;
}

interface RawLineDto {
  linea?: number;
  labelLinea?: string;
  sublinea?: number;
  descripcion?: { texto?: string };
  color?: string;
  destinos?: Array<{
    sentido?: number;
    destino?: { texto?: string };
    horaInicio?: string;
    horaFin?: string;
  }>;
}

interface RawLineStopDto {
  codigo?: number | string;
  descripcion?: { texto?: string; iconos?: string[] };
  posicion?: { latitudE6?: number; longitudE6?: number };
  distancia?: number;
  horaInicio?: string;
  horaFin?: string;
}

interface RawTiemposDto {
  codigo?: number | string;
  descripcion?: { texto?: string };
  posicion?: { latitudE6?: number; longitudE6?: number };
  lineasCoincidentes?: Array<{
    lineaId?: number;
    labelLinea?: string;
    color?: string;
    estimaciones?: Array<{
      vehiculo?: number;
      destino?: { texto?: string };
      atributos?: string[];
      distancia?: number;
      segundos?: number;
    }>;
  }>;
}

interface RawNearbyDto {
  codigo?: number | string;
  descripcion?: { texto?: string };
  proximidadE6?: number;
  posicion?: { latitudE6?: number; longitudE6?: number };
  lineasCoincidentes?: Array<{
    linea?: number;
    labelLinea?: string;
    color?: string;
  }>;
}

interface RawAlertDto {
  id?: number | string;
  creacion?: string;
  caducidad?: string;
  lineas?: string[];
  contenido?: string;
  tipo?: string;
}

export interface TussamClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxConcurrency?: number;
  maxRetries?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
}

class AsyncSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts `APP.arrayParadas = {...}` from TUSSAM's web HTML using balanced-brace scanning
 * that respects string literals and escape sequences.
 */
export function extractArrayParadasJson(html: string): Record<string, RawArrayParada> {
  const markerIndex = html.indexOf('APP.arrayParadas');
  if (markerIndex === -1) {
    throw new TussamApiError('Could not find APP.arrayParadas in TUSSAM homepage HTML');
  }

  const eqIndex = html.indexOf('=', markerIndex);
  if (eqIndex === -1) {
    throw new TussamApiError('Malformed APP.arrayParadas assignment in TUSSAM homepage HTML');
  }

  const startBrace = html.indexOf('{', eqIndex);
  if (startBrace === -1) {
    throw new TussamApiError('Could not locate JSON object start for APP.arrayParadas');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endBrace = -1;

  for (let i = startBrace; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        endBrace = i;
        break;
      }
    }
  }

  if (endBrace === -1) {
    throw new TussamApiError('Unterminated APP.arrayParadas JSON object in TUSSAM HTML');
  }

  const jsonSlice = html.slice(startBrace, endBrace + 1);
  try {
    const parsed = JSON.parse(jsonSlice) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TussamApiError('Unexpected APP.arrayParadas structure in TUSSAM HTML');
    }
    return parsed as Record<string, RawArrayParada>;
  } catch (err) {
    if (err instanceof TussamApiError) {
      throw err;
    }
    throw new TussamApiError(
      `Failed to parse APP.arrayParadas JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export class TussamClient {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly semaphore: AsyncSemaphore;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly retryBaseDelayMs: number;

  constructor(options: TussamClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
    this.semaphore = new AsyncSemaphore(Math.max(1, options.maxConcurrency ?? 2));
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 20_000);
    this.retryBaseDelayMs = Math.max(1, options.retryBaseDelayMs ?? 1_000);
  }

  private buildHeaders(accept: string): Record<string, string> {
    return {
      'User-Agent': DEFAULT_USER_AGENT,
      Accept: accept,
      Referer: `${this.baseUrl}/`,
    };
  }

  private computeRetryWaitMs(response: Response, attempt: number): number {
    const retryAfter = response.headers.get('Retry-After');
    if (retryAfter) {
      const parsedSeconds = Number.parseInt(retryAfter.trim(), 10);
      if (Number.isFinite(parsedSeconds) && String(parsedSeconds) === retryAfter.trim()) {
        const clampedSeconds = Math.max(1, Math.min(60, parsedSeconds));
        return clampedSeconds * 1_000;
      }
    }
    return this.retryBaseDelayMs * 2 ** attempt;
  }

  private async requestText(url: string, accept: string): Promise<{ status: number; text: string }> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let response: Response;
      try {
        response = await this.semaphore.run(() =>
          this.fetchImpl(url, {
            method: 'GET',
            headers: this.buildHeaders(accept),
            redirect: 'error',
            signal: AbortSignal.timeout(this.timeoutMs),
          }),
        );
      } catch (err) {
        lastError = err;
        if (attempt < this.maxRetries) {
          await this.sleepImpl(this.retryBaseDelayMs * 2 ** attempt);
          continue;
        }
        throw new TussamApiError(
          `Network error requesting ${url}: ${err instanceof Error ? err.message : String(err)}`,
          undefined,
          url,
        );
      }

      if (RETRYABLE_STATUS_CODES.has(response.status)) {
        if (attempt < this.maxRetries) {
          const waitMs = this.computeRetryWaitMs(response, attempt);
          await this.sleepImpl(waitMs);
          continue;
        }
        throw new TussamApiError(
          `TUSSAM upstream returned HTTP ${response.status} after ${this.maxRetries + 1} attempts`,
          response.status,
          url,
        );
      }

      if (!response.ok) {
        throw new TussamApiError(
          `TUSSAM upstream returned HTTP ${response.status}`,
          response.status,
          url,
        );
      }

      const text = await response.text();
      return { status: response.status, text };
    }

    throw new TussamApiError(
      `Failed request to ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      undefined,
      url,
    );
  }

  private async requestJsonEnvelope<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const { status, text } = await this.requestText(url, 'application/json');
    const trimmed = text.trimStart();

    if (trimmed.startsWith('<')) {
      throw new TussamApiError(
        'TUSSAM returned an HTML/challenge response instead of JSON',
        status,
        url,
      );
    }

    let envelope: RawApiEnvelope<T>;
    try {
      envelope = JSON.parse(text) as RawApiEnvelope<T>;
    } catch (err) {
      throw new TussamApiError(
        `Invalid JSON from TUSSAM (${url}): ${err instanceof Error ? err.message : String(err)}`,
        status,
        url,
      );
    }

    if (envelope.status === 'ERROR' || envelope.error === true) {
      throw new TussamApiError(
        envelope.message?.trim() || 'TUSSAM API reported an error',
        status,
        url,
      );
    }

    return envelope.result as T;
  }

  async fetchStopIndexFromHtml(): Promise<Stop[]> {
    const url = `${this.baseUrl}/`;
    const { text } = await this.requestText(url, 'text/html');
    const rawMap = extractArrayParadasJson(text);

    const stops: Stop[] = [];
    for (const [code, entry] of Object.entries(rawMap)) {
      if (!code) {
        continue;
      }
      const coords = coordsFromE6(entry.vLat, entry.vLon);
      const seenLines = new Map<number, StopLineRef>();
      for (const lineDto of entry.datos ?? []) {
        if (typeof lineDto.numero !== 'number' || !lineDto.label) {
          continue;
        }
        if (!seenLines.has(lineDto.numero)) {
          seenLines.set(lineDto.numero, {
            lineId: lineDto.numero,
            label: String(lineDto.label),
            color: lineDto.color ?? '#000000',
          });
        }
      }

      stops.push({
        code: String(code),
        name: (entry.nombre ?? '').trim(),
        lat: coords.lat,
        lon: coords.lon,
        lines: Array.from(seenLines.values()).sort((a, b) => a.label.localeCompare(b.label)),
      });
    }

    return stops.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  }

  async fetchLines(dateTime: Date = new Date()): Promise<Line[]> {
    const fh = formatTussamDateTime(dateTime);
    const result = await this.requestJsonEnvelope<{ lineasDisponibles?: RawLineDto[] }>(
      `/API/infotus-ui/lineas/${fh}`,
    );

    const rawLines = result?.lineasDisponibles ?? [];
    const lines: Line[] = [];

    for (const raw of rawLines) {
      if (typeof raw.linea !== 'number' || !raw.labelLinea) {
        continue;
      }
      const directions: LineDirectionInfo[] = (raw.destinos ?? [])
        .filter((d) => typeof d.sentido === 'number')
        .map((d) => ({
          direction: d.sentido as number,
          destination: (d.destino?.texto ?? '').trim(),
          startTime: d.horaInicio ?? '',
          endTime: d.horaFin ?? '',
        }));

      lines.push({
        id: raw.linea,
        label: String(raw.labelLinea),
        subline: typeof raw.sublinea === 'number' ? raw.sublinea : null,
        description: (raw.descripcion?.texto ?? '').trim(),
        color: raw.color ?? '#000000',
        isCircular: directions.some((d) => d.direction === 99),
        directions,
      });
    }

    return lines;
  }

  async fetchLineStops(
    lineId: number,
    direction: number,
    dateTime: Date = new Date(),
  ): Promise<LineStop[]> {
    const fh = formatTussamDateTime(dateTime);
    const result = await this.requestJsonEnvelope<RawLineStopDto[]>(
      `/API/infotus-ui/nodosLinea/${lineId}/${direction}/${fh}`,
    );

    if (!Array.isArray(result)) {
      return [];
    }

    const stops: LineStop[] = [];
    for (const node of result) {
      if (node.codigo === undefined || node.codigo === null) {
        continue;
      }
      const coords = coordsFromE6(node.posicion?.latitudE6, node.posicion?.longitudE6);
      stops.push({
        code: String(node.codigo),
        name: (node.descripcion?.texto ?? '').trim(),
        lat: coords.lat,
        lon: coords.lon,
        distanceMeters: typeof node.distancia === 'number' ? node.distancia : 0,
        startTime: node.horaInicio && node.horaInicio !== '-' ? node.horaInicio : null,
        endTime: node.horaFin && node.horaFin !== '-' ? node.horaFin : null,
        icons: Array.isArray(node.descripcion?.iconos) ? node.descripcion.iconos : [],
      });
    }

    return stops;
  }

  async fetchStopSchedule(
    stopCode: string,
    lineId: number,
    dateTime: Date = new Date(),
  ): Promise<string[]> {
    const cleanCode = stopCode.trim();
    if (!cleanCode) {
      throw new TussamValidationError('Stop code cannot be empty');
    }

    const fh = formatTussamDateTime(dateTime);
    const result = await this.requestJsonEnvelope<{ horarios?: unknown }>(
      `/API/infotus-ui/horarios/${encodeURIComponent(cleanCode)}/${lineId}/${fh}`,
    );

    if (!result || !Array.isArray(result.horarios)) {
      return [];
    }

    return result.horarios.filter((value): value is string => typeof value === 'string');
  }

  async fetchStopArrivals(stopCode: string): Promise<StopArrivalsResult> {
    const cleanCode = stopCode.trim();
    if (!cleanCode) {
      throw new TussamValidationError('Stop code cannot be empty');
    }

    const rawResult = await this.requestJsonEnvelope<RawTiemposDto | RawTiemposDto[]>(
      `/API/infotus-ui/tiempos/${encodeURIComponent(cleanCode)}`,
    );

    let normalized: RawTiemposDto = {};
    if (Array.isArray(rawResult)) {
      if (rawResult.length > 0 && rawResult[0] && typeof rawResult[0] === 'object') {
        normalized = rawResult[0];
      }
    } else if (rawResult && typeof rawResult === 'object') {
      normalized = rawResult;
    }

    const coords = coordsFromE6(
      normalized.posicion?.latitudE6,
      normalized.posicion?.longitudE6,
    );
    const arrivals: StopArrival[] = [];

    for (const line of normalized.lineasCoincidentes ?? []) {
      const lineId = typeof line.lineaId === 'number' ? line.lineaId : 0;
      const lineLabel = String(line.labelLinea ?? '');
      const color = line.color ?? '#000000';

      for (const est of line.estimaciones ?? []) {
        if (typeof est.segundos !== 'number' || !Number.isFinite(est.segundos) || est.segundos < 0) {
          continue;
        }
        arrivals.push({
          lineId,
          lineLabel,
          color,
          destination: (est.destino?.texto ?? '').trim(),
          seconds: est.segundos,
          minutes: Math.floor(est.segundos / 60),
          distanceMeters: typeof est.distancia === 'number' ? est.distancia : null,
          vehicle: typeof est.vehiculo === 'number' ? est.vehiculo : null,
          attributes: Array.isArray(est.atributos) ? est.atributos : [],
        });
      }
    }

    arrivals.sort((a, b) => a.seconds - b.seconds || a.lineLabel.localeCompare(b.lineLabel));

    return {
      stopCode: cleanCode,
      stopName: (normalized.descripcion?.texto ?? '').trim(),
      lat: coords.lat,
      lon: coords.lon,
      fetchedAt: new Date().toISOString(),
      stale: false,
      arrivals,
    };
  }

  async fetchNearbyStops(
    lat: number,
    lon: number,
    dateTime: Date = new Date(),
  ): Promise<NearbyStop[]> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new TussamValidationError(`Invalid latitude '${lat}'. Expected a number in [-90, 90].`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new TussamValidationError(`Invalid longitude '${lon}'. Expected a number in [-180, 180].`);
    }

    const { latE6, lonE6 } = coordsToE6(lat, lon);
    const fh = formatTussamDateTime(dateTime);
    const result = await this.requestJsonEnvelope<RawNearbyDto[]>(
      `/API/infotus-ui/cercanos/${latE6}/${lonE6}/${fh}`,
    );

    if (!Array.isArray(result)) {
      return [];
    }

    const stops: NearbyStop[] = [];
    for (const item of result) {
      if (item.codigo === undefined || item.codigo === null) {
        continue;
      }
      const coords = coordsFromE6(item.posicion?.latitudE6, item.posicion?.longitudE6);
      const distanceMeters =
        coords.lat !== null && coords.lon !== null
          ? Math.round(haversineMeters(lat, lon, coords.lat, coords.lon))
          : Math.round((typeof item.proximidadE6 === 'number' ? item.proximidadE6 : 0) / 1_000_000);

      const lines: StopLineRef[] = (item.lineasCoincidentes ?? [])
        .filter((l) => typeof l.linea === 'number' && l.labelLinea)
        .map((l) => ({
          lineId: l.linea as number,
          label: String(l.labelLinea),
          color: l.color ?? '#000000',
        }));

      stops.push({
        code: String(item.codigo),
        name: (item.descripcion?.texto ?? '').trim(),
        lat: coords.lat,
        lon: coords.lon,
        distanceMeters,
        lines,
      });
    }

    return stops.sort((a, b) => a.distanceMeters - b.distanceMeters || a.code.localeCompare(b.code));
  }

  async fetchActiveAlerts(): Promise<ServiceAlert[]> {
    const result = await this.requestJsonEnvelope<
      RawAlertDto[] | { notificacionesActivas?: RawAlertDto[] }
    >('/API/infotus-ui/notificaciones/activas');

    const rawAlerts: RawAlertDto[] = Array.isArray(result)
      ? result
      : Array.isArray(result?.notificacionesActivas)
        ? result.notificacionesActivas
        : [];

    return rawAlerts.map((item, index) => ({
      id: item.id ?? index,
      createdAt: item.creacion ?? '',
      expiresAt: item.caducidad ?? '',
      lines: Array.isArray(item.lineas) ? item.lineas.map(String) : [],
      content: (item.contenido ?? '').trim(),
      type: item.tipo ?? 'Notification',
    }));
  }
}
