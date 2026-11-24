import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TussamApiError } from '../api/errors.js';
import type { CacheStatus, NetworkTopology, Stop, StopArrivalsResult } from '../types.js';
import { getCacheDir } from './paths.js';

export const STOP_INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const TOPOLOGY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const SCHEDULE_TTL_MS = 24 * 60 * 60 * 1_000;
export const ARRIVALS_FRESH_TTL_MS = 15 * 1_000;
export const ARRIVALS_STALE_TTL_MS = 5 * 60 * 1_000;
export const COMPLETENESS_RATIO = 0.8;

interface CachedEnvelope<T> {
  updatedAt: string;
  data: T;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface CacheStoreOptions {
  cacheDir?: string;
  nowFn?: () => number;
}

export class CacheStore {
  readonly cacheDir: string;
  private readonly nowFn: () => number;

  constructor(options: CacheStoreOptions | string = {}) {
    if (typeof options === 'string') {
      this.cacheDir = path.resolve(options);
      this.nowFn = Date.now;
    } else {
      this.cacheDir = path.resolve(options.cacheDir ?? getCacheDir());
      this.nowFn = options.nowFn ?? Date.now;
    }
  }

  private get stopIndexPath(): string {
    return path.join(this.cacheDir, 'stops-index.json');
  }

  private get topologyPath(): string {
    return path.join(this.cacheDir, 'network-topology.json');
  }

  private schedulePath(dateKey: string, lineId: number, stopCode: string): string {
    return path.join(
      this.cacheDir,
      'schedules',
      sanitizeSegment(dateKey),
      `${lineId}-${sanitizeSegment(stopCode)}.json`,
    );
  }

  private arrivalsPath(stopCode: string): string {
    return path.join(this.cacheDir, 'arrivals', `${sanitizeSegment(stopCode)}.json`);
  }

  private async writeJsonAtomic(filePath: string, payload: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf8');
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async readJson<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private isWithinTtl(isoTimestamp: string | undefined, ttlMs: number): boolean {
    if (!isoTimestamp) {
      return false;
    }
    const ts = Date.parse(isoTimestamp);
    if (!Number.isFinite(ts)) {
      return false;
    }
    const age = this.nowFn() - ts;
    return age >= 0 && age <= ttlMs;
  }

  async getStopIndex(): Promise<Stop[] | null> {
    const envelope = await this.readJson<CachedEnvelope<Stop[]>>(this.stopIndexPath);
    if (!envelope || !Array.isArray(envelope.data)) {
      return null;
    }
    if (!this.isWithinTtl(envelope.updatedAt, STOP_INDEX_TTL_MS)) {
      return null;
    }
    return envelope.data;
  }

  async saveStopIndex(stops: Stop[]): Promise<void> {
    const envelope: CachedEnvelope<Stop[]> = {
      updatedAt: new Date(this.nowFn()).toISOString(),
      data: stops,
    };
    await this.writeJsonAtomic(this.stopIndexPath, envelope);
  }

  async getNetworkTopology(requireNight = false): Promise<NetworkTopology | null> {
    const topology = await this.readJson<NetworkTopology>(this.topologyPath);
    if (topology?.schemaVersion !== 1) {
      return null;
    }
    if (!this.isWithinTtl(topology.syncedAt, TOPOLOGY_TTL_MS)) {
      return null;
    }
    if (requireNight && !topology.includesNight) {
      return null;
    }
    return topology;
  }

  async saveNetworkTopology(
    topology: NetworkTopology,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (!options.force) {
      const existing = await this.readJson<NetworkTopology>(this.topologyPath);
      if (existing && existing.schemaVersion === 1) {
        const existingLines = Object.keys(existing.lines).length;
        const incomingLines = Object.keys(topology.lines).length;
        if (existingLines > 0 && incomingLines < existingLines * COMPLETENESS_RATIO) {
          throw new TussamApiError(
            `Incomplete topology sync rejected: received ${incomingLines} lines vs ${existingLines} cached (minimum 80% required).`,
          );
        }

        const existingStops = Object.keys(existing.stops).length;
        const incomingStops = Object.keys(topology.stops).length;
        if (existingStops > 0 && incomingStops < existingStops * COMPLETENESS_RATIO) {
          throw new TussamApiError(
            `Incomplete topology sync rejected: received ${incomingStops} stops vs ${existingStops} cached (minimum 80% required).`,
          );
        }
      }
    }

    await this.writeJsonAtomic(this.topologyPath, topology);
  }

  async getSchedule(dateKey: string, lineId: number, stopCode: string): Promise<string[] | null> {
    const envelope = await this.readJson<CachedEnvelope<string[]>>(
      this.schedulePath(dateKey, lineId, stopCode),
    );
    if (!envelope || !Array.isArray(envelope.data)) {
      return null;
    }
    if (!this.isWithinTtl(envelope.updatedAt, SCHEDULE_TTL_MS)) {
      return null;
    }
    return envelope.data;
  }

  async saveSchedule(
    dateKey: string,
    lineId: number,
    stopCode: string,
    times: string[],
  ): Promise<void> {
    const envelope: CachedEnvelope<string[]> = {
      updatedAt: new Date(this.nowFn()).toISOString(),
      data: times,
    };
    await this.writeJsonAtomic(this.schedulePath(dateKey, lineId, stopCode), envelope);
  }

  async getArrivals(stopCode: string): Promise<StopArrivalsResult | null> {
    const envelope = await this.readJson<CachedEnvelope<StopArrivalsResult>>(
      this.arrivalsPath(stopCode),
    );
    if (!envelope?.data) {
      return null;
    }
    if (!this.isWithinTtl(envelope.updatedAt, ARRIVALS_FRESH_TTL_MS)) {
      return null;
    }
    return { ...envelope.data, stale: false };
  }

  async getStaleArrivals(stopCode: string): Promise<StopArrivalsResult | null> {
    const envelope = await this.readJson<CachedEnvelope<StopArrivalsResult>>(
      this.arrivalsPath(stopCode),
    );
    if (!envelope?.data) {
      return null;
    }
    if (!this.isWithinTtl(envelope.updatedAt, ARRIVALS_STALE_TTL_MS)) {
      return null;
    }
    return { ...envelope.data, stale: true };
  }

  async saveArrivals(stopCode: string, result: StopArrivalsResult): Promise<void> {
    const envelope: CachedEnvelope<StopArrivalsResult> = {
      updatedAt: new Date(this.nowFn()).toISOString(),
      data: { ...result, stale: false },
    };
    await this.writeJsonAtomic(this.arrivalsPath(stopCode), envelope);
  }

  private async countFilesAndBytes(dirPath: string): Promise<{ count: number; bytes: number }> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return { count: 0, bytes: 0 };
    }

    let count = 0;
    let bytes = 0;
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.countFilesAndBytes(fullPath);
        count += sub.count;
        bytes += sub.bytes;
      } else if (entry.isFile()) {
        count += 1;
        const stat = await fs.stat(fullPath).catch(() => null);
        bytes += stat?.size ?? 0;
      }
    }
    return { count, bytes };
  }

  async getStatus(): Promise<CacheStatus> {
    const stopEnvelope = await this.readJson<CachedEnvelope<Stop[]>>(this.stopIndexPath);
    const topology = await this.readJson<NetworkTopology>(this.topologyPath);
    const schedulesStats = await this.countFilesAndBytes(path.join(this.cacheDir, 'schedules'));
    const arrivalsStats = await this.countFilesAndBytes(path.join(this.cacheDir, 'arrivals'));
    const totalStats = await this.countFilesAndBytes(this.cacheDir);

    return {
      cacheDir: this.cacheDir,
      stopIndex: {
        present: Boolean(stopEnvelope && Array.isArray(stopEnvelope.data)),
        fresh: Boolean(stopEnvelope && this.isWithinTtl(stopEnvelope.updatedAt, STOP_INDEX_TTL_MS)),
        count: Array.isArray(stopEnvelope?.data) ? stopEnvelope.data.length : 0,
        updatedAt: stopEnvelope?.updatedAt ?? null,
      },
      topology: {
        present: Boolean(topology && topology.schemaVersion === 1),
        fresh: Boolean(
          topology &&
            topology.schemaVersion === 1 &&
            this.isWithinTtl(topology.syncedAt, TOPOLOGY_TTL_MS),
        ),
        includesNight: Boolean(topology?.includesNight),
        linesCount: topology ? Object.keys(topology.lines).length : 0,
        stopsCount: topology ? Object.keys(topology.stops).length : 0,
        syncedAt: topology?.syncedAt ?? null,
      },
      schedulesCount: schedulesStats.count,
      arrivalsCount: arrivalsStats.count,
      totalBytes: totalStats.bytes,
    };
  }

  async clear(): Promise<void> {
    await fs.rm(this.cacheDir, { recursive: true, force: true });
  }
}
