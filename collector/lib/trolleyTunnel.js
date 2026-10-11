// Subway-surface trolleys in the tunnel, placed by the schedule.
//
// T1–T5 run underground between their portal (36th St for the T1, 40th St for the others) and
// 13th St, where each eastbound trip ends and the trolley's westbound trip starts. There's no GPS
// underground: TransitView keeps reporting the trolley at its last fix before the portal, to the
// last decimal, for the whole ~20 minutes it's below (refreshing the report's timestamp now and
// then), and its lateness against that fix keeps growing, since by the schedule the trolley
// should be further along. Left like that, two trolleys that went in together sit "0 ft apart at
// the portal", stuck, and every trolley in the tunnel reads as later and later.
//
// So a trolley whose fix hasn't moved (to the last decimal) for darkAfterMs at its portal, or
// that has landed on the point SEPTA parks trolleys underground at (learned from the frozen
// fixes), is underground, as the Market-Frankford Line's trains are in their tunnel (subwayTrains.js): it is
// placed along its trip's shape by the schedule's times through the tunnel, from when it went in
// and how late it was then:
//
//   eastbound   from the portal toward 13th St, as late as it went in;
//   at 13th St  until its westbound trip is due to leave (TransitView switches it to that trip at
//               the scheduled departure);
//   westbound   from 13th St toward the portal, as late as its arrival leaves it after the
//               layover.
//
// Its lateness is the one it went in with, not TransitView's. One that should have come out by
// now is held at the portal and `frozen` (its position isn't known); one underground far longer
// than the tunnel takes isn't placed at all (a broken GPS left at the portal, or a trolley
// really stuck there), and neither is any trolley on a line with an active SEPTA alert about the
// tunnel or a diversion at the portal: those stay where TransitView has them. A trolley with a
// working fix at the portal (one that moves, by meters, even standing still) is where it says.
// A trolley that drops out of TransitView while it's underground (its report goes 5 minutes
// without a refresh) is placed from memory until it's back. Placed trolleys come out with
// `estimated: true`, like the L1's trains underground.
import { SubwayLine, scheduledPlaceAt } from './subwayTrains.js';
import { TUNNEL_PORTALS, TUNNEL_ROUTES } from './tunnelStops.js';
import { distanceM } from './vehicles.js';

export const TUNNEL_CONFIG = {
  routes: new Set(TUNNEL_ROUTES),
  portals: TUNNEL_PORTALS,
  // A trolley's last fix before the tunnel is within this of the portal stop (about 110 m on the
  // runs recorded 2026-10-11).
  portalM: 250,
  // A fix at the portal unchanged this long, or a report this old, is a trolley underground.
  darkAfterMs: 45 * 1000,
  // Once a trolley is underground SEPTA moves its fix, a few meters, onto one point for the
  // portal (39.949818, -75.2021x at 40th St on 2026-10-11, for every trolley) and repeats that.
  // A fix that moves no further than settleM is the same trolley still underground; one that
  // lands within snapM of a point a trolley was frozen at is underground already. Those points
  // are learned, and kept snapKeepMs.
  settleM: 30,
  snapM: 10,
  snapKeepMs: 7 * 24 * 60 * 60 * 1000,
  maxSnaps: 20,
  // How much longer than scheduled trolleys take through the tunnel.
  stretch: 1,
  // A trolley underground this many times its scheduled time below (in, layover, back out) isn't
  // in the tunnel: it's lost.
  maxDarkFactor: 2,
  // Going in later or earlier than this against its trip isn't a trolley entering the tunnel (a
  // GPS stuck at the portal, a trip SEPTA's tracker has wrong).
  maxLateMs: 45 * 60 * 1000,
  maxEarlyMs: 10 * 60 * 1000,
  // How long a trolley's fix is remembered after its last report. SEPTA drops a trolley from the
  // feed when its report is 5 minutes old, which happens underground: one that went in is placed
  // from memory while it's away.
  keepMs: 60 * 60 * 1000,
  // A SEPTA alert like this on a trolley line means trolleys aren't running through the tunnel
  // as scheduled (a diversion to 40th St, a closed tunnel): its trolleys aren't placed.
  troubleRe:
    /\b(tunnel|portal|subway[- ]surface|divert|diversion|detour|shuttle|blitz|single[- ]track)/i,
  // What TransitView calls each direction.
  directionNames: { 0: 'EastBound', 1: 'WestBound' },
};

/**
 * The routes with an active SEPTA alert saying trolleys aren't running the tunnel as scheduled.
 * @param {Map<string, object>} incidents the archive's incidents
 * @returns {Set<string>}
 */
export function tunnelTrouble(incidents, cfg = TUNNEL_CONFIG) {
  const out = new Set();
  for (const inc of incidents?.values?.() ?? []) {
    const alert = inc.official_alert;
    if (!alert || !inc.lifecycle?.active || inc.mode !== 'metro') continue;
    const text = `${alert.headline ?? ''} ${alert.description ?? ''}`;
    if (!cfg.troubleRe.test(text)) continue;
    for (const route of inc.routes ?? []) if (cfg.routes.has(route)) out.add(route);
  }
  return out;
}

// A trip's run through the tunnel: its stops' times and where they are along its shape.
function tunnelRun(tripId, { schedule, shapes, now, cache }) {
  if (!tripId) return null;
  if (cache.has(tripId)) return cache.get(tripId);
  let run = null;
  const st = schedule.stopTimes(tripId);
  const times = schedule.tripTimes(tripId, now);
  if (st && times && st.stops.length >= 2) {
    const midnight = times.startTs - times.startSec * 1000;
    const shape = shapes?.tripShape(tripId);
    const line =
      shape?.length >= 2
        ? new SubwayLine(shape)
        : new SubwayLine(st.stops.map((s) => [s.lat, s.lon]));
    const ms = st.stops.map((s) => line.project(s.lat, s.lon).m);
    run = {
      tripId,
      direction: times.direction,
      destination: times.destination,
      stops: st.stops,
      ts: st.secs.map((sec) => midnight + sec * 1000),
      ms,
      line,
    };
  }
  cache.set(tripId, run);
  return run;
}

// What's kept of a trolley to place it from memory once TransitView drops it.
const remembered = (v) => ({
  id: v.id,
  label: v.label,
  mode: v.mode,
  route: v.route,
  tripId: v.tripId,
  directionName: v.directionName,
  destination: v.destination,
});

// Where a run puts its trolley at schedule time t: { m, stop } (the next stop), held at its ends.
function placeOn(run, t) {
  const m = scheduledPlaceAt(run, t);
  const forward = run.ms.at(-1) >= run.ms[0];
  let i = run.ms.findIndex((sm) => (forward ? sm > m + 20 : sm < m - 20));
  if (i < 0) i = run.stops.length - 1;
  return { m, stop: run.stops[i] };
}

/**
 * Place the trolleys underground by the schedule.
 * @param {object[]} vehicles normalized (and screened) TransitView vehicles, any routes
 * @param {object} opts
 * @param {import('./schedule.js').Schedule | null} opts.schedule
 * @param {import('./shapes.js').RouteShapes | null} [opts.shapes]
 * @param {object} [opts.state] `state` from the previous call
 * @param {Set<string>} [opts.trouble] routes not to place (tunnelTrouble)
 * @param {number} opts.now
 * @returns {{ vehicles: object[], stats: object, state: object }} the vehicles, with each one
 *   underground placed (`estimated`, and `frozen` when it's overdue out), counts, and the state
 *   to hand the next call (JSON)
 */
export function placeTunnelTrolleys(
  vehicles,
  { schedule, shapes = null, state: prevState = {}, trouble = new Set(), now, cfg = TUNNEL_CONFIG },
) {
  const prev = prevState?.cars ?? {};
  const cars = {};
  for (const [id, c] of Object.entries(prev)) if (now - c.lastTs <= cfg.keepMs) cars[id] = c;
  const snaps = {};
  for (const [name, list] of Object.entries(prevState?.snaps ?? {})) {
    snaps[name] = list.filter((p) => now - p.ts <= cfg.snapKeepMs);
  }
  const stats = { underground: 0, placed: 0, remembered: 0, overdue: 0, lost: 0, trouble: 0 };
  const cache = new Map();
  const ctx = { schedule, shapes, now, cache };

  // TransitView can list a trolley twice as it changes trips at 13th St: keep its newer trip.
  const tunnel = new Map();
  const others = [];
  for (const v of vehicles) {
    if (!cfg.routes.has(v.route)) {
      others.push(v);
      continue;
    }
    const seen = tunnel.get(v.id);
    const startOf = (x) => (x.tripId && schedule?.tripTimes(x.tripId, now)?.startTs) || 0;
    if (!seen || startOf(v) > startOf(seen)) tunnel.set(v.id, v);
  }

  const out = [...others];
  for (const v of tunnel.values()) {
    const before = cars[v.id];
    const portal = cfg.portals[v.route];
    const atPortal = distanceM(v, portal) <= cfg.portalM;
    const identical = before && before.lat === v.lat && before.lon === v.lon;
    const moved = before ? distanceM(before, v) : Infinity;
    // Underground already, and its fix has only settled onto SEPTA's point for the portal.
    const settling = before?.dark && atPortal && moved <= cfg.settleM;
    // Just arrived on a point SEPTA has parked trolleys underground at (one already wobbling
    // around it is out in the open, with a working GPS).
    const parked =
      atPortal &&
      !identical &&
      !settling &&
      !(before && moved <= cfg.snapM) &&
      (snaps[portal.name] ?? []).some((p) => distanceM(p, v) <= cfg.snapM);
    // `t0`: when it went in (its fix's earliest report), `since`: when the fix was first seen,
    // `trip0` and `late0`: the trip it went in on and how late it was then.
    let car;
    if (identical || settling) {
      car = {
        ...before,
        lat: v.lat,
        lon: v.lon,
        t0: identical ? Math.min(before.t0, v.reportTs) : before.t0,
        lastTs: now,
      };
    } else {
      const lastFixAtPortal = before && distanceM(before, portal) <= cfg.portalM;
      car = {
        lat: v.lat,
        lon: v.lon,
        // It went in somewhere between its last fix at the portal and this one.
        t0: parked && lastFixAtPortal ? Math.round((before.t0 + v.reportTs) / 2) : v.reportTs,
        since: now,
        lastTs: now,
        trip0: v.tripId,
        late0: v.lateMin,
      };
    }
    cars[v.id] = car;
    const dark =
      schedule &&
      atPortal &&
      (settling ||
        parked ||
        (identical && now - car.since >= cfg.darkAfterMs) ||
        now - v.reportTs >= cfg.darkAfterMs);
    if (!dark) {
      car.dark = false;
      out.push(v);
      continue;
    }
    stats.underground++;
    if (!settling && !parked) learnSnap(portal.name, v);
    if (trouble.has(v.route)) {
      stats.trouble++;
      car.dark = false;
      out.push(v);
      continue;
    }
    const placed = place(v, car, portal);
    if (!placed) {
      stats.lost++;
      car.dark = false;
      out.push(v);
      continue;
    }
    count(placed);
    car.dark = true;
    car.vehicle = remembered(v);
    out.push(placed);
  }
  // Trolleys underground that TransitView has dropped: placed from memory, on their last trip.
  for (const [id, car] of Object.entries(cars)) {
    if (tunnel.has(id) || !car.dark || !car.vehicle) continue;
    const v = { ...car.vehicle, lat: car.lat, lon: car.lon, reportTs: car.t0 };
    if (trouble.has(v.route)) continue;
    stats.underground++;
    const placed = place(v, car, cfg.portals[v.route]);
    if (!placed) {
      stats.lost++;
      car.dark = false;
      continue;
    }
    stats.remembered++;
    count(placed);
    out.push(placed);
  }
  return { vehicles: out, stats, state: { cars, snaps } };

  // A trolley's fix frozen at the portal: where SEPTA parks trolleys underground.
  function learnSnap(name, v) {
    const list = (snaps[name] ?? []).filter((p) => !(p.lat === v.lat && p.lon === v.lon));
    snaps[name] = [{ lat: v.lat, lon: v.lon, ts: now }, ...list].slice(0, cfg.maxSnaps);
  }

  function count(placed) {
    stats.placed++;
    if (placed.frozen) stats.overdue++;
  }

  // The trolley underground, placed along the trip it should be on now, or null when it can't be.
  function place(v, car, portal) {
    const into = tunnelRun(car.trip0, ctx);
    if (!into || into.direction !== 0) return null;
    const portalAt = into.stops.findIndex((s) => s.name === portal.name);
    if (portalAt < 0) return null;
    // How late it went in, and the schedule time it's at now on that trip.
    // First seen with no schedule match (TransitView's late "998"): there's no lateness to go in
    // with. Underground, that's how a trolley reads near the end of its eastbound trip, so one
    // already placed keeps its lateness from going in; one first seen like this isn't placed.
    if (car.late0 == null) return null;
    const late = car.t0 - into.ts[portalAt];
    if (late > cfg.maxLateMs || late < -cfg.maxEarlyMs) return null;
    const below = (now - car.t0) / cfg.stretch;
    // Its next trip, westbound from 13th St, once TransitView has moved it on.
    const back = v.tripId !== car.trip0 ? tunnelRun(v.tripId, ctx) : null;
    const backRun =
      back?.direction === 1 && back.stops[0].name === into.stops.at(-1).name ? back : null;
    const scheduledBelow =
      into.ts.at(-1) - into.ts[portalAt] + (backRun ? backRun.ts.at(-1) - into.ts.at(-1) : 0);
    if (now - car.t0 > cfg.maxDarkFactor * Math.max(scheduledBelow, 10 * 60 * 1000)) return null;

    let run = into;
    let at = into.ts[portalAt] + below;
    let lateMs = late;
    let frozen = false;
    if (at > into.ts.at(-1)) {
      if (backRun) {
        // It reached 13th St `late` behind schedule and leaves on time, or as soon as it's in.
        lateMs = Math.max(0, into.ts.at(-1) + late - backRun.ts[0]);
        run = backRun;
        at = backRun.ts[0] + Math.max(0, now - lateMs - backRun.ts[0]);
        if (at >= backRun.ts.at(-1)) {
          // It should be out by now: somewhere short of the portal, position unknown.
          frozen = true;
          lateMs = now - backRun.ts.at(-1);
          at = backRun.ts.at(-1);
        }
      } else {
        // At 13th St, until its westbound trip is due.
        at = into.ts.at(-1);
      }
    }
    const { m, stop } = placeOn(run, at);
    const point = run.line.pointAt(m);
    const forward = run.ms.at(-1) >= run.ms[0];
    const trip = schedule.trip(run.tripId);
    const { frozen: _wasFrozen, ...rest } = v;
    return {
      ...rest,
      tripId: run.tripId,
      directionName: cfg.directionNames[run.direction] ?? v.directionName,
      destination:
        run === into ? (v.destination ?? trip?.destination) : (trip?.destination ?? null),
      lat: point.lat,
      lon: point.lon,
      heading: Math.round(forward ? point.bearing : (point.bearing + 180) % 360),
      lateMin: Math.round(lateMs / 6000) / 10,
      nextStopSequence: stop?.seq ?? null,
      nextStopName: stop?.name ?? null,
      estimated: true,
      ...(frozen ? { frozen: true } : {}),
    };
  }
}
