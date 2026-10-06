// Normalize SEPTA's TransitView feed into the vehicles the detectors can trust.
//
// TransitView mixes real GPS reports with placeholders: SEPTA fills scheduled
// trips that have no live tracking with "schedBasedVehicle" (or "None")
// entries parked at City Hall's coordinates, and keeps last-known positions
// of vehicles that stopped reporting. Neither says where a vehicle is, so
// both are dropped here. The subway lines (L1, B1–B3) only ever appear as
// placeholders — position-based detection can't cover them.
import { classifyRoute } from './network.js';

export const STALE_REPORT_MS = 5 * 60 * 1000;
// TransitView's sentinel `late` values (998/999) mean "no schedule match".
const LATE_SENTINEL = 900;

/**
 * @param {object} payload TransitViewAll response: { routes: [{ [routeId]: vehicle[] }] }
 * @param {number} now
 * @returns {{ vehicles: Array<{
 *   id: string, label: string, mode: 'bus' | 'metro', route: string, tripId: string | null,
 *   directionName: string | null, destination: string | null, lat: number, lon: number,
 *   heading: number | null, lateMin: number | null, nextStopSequence: number | null, nextStopName: string | null,
 *   reportTs: number }>, placeholders: number, stale: number }}
 */
export function normalizeTransitView(payload, now) {
  const groups = Array.isArray(payload?.routes) ? payload.routes : [];
  if (groups.length === 0) throw new Error('TransitView payload has no routes');
  const vehicles = [];
  let placeholders = 0;
  let stale = 0;
  for (const group of groups) {
    for (const [rawRoute, list] of Object.entries(group ?? {})) {
      const route = classifyRoute(rawRoute);
      if (!route || route.mode === 'regional_rail') continue;
      for (const v of Array.isArray(list) ? list : []) {
        const id = String(v.VehicleID ?? v.label ?? '');
        const lat = Number(v.lat);
        const lon = Number(v.lng ?? v.lon);
        if (!id || id === 'None' || /schedBased/i.test(id) || !Number.isFinite(lat) || !lat) {
          placeholders++;
          continue;
        }
        const reportTs = Number(v.timestamp) * 1000;
        if (!Number.isFinite(reportTs) || now - reportTs > STALE_REPORT_MS) {
          stale++;
          continue;
        }
        const late = Number(v.late);
        vehicles.push({
          id,
          label: String(v.label ?? id),
          mode: route.mode,
          route: route.key,
          tripId: v.trip != null && v.trip !== '' ? String(v.trip) : null,
          directionName: v.Direction ?? null,
          destination: v.destination ?? null,
          lat,
          lon,
          heading: Number.isFinite(Number(v.heading)) ? Number(v.heading) : null,
          lateMin: Number.isFinite(late) && Math.abs(late) < LATE_SENTINEL ? late : null,
          nextStopSequence: v.next_stop_sequence != null ? Number(v.next_stop_sequence) : null,
          nextStopName: v.next_stop_name ?? null,
          reportTs,
        });
      }
    }
  }
  return { vehicles, placeholders, stale };
}

/** Great-circle distance in meters. */
export function distanceM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Rider-facing vehicle noun for a route: buses, trolleys, or trains. */
export function vehicleNoun(mode, route, plural = true) {
  if (mode === 'bus') return plural ? 'buses' : 'bus';
  if (/^(t\d|g1|d\d)$/.test(route)) return plural ? 'trolleys' : 'trolley';
  return plural ? 'trains' : 'train';
}
