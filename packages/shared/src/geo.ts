import type { LatLng } from './types.ts';

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance between two points in kilometres. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Roads are never straight. A 1.3 detour factor is a common planning
 * approximation for urban trips and is good enough for an estimate the
 * driver will then quote against.
 */
export const ROAD_DETOUR_FACTOR = 1.3;

/** Estimated driving distance in km for a trip between two points. */
export function estimateRoadKm(a: LatLng, b: LatLng): number {
  return haversineKm(a, b) * ROAD_DETOUR_FACTOR;
}

/** Estimated minutes for a trip, assuming an average urban speed. */
export function estimateMinutes(roadKm: number, avgSpeedKmh = 28): number {
  return (roadKm / avgSpeedKmh) * 60;
}

/** Minutes for a driver to reach a pickup point. */
export function estimateEtaMinutes(driver: LatLng, pickup: LatLng): number {
  return Math.max(1, Math.round(estimateMinutes(estimateRoadKm(driver, pickup), 24)));
}

/** True if `point` is within `radiusKm` of `centre`. */
export function withinKm(centre: LatLng, point: LatLng, radiusKm: number): boolean {
  return haversineKm(centre, point) <= radiusKm;
}

export function isValidLatLng(p: unknown): p is LatLng {
  if (!p || typeof p !== 'object') return false;
  const { lat, lng } = p as Record<string, unknown>;
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Compass bearing from `from` to `to`, in degrees clockwise from north. */
export function bearingDeg(from: LatLng, to: LatLng): number {
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A readable fallback label when no address is available: "1.8 km NE of centre". */
export function describeRelative(point: LatLng, centre: LatLng, centreName = 'centre'): string {
  const km = haversineKm(centre, point);
  if (km < 0.05) return centreName;
  const dir = COMPASS[Math.round(bearingDeg(centre, point) / 45) % 8];
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km ${dir} of ${centreName}`;
}
