const EARTH_RADIUS_METERS = 6_371_000;
const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_LAT_DEGREE = 111_320;

/**
 * Computes exact great-circle distance between two WGS84 points in meters.
 */
export function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const lat1Rad = lat1 * DEG_TO_RAD;
  const lat2Rad = lat2 * DEG_TO_RAD;

  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const a =
    sinHalfLat * sinHalfLat + Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfLon * sinHalfLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Computes a fast lat/lon bounding box for spatial pre-filtering before Haversine.
 */
export function boundingBox(
  lat: number,
  lon: number,
  radiusMeters: number,
): { latMin: number; latMax: number; lonMin: number; lonMax: number } {
  const latDelta = radiusMeters / METERS_PER_LAT_DEGREE;
  const cosLat = Math.max(0.01, Math.cos(lat * DEG_TO_RAD));
  const lonDelta = radiusMeters / (METERS_PER_LAT_DEGREE * cosLat);

  return {
    latMin: lat - latDelta,
    latMax: lat + latDelta,
    lonMin: lon - lonDelta,
    lonMax: lon + lonDelta,
  };
}

/**
 * Converts TUSSAM `E6` integer coordinates (`* 1e6`) to decimal degrees.
 * Returns null coordinates when missing or zero to avoid Gulf-of-Guinea artifacts.
 */
export function coordsFromE6(
  latE6?: number | null,
  lonE6?: number | null,
): { lat: number | null; lon: number | null } {
  if (
    typeof latE6 !== 'number' ||
    typeof lonE6 !== 'number' ||
    !Number.isFinite(latE6) ||
    !Number.isFinite(lonE6) ||
    latE6 === 0 ||
    lonE6 === 0
  ) {
    return { lat: null, lon: null };
  }

  return {
    lat: latE6 / 1_000_000,
    lon: lonE6 / 1_000_000,
  };
}

/**
 * Converts decimal degrees into TUSSAM `E6` integers (`* 1e6`).
 */
export function coordsToE6(lat: number, lon: number): { latE6: number; lonE6: number } {
  return {
    latE6: Math.round(lat * 1_000_000),
    lonE6: Math.round(lon * 1_000_000),
  };
}
