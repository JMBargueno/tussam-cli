import type { Stop, WalkTransfer } from '../types.js';
import { boundingBox, haversineMeters } from '../utils/geo.js';

export const DEFAULT_SAME_STOP_TRANSFER_SECONDS = 120;
export const DEFAULT_WALK_SPEED_MPS = 1.2;
export const DEFAULT_MAX_WALK_METERS = 300;
export const DEFAULT_TRANSFER_PENALTY_SECONDS = 480;
export const MAX_TRANSFER_WAIT_SECONDS = 45 * 60;
export const MAX_JOURNEY_SECONDS = 4 * 3_600;

/**
 * Builds a spatial map of nearby walking transfers (`<= maxWalkMeters`) between distinct stops.
 */
export function buildWalkTransferMap(
  stops: Record<string, Stop>,
  maxWalkMeters: number = DEFAULT_MAX_WALK_METERS,
): Map<string, WalkTransfer[]> {
  const result = new Map<string, WalkTransfer[]>();
  if (maxWalkMeters <= 0) {
    return result;
  }

  const geoStops = Object.values(stops).filter(
    (s): s is Stop & { lat: number; lon: number } => s.lat !== null && s.lon !== null,
  );

  for (const fromStop of geoStops) {
    const box = boundingBox(fromStop.lat, fromStop.lon, maxWalkMeters);
    const nearby: WalkTransfer[] = [];

    for (const toStop of geoStops) {
      if (toStop.code === fromStop.code) {
        continue;
      }
      if (
        toStop.lat < box.latMin ||
        toStop.lat > box.latMax ||
        toStop.lon < box.lonMin ||
        toStop.lon > box.lonMax
      ) {
        continue;
      }

      const distanceMeters = Math.round(
        haversineMeters(fromStop.lat, fromStop.lon, toStop.lat, toStop.lon),
      );
      if (distanceMeters <= maxWalkMeters) {
        const walkSeconds = Math.ceil(distanceMeters / DEFAULT_WALK_SPEED_MPS);
        nearby.push({
          fromStopCode: fromStop.code,
          toStopCode: toStop.code,
          distanceMeters,
          durationSeconds: walkSeconds + DEFAULT_SAME_STOP_TRANSFER_SECONDS,
        });
      }
    }

    if (nearby.length > 0) {
      nearby.sort((a, b) => a.distanceMeters - b.distanceMeters || a.toStopCode.localeCompare(b.toStopCode));
      result.set(fromStop.code, nearby);
    }
  }

  return result;
}
