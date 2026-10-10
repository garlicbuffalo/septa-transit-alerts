// Drop TransitView positions that can't be where the vehicle is, before anything reads them.
//
// SEPTA's tracker sometimes reports a position far from anywhere the vehicle could be: a trolley
// that has just gone into the tunnel jumps 6 km to City Ave, or a bus's reports alternate between
// two places 15 km apart for hours. Left in, such a vehicle is drawn on a map miles from its
// route, counts as "bunched" with a vehicle it was never near, and records a speed no bus can
// reach. Two checks, both on a vehicle's own report:
//
//   off route  the position is more than maxOffRouteM from the shape of the vehicle's scheduled
//              trip. This is the one that says which of two alternating positions is wrong.
//   jump       the position is implausibly far, for the time that has passed, from the last one
//              kept for that vehicle. It covers a vehicle whose trip has no shape on file.
//
// A jump is only the vehicle's word against its own history, so a new position that stays
// consistent for reanchorAfter reports in a row is believed (the vehicle really did go there);
// one that alternates with the old position never is.
import { offRouteM } from './shapes.js';
import { distanceM } from './vehicles.js';

export const SCREEN_CONFIG = {
  // Detours, terminal loops and a bus not yet at the start of its trip are all within this of the
  // trip's scheduled shape (the farthest of the live vehicles checked at 11 pm: 637 m).
  maxOffRouteM: 1500,
  // Faster than any bus or trolley goes, with the distance below it to keep GPS noise on a
  // vehicle that is standing still from counting.
  maxSpeedKmh: 120,
  minJumpM: 1500,
  // Reports further apart than this say nothing about each other.
  maxCompareMs: 5 * 60 * 1000,
  // Reports stamped closer together than this count as this far apart (duplicates, or ones that
  // share a timestamp).
  minElapsedMs: 30 * 1000,
  reanchorAfter: 3,
  // How long a vehicle's last kept position is remembered after its last report.
  keepMs: 15 * 60 * 1000,
};

// Whether getting from `a` to `b` takes more than the fastest a vehicle goes.
function implausible(a, b, cfg) {
  const meters = distanceM(a, b);
  if (meters < cfg.minJumpM) return false;
  const elapsed = Math.max(Math.abs(b.reportTs - a.reportTs), cfg.minElapsedMs);
  if (elapsed > cfg.maxCompareMs) return false;
  return meters / 1000 / (elapsed / 3_600_000) > cfg.maxSpeedKmh;
}

/**
 * @param {Array<{ id: string, tripId: string | null, lat: number, lon: number, reportTs: number }>} vehicles
 *   normalizeTransitView output
 * @param {object} opts
 * @param {import('./shapes.js').RouteShapes | null} [opts.shapes] where each trip's shape comes
 *   from; without it only the jump check runs
 * @param {Record<string, object>} [opts.prev] `state` from the previous call
 * @param {number} opts.now
 * @returns {{ vehicles: object[], dropped: { offRoute: number, jump: number },
 *   state: Record<string, object> }} the vehicles that passed, how many didn't and why, and the
 *   state to hand the next call (plain JSON)
 */
export function screenVehicles(vehicles, { shapes = null, prev = {}, now }) {
  const cfg = SCREEN_CONFIG;
  const state = {};
  for (const [id, p] of Object.entries(prev ?? {})) {
    if (now - p.reportTs <= cfg.keepMs) state[id] = p;
  }
  const kept = [];
  const dropped = { offRoute: 0, jump: 0 };
  const advanced = new Set(); // ids whose position moved on this call
  for (const v of vehicles) {
    const shape = v.tripId ? shapes?.tripShape(v.tripId) : null;
    if (shape && offRouteM(shape, v.lat, v.lon) > cfg.maxOffRouteM) {
      dropped.offRoute++;
      continue;
    }
    const p = prev?.[v.id];
    if (p && implausible(p, v, cfg)) {
      const pending =
        p.pending && !implausible(p.pending, v, cfg)
          ? { lat: v.lat, lon: v.lon, reportTs: v.reportTs, n: p.pending.n + 1 }
          : { lat: v.lat, lon: v.lon, reportTs: v.reportTs, n: 1 };
      if (pending.n < cfg.reanchorAfter) {
        if (!advanced.has(v.id)) state[v.id] = { ...p, pending };
        dropped.jump++;
        continue;
      }
    }
    state[v.id] = { lat: v.lat, lon: v.lon, reportTs: v.reportTs };
    advanced.add(v.id);
    kept.push(v);
  }
  return { vehicles: kept, dropped, state };
}
