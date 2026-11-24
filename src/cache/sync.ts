import { fetchArcGisTopology } from '../api/arcgis.js';
import type { TussamClient } from '../api/client.js';
import type { NetworkTopology, Stop, SyncProgressCallback } from '../types.js';
import type { CacheStore } from './store.js';

export interface SyncTopologyOptions {
  date?: Date;
  includeNight?: boolean;
  requestDelayMs?: number;
  force?: boolean;
  onProgress?: SyncProgressCallback;
}

/**
 * Syncs full network topology (all day+night lines and ordered stops) from Seville's public
 * ArcGIS TUSSAM layers in 3 requests without stressing `reddelineas.tussam.es`.
 */
export async function syncNetworkTopology(
  client: TussamClient,
  cache: CacheStore,
  options: SyncTopologyOptions = {},
): Promise<NetworkTopology> {
  const topology = await fetchArcGisTopology({
    fetchImpl: client.fetchImpl,
    onProgress: options.onProgress,
  });

  await cache.saveNetworkTopology(topology, { force: options.force });

  const sortedStops: Stop[] = Object.values(topology.stops).sort(
    (a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
  );
  await cache.saveStopIndex(sortedStops);

  return topology;
}
