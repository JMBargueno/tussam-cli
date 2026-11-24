export {
  ARCGIS_LINES_URL,
  ARCGIS_PARADAS_BASE_URL,
  cleanArcGisDestination,
  cleanArcGisLineDescription,
  cleanArcGisStopName,
  fetchArcGisTopology,
} from './api/arcgis.js';
export type { ArcGisTopologyOptions } from './api/arcgis.js';
export {
  DEFAULT_BASE_URL,
  TussamClient,
  extractArrayParadasJson,
  parseRetryAfterMs,
} from './api/client.js';
export type { TussamClientOptions } from './api/client.js';
export { TussamApiError, TussamError, TussamValidationError } from './api/errors.js';
export { CACHE_DIR_ENV_VAR, getCacheDir } from './cache/paths.js';
export { CacheStore } from './cache/store.js';
export type { CacheStoreOptions } from './cache/store.js';
export { syncNetworkTopology } from './cache/sync.js';
export type { SyncTopologyOptions } from './cache/sync.js';
export { SUPPORTED_SHELLS, generateCompletionScript } from './cli/completions.js';
export type { CompletionShell } from './cli/completions.js';
export { FavoritesStore, normalizeFavoriteAlias } from './config/favorites.js';
export type { FavoritesStoreOptions } from './config/favorites.js';
export { CONFIG_DIR_ENV_VAR, getConfigDir } from './config/paths.js';
export { colorizeLineLabel, detectColorLevel, stripAnsi } from './format/colors.js';
export type { ColorLevel } from './format/colors.js';
export { findAlternativeWalkSuggestion, findCandidateCorridors } from './routing/corridors.js';
export type {
  CandidateCorridor,
  CorridorAccessWalk,
  CorridorLeg,
  CorridorSearchOptions,
  CorridorTransfer,
} from './routing/corridors.js';
export {
  buildEstimatedJourneysFromCorridors,
  findJourneysFromCorridors,
  removeDominated,
  routeWithHydration,
  routeWithHydrationDetailed,
} from './routing/router.js';
export type { ScheduleLookup } from './routing/router.js';
export { estimateLegDurationSeconds, pairLegDepartures } from './routing/scheduleMatcher.js';
export type { PairedDeparture } from './routing/scheduleMatcher.js';
export {
  DEFAULT_DEST_WALK_METERS,
  DEFAULT_ORIGIN_WALK_METERS,
  buildWalkTransferMap,
  estimateAccessWalkSeconds,
  findNearbyAccessWalks,
} from './routing/transfers.js';
export type { NearbyAccessWalk } from './routing/transfers.js';
export { Tussam, findMatchingLine, normalizeLineQuery } from './tussam.js';
export type { LineRoute, TussamOptions } from './tussam.js';
export type * from './types.js';
