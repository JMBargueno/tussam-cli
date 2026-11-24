import { TussamClient, type TussamClientOptions } from './api/client.js';
import { TussamApiError, TussamValidationError } from './api/errors.js';
import { CacheStore } from './cache/store.js';
import { syncNetworkTopology } from './cache/sync.js';
import { routeWithHydrationDetailed } from './routing/router.js';
import type {
  CacheStatus,
  Line,
  LineDirectionInfo,
  LineStop,
  NearbyStop,
  NetworkTopology,
  RouteSearchOptions,
  RouteSearchResult,
  ServiceAlert,
  Stop,
  StopArrivalsResult,
  SyncProgressCallback,
} from './types.js';
import { boundingBox, haversineMeters } from './utils/geo.js';
import { normalizeSearchText } from './utils/text.js';
import { formatDateKey, withLocalTime } from './utils/time.js';

export interface TussamOptions {
  cacheDir?: string;
  client?: TussamClient;
  cache?: CacheStore;
  clientOptions?: TussamClientOptions;
}

export interface LineRoute {
  line: Line;
  directions: Array<{
    info: LineDirectionInfo;
    stops: LineStop[];
  }>;
}

export function normalizeLineQuery(label: string): string[] {
  const cleaned = label.trim().toUpperCase();
  if (!cleaned) {
    return [];
  }
  const candidates = [cleaned];
  if (/^\d$/.test(cleaned)) {
    candidates.push(`0${cleaned}`);
  } else if (/^0\d$/.test(cleaned)) {
    candidates.push(cleaned.slice(1));
  }
  return candidates;
}

export function findMatchingLine(lines: readonly Line[], query: string): Line | undefined {
  const candidates = normalizeLineQuery(query);
  for (const cand of candidates) {
    const found = lines.find((line) => line.label.toUpperCase() === cand);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function isNightLineLabel(label: string): boolean {
  return /^A\d/i.test(label.trim());
}

export class Tussam {
  readonly client: TussamClient;
  readonly cache: CacheStore;

  constructor(options: TussamOptions = {}) {
    this.client = options.client ?? new TussamClient(options.clientOptions);
    this.cache = options.cache ?? new CacheStore(options.cacheDir);
  }

  private async ensureTopology(
    options: { refresh?: boolean; onProgress?: SyncProgressCallback } = {},
  ): Promise<NetworkTopology> {
    if (!options.refresh) {
      const cached = await this.cache.getNetworkTopology(false);
      if (cached) {
        return cached;
      }
    }
    return syncNetworkTopology(this.client, this.cache, {
      force: options.refresh,
      onProgress: options.onProgress,
    });
  }

  async getAllStops(options: { refresh?: boolean } = {}): Promise<Stop[]> {
    if (!options.refresh) {
      const cached = await this.cache.getStopIndex();
      if (cached) {
        return cached;
      }
    }

    try {
      const topology = await this.ensureTopology({ refresh: options.refresh });
      return Object.values(topology.stops).sort(
        (a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
      );
    } catch {
      const stops = await this.client.fetchStopIndexFromHtml();
      await this.cache.saveStopIndex(stops);
      return stops;
    }
  }

  async matchStops(query: string, options: { refresh?: boolean } = {}): Promise<Stop[]> {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const allStops = await this.getAllStops(options);

    if (/^\d+$/.test(trimmed)) {
      const exactCode = allStops.find((stop) => stop.code === trimmed);
      if (exactCode) {
        return [exactCode];
      }
    }

    const normalizedQuery = normalizeSearchText(trimmed);
    const matches = allStops.filter((stop) => {
      if (stop.code === trimmed) {
        return true;
      }
      return normalizeSearchText(stop.name).includes(normalizedQuery);
    });

    return matches.sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  }

  async getStopArrivals(
    stopCode: string,
    options: { noCache?: boolean } = {},
  ): Promise<StopArrivalsResult> {
    if (!options.noCache) {
      const fresh = await this.cache.getArrivals(stopCode);
      if (fresh) {
        return fresh;
      }
    }

    try {
      const live = await this.client.fetchStopArrivals(stopCode);
      if (!options.noCache) {
        await this.cache.saveArrivals(stopCode, live);
      }
      return live;
    } catch (err) {
      if (!options.noCache) {
        const stale = await this.cache.getStaleArrivals(stopCode);
        if (stale) {
          return stale;
        }
      }
      throw err;
    }
  }

  async getStopSchedule(
    stopCode: string,
    lineLabel: string,
    date: Date = new Date(),
  ): Promise<string[]> {
    const lines = await this.getLines(date, { all: true });
    const line = findMatchingLine(lines, lineLabel);
    if (!line) {
      throw new TussamValidationError(`Unknown TUSSAM line '${lineLabel}'.`);
    }

    const dateKey = formatDateKey(date);
    const cached = await this.cache.getSchedule(dateKey, line.id, stopCode);
    if (cached) {
      return cached;
    }

    const queryDateTime = withLocalTime(
      date,
      isNightLineLabel(line.label) ? 1 : 12,
      isNightLineLabel(line.label) ? 30 : 0,
      0,
    );
    const times = await this.client.fetchStopSchedule(stopCode, line.id, queryDateTime);
    await this.cache.saveSchedule(dateKey, line.id, stopCode, times);
    return times;
  }

  async getLines(
    date: Date = new Date(),
    options: { night?: boolean; all?: boolean } = {},
  ): Promise<Line[]> {
    try {
      if (options.all) {
        const [dayLines, nightLines] = await Promise.all([
          this.client.fetchLines(withLocalTime(date, 12, 0, 0)),
          this.client.fetchLines(withLocalTime(date, 1, 30, 0)),
        ]);
        const merged = new Map<number, Line>();
        for (const line of [...dayLines, ...nightLines]) {
          if (!merged.has(line.id)) {
            merged.set(line.id, line);
          }
        }
        return Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
      }

      if (options.night) {
        const lines = await this.client.fetchLines(withLocalTime(date, 1, 30, 0));
        return lines.sort((a, b) => a.label.localeCompare(b.label));
      }

      const lines = await this.client.fetchLines(date);
      return lines.sort((a, b) => a.label.localeCompare(b.label));
    } catch (err) {
      if (err instanceof TussamApiError && err.statusCode === 429) {
        const topology = await this.ensureTopology();
        const allLines = Object.values(topology.lines);
        const filtered = options.all
          ? allLines
          : options.night
            ? allLines.filter((l) => isNightLineLabel(l.label))
            : allLines.filter((l) => !isNightLineLabel(l.label));
        return filtered.sort((a, b) => a.label.localeCompare(b.label));
      }
      throw err;
    }
  }

  async getLineRoute(lineLabel: string, date: Date = new Date()): Promise<LineRoute> {
    const lines = await this.getLines(date, { all: true });
    const line = findMatchingLine(lines, lineLabel);
    if (!line) {
      throw new TussamValidationError(`Unknown TUSSAM line '${lineLabel}'.`);
    }

    const queryDateTime = withLocalTime(
      date,
      isNightLineLabel(line.label) ? 1 : 12,
      isNightLineLabel(line.label) ? 30 : 0,
      0,
    );
    const directions: LineRoute['directions'] = [];

    try {
      for (const info of line.directions) {
        const stops = await this.client.fetchLineStops(line.id, info.direction, queryDateTime);
        directions.push({ info, stops });
      }
      return { line, directions };
    } catch (err) {
      if (err instanceof TussamApiError && err.statusCode === 429) {
        const topology = await this.ensureTopology();
        const topoLine = topology.lines[String(line.id)] ?? line;
        const fallbackDirs: LineRoute['directions'] = [];
        for (const info of topoLine.directions) {
          const stops = topology.lineStops[`${topoLine.id}:${info.direction}`] ?? [];
          fallbackDirs.push({ info, stops });
        }
        return { line: topoLine, directions: fallbackDirs };
      }
      throw err;
    }
  }

  async getNearbyStops(
    lat: number,
    lon: number,
    options: { radius?: number; limit?: number; date?: Date; withArrivals?: boolean } = {},
  ): Promise<NearbyStop[]> {
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      throw new TussamValidationError(`Invalid latitude '${lat}'. Expected a number in [-90, 90].`);
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      throw new TussamValidationError(
        `Invalid longitude '${lon}'. Expected a number in [-180, 180].`,
      );
    }

    const radius = Math.max(0, options.radius ?? 500);
    const limit = Math.max(1, options.limit ?? 10);
    const allStops = await this.getAllStops();
    const box = boundingBox(lat, lon, radius * 1.1);

    const nearby: NearbyStop[] = [];
    for (const stop of allStops) {
      if (stop.lat === null || stop.lon === null) {
        continue;
      }
      if (
        stop.lat < box.latMin ||
        stop.lat > box.latMax ||
        stop.lon < box.lonMin ||
        stop.lon > box.lonMax
      ) {
        continue;
      }

      const distanceMeters = Math.round(haversineMeters(lat, lon, stop.lat, stop.lon));
      if (distanceMeters <= radius) {
        nearby.push({
          code: stop.code,
          name: stop.name,
          lat: stop.lat,
          lon: stop.lon,
          distanceMeters,
          lines: stop.lines,
        });
      }
    }

    nearby.sort((a, b) => a.distanceMeters - b.distanceMeters || a.code.localeCompare(b.code));
    const filtered = nearby.slice(0, limit);

    if (options.withArrivals && filtered.length > 0) {
      const topStops = filtered.slice(0, 3);
      for (const stop of topStops) {
        try {
          stop.arrivals = await this.getStopArrivals(stop.code);
        } catch {
          // Leave arrivals undefined on individual failure
        }
      }
    }

    return filtered;
  }

  async getActiveAlerts(lineLabel?: string): Promise<ServiceAlert[]> {
    const alerts = await this.client.fetchActiveAlerts();
    if (!lineLabel) {
      return alerts;
    }

    const candidates = new Set(normalizeLineQuery(lineLabel));
    return alerts.filter((alert) =>
      alert.lines.some((line) => candidates.has(line.trim().toUpperCase())),
    );
  }

  async findSchedules(
    options: RouteSearchOptions & { onSyncProgress?: SyncProgressCallback },
  ): Promise<RouteSearchResult & { topologySynced: boolean }> {
    let topology = options.refresh
      ? null
      : await this.cache.getNetworkTopology(Boolean(options.includeNight));
    let topologySynced = false;

    if (!topology) {
      topology = await syncNetworkTopology(this.client, this.cache, {
        date: options.date,
        includeNight: options.includeNight,
        force: options.refresh,
        onProgress: options.onSyncProgress,
      });
      topologySynced = true;
    }

    const result = await routeWithHydrationDetailed(this.client, this.cache, topology, options);
    return { ...result, topologySynced };
  }

  async syncCache(
    options: {
      date?: Date;
      includeNight?: boolean;
      force?: boolean;
      onProgress?: SyncProgressCallback;
    } = {},
  ): Promise<NetworkTopology> {
    return syncNetworkTopology(this.client, this.cache, options);
  }

  async getCacheStatus(): Promise<CacheStatus> {
    return this.cache.getStatus();
  }

  async clearCache(): Promise<void> {
    return this.cache.clear();
  }
}
