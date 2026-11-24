import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CACHE_DIR_ENV_VAR, getCacheDir } from '../../src/cache/paths.js';
import { CacheStore } from '../../src/cache/store.js';
import type { NetworkTopology, StopArrivalsResult } from '../../src/types.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tussam-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env[CACHE_DIR_ENV_VAR];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function makeTopology(syncedAt: string, linesCount = 10, stopsCount = 20): NetworkTopology {
  const lines: NetworkTopology['lines'] = {};
  const stops: NetworkTopology['stops'] = {};
  for (let i = 1; i <= linesCount; i++) {
    lines[String(i)] = {
      id: i,
      label: String(i).padStart(2, '0'),
      subline: null,
      description: `Line ${i}`,
      color: '#000000',
      isCircular: false,
      directions: [],
    };
  }
  for (let i = 1; i <= stopsCount; i++) {
    stops[String(i)] = {
      code: String(i),
      name: `Stop ${i}`,
      lat: 37.38,
      lon: -5.98,
      lines: [],
    };
  }
  return {
    schemaVersion: 1,
    syncedAt,
    includesNight: false,
    lines,
    stops,
    lineStops: {},
  };
}

describe('CacheStore & cache paths', () => {
  it('honors TUSSAM_CLI_CACHE_DIR environment variable', () => {
    process.env[CACHE_DIR_ENV_VAR] = './custom-cache-dir';
    expect(getCacheDir()).toBe(path.resolve('./custom-cache-dir'));
  });

  it('enforces TTLs and stale arrivals fallback deterministically', async () => {
    const dir = await makeTempDir();
    let now = Date.parse('2026-11-24T12:00:00.000Z');
    const store = new CacheStore({ cacheDir: dir, nowFn: () => now });

    const sampleArrivals: StopArrivalsResult = {
      stopCode: '43',
      stopName: 'Recaredo',
      lat: 37.3896,
      lon: -5.9842,
      fetchedAt: new Date(now).toISOString(),
      stale: false,
      arrivals: [],
    };

    await store.saveArrivals('43', sampleArrivals);
    expect((await store.getArrivals('43'))?.stale).toBe(false);

    // Advance 20 seconds -> fresh cache (15s) expired, stale fallback (5m) valid
    now += 20_000;
    expect(await store.getArrivals('43')).toBeNull();
    expect((await store.getStaleArrivals('43'))?.stale).toBe(true);

    // Advance 6 minutes -> stale cache also expired
    now += 6 * 60_000;
    expect(await store.getStaleArrivals('43')).toBeNull();
  });

  it('protects against incomplete topology overwrites below 80% threshold', async () => {
    const dir = await makeTempDir();
    const nowIso = '2026-11-24T12:00:00.000Z';
    const store = new CacheStore({ cacheDir: dir, nowFn: () => Date.parse(nowIso) });

    await store.saveNetworkTopology(makeTopology(nowIso, 50, 100));

    // Only 10 lines (< 80% of 50) should be rejected unless force: true
    await expect(store.saveNetworkTopology(makeTopology(nowIso, 10, 100))).rejects.toThrow(
      /Incomplete topology sync rejected/,
    );

    // Force bypasses completeness guard
    await store.saveNetworkTopology(makeTopology(nowIso, 10, 100), { force: true });
    const loaded = await store.getNetworkTopology();
    expect(Object.keys(loaded?.lines ?? {})).toHaveLength(10);
  });

  it('reports cache status and clears directory cleanly', async () => {
    const dir = await makeTempDir();
    const nowIso = '2026-11-24T12:00:00.000Z';
    const store = new CacheStore({ cacheDir: dir, nowFn: () => Date.parse(nowIso) });

    await store.saveStopIndex([
      { code: '43', name: 'Recaredo', lat: 37.38, lon: -5.98, lines: [] },
    ]);
    await store.saveSchedule('2026-11-24', 1, '43', ['08:00:00', '08:15:00']);

    const status = await store.getStatus();
    expect(status.stopIndex.present).toBe(true);
    expect(status.stopIndex.count).toBe(1);
    expect(status.schedulesCount).toBe(1);
    expect(status.totalBytes).toBeGreaterThan(0);

    await store.clear();
    const afterClear = await store.getStatus();
    expect(afterClear.stopIndex.present).toBe(false);
    expect(afterClear.totalBytes).toBe(0);
  });
});
