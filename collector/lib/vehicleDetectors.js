// Disruptions inferred from live vehicle positions (TransitView) against the
// GTFS schedule, for buses and the GPS-tracked SEPTA Metro lines (trolleys and
// the M1). Four signals, named as the site's signal vocabulary names them:
//
//   gap         two consecutive vehicles of one pattern are far further apart
//               in time than scheduled — riders wait much longer than the
//               timetable says. Spacing is measured as each vehicle's
//               scheduled start plus how late it's running; trips cancelled
//               in between count toward the gap.
//   bunching    vehicles of one pattern scheduled well apart are running
//               together (within a few hundred meters), so the gap behind
//               them is about to open.
//   ghost       far fewer of a route's scheduled trips are showing on SEPTA's
//               tracker than usual for that route.
//   pulse-held  two or more vehicles on a route stopped mid-route for 10+
//               minutes near each other.
//
// Each tick finds the conditions present right now (findConditions); a
// condition must hold on two consecutive ticks to open a detection, and clear
// on two to resolve it (applyVehicleConditions). A detection attaches to an
// active, unplanned SEPTA alert on the same route when there is one;
// otherwise it becomes its own bot incident.
//
// Thresholds live in DETECTOR_CONFIG. They are deliberately conservative — a
// detection should be something a rider would notice — and only cover
// vehicles with real GPS (see vehicles.js).

import { isPlannedWork } from '../../src/lib/incidents.js';
import metroStations from '../../src/lib/metroStations.json' with { type: 'json' };
import { classifyRoute } from './network.js';
import { distanceM, vehicleNoun } from './vehicles.js';

export const VEHICLE_SOURCES = new Set(['gap', 'bunching', 'ghost', 'pulse-held', 'thin-gap']);
const ID_PREFIX = {
  gap: 'gap',
  bunching: 'bunching',
  ghost: 'ghost',
  'pulse-held': 'held',
  'thin-gap': 'thin-gap',
};

export const DETECTOR_CONFIG = {
  // A gap counts when vehicles are at least this far apart (minutes) AND at
  // least `factor` times the pattern's scheduled spacing.
  gap: { minMin: 20, factor: 2 },
  // Vehicles this close (meters) whose scheduled starts differ by at least
  // `minSpacingMin` (or half the scheduled spacing, if larger) are bunched.
  bunching: { maxDistM: 250, minSpacingMin: 8 },
  // Ghost: at least `minScheduled` trips in progress, `minMissing` of them
  // not tracked, at most `maxRatio` tracked — and the route normally tracks
  // at least `typicalRatio` (so chronically untracked routes stay quiet).
  ghost: { minScheduled: 4, minMissing: 3, maxRatio: 0.5, typicalRatio: 0.75 },
  // Thin gap, for routes too sparse for the ghost check (fewer than
  // ghost.minScheduled trips in progress): no vehicle on the tracker for
  // max(`headwayFactor` × the scheduled spacing, `minWindowMin`) of continuous
  // scheduled service, on a route that's normally well tracked.
  thinGap: { headwayFactor: 2, minWindowMin: 60 },
  // How long the "how well is this route usually tracked" average remembers.
  coverageMemoryMs: 3 * 60 * 60 * 1000,
  // Held: vehicles that moved under `maxMoveM` across reports at least
  // `minStationaryMin` apart, `minVehicles` of them within `clusterM`.
  held: { maxMoveM: 50, minStationaryMin: 10, minVehicles: 2, clusterM: 600 },
  // Skip ghost detection system-wide when the tracker is covering less than
  // this share of scheduled trips (a feed problem, not a service problem).
  minSystemCoverage: 0.5,
  // Vehicles near the start or end of their trip (layovers) are left out of
  // bunching and held.
  terminalStops: 3,
  // A condition opens after showing on confirmTicks consecutive polls spanning
  // at least confirmMs, and resolves after clearTicks polls without it spanning
  // clearMs — the same few minutes whether polls come every 2 minutes (the bot
  // server) or every 10 (the GitHub Actions fallback).
  confirmTicks: 2,
  confirmMs: 6 * 60 * 1000,
  clearTicks: 2,
  clearMs: 6 * 60 * 1000,
  // A candidate older than this didn't hold "two ticks in a row".
  tickGapMs: 16 * 60 * 1000,
  maxUpdates: 8,
};

// The subway lines report no positions at all.
const NO_POSITIONS = new Set(['l1', 'b1', 'b2', 'b3']);

const etFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function easternStamp(ts) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${p.hour}${p.minute}` };
}

function routeName(mode, route) {
  return mode === 'bus' ? `Route ${route.replace(/-/g, ' ')}` : route.toUpperCase();
}

function compass(name) {
  const m = /^(north|south|east|west)/i.exec(name ?? '');
  return m ? m[1].toLowerCase() : null;
}

// --- Metro station lookup ------------------------------------------------------
const STATIONS_BY_LINE = new Map();
for (const s of metroStations) {
  for (const line of s.lines) {
    if (!STATIONS_BY_LINE.has(line)) STATIONS_BY_LINE.set(line, []);
    STATIONS_BY_LINE.get(line).push(s);
  }
}
for (const [line, list] of STATIONS_BY_LINE) list.sort((a, b) => a.seq[line] - b.seq[line]);

/** Nearest station on a Metro line within 400 m of a position, or null. */
export function nearestStation(line, pos) {
  let best = null;
  for (const s of STATIONS_BY_LINE.get(line) ?? []) {
    const d = distanceM(pos, s);
    if (d <= 400 && (!best || d < best.d)) best = { s, d };
  }
  return best?.s ?? null;
}

// Stations on `line` from `a` to `b` inclusive, in line order.
function stretch(line, a, b) {
  if (!a || !b) return [];
  const lo = Math.min(a.seq[line], b.seq[line]);
  const hi = Math.max(a.seq[line], b.seq[line]);
  return (STATIONS_BY_LINE.get(line) ?? [])
    .filter((s) => s.seq[line] >= lo && s.seq[line] <= hi)
    .map((s) => s.name);
}

function metroScope(mode, route, behind, ahead) {
  if (mode !== 'metro') return { from: null, to: null, stations: [] };
  const from = behind ? nearestStation(route, behind) : null;
  const to = ahead ? nearestStation(route, ahead) : null;
  if (!from && !to) return { from: null, to: null, stations: [] };
  if (!from || !to || from === to) {
    const one = from ?? to;
    return { from: one.name, to: null, stations: [one.name] };
  }
  return { from: from.name, to: to.name, stations: stretch(route, from, to) };
}

// --- Condition finding -----------------------------------------------------------

// The shortest scheduled spacing (minutes) among a route's directions with
// service right now, or null when the schedule can't say.
function scheduledHeadway(schedule, route, now) {
  let best = null;
  for (const dir of [0, 1]) {
    const h = schedule.headwayMin(route, dir, now);
    if (h && (best == null || h < best)) best = h;
  }
  return best;
}

/**
 * Find the disruption conditions present right now.
 * @param {object} p
 * @param {ReturnType<import('./vehicles.js').normalizeTransitView>['vehicles']} p.vehicles
 * @param {import('./schedule.js').Schedule} p.schedule
 * @param {Set<string>} p.cancelledTripIds trips SEPTA has cancelled today
 * @param {object} p.state detector state (previous positions, route coverage); updated in place
 * @param {number} p.now
 * @returns {{ conditions: Map<string, object>, stats: object }}
 */
export function findConditions({ vehicles, schedule, cancelledTripIds, state, now }) {
  const cfg = DETECTOR_CONFIG;
  const conditions = new Map();
  const stats = { vehicles: vehicles.length, matched: 0, scheduled: 0, tracked: 0 };

  // Attach each vehicle's scheduled trip.
  const byRouteDir = new Map();
  const byRoute = new Map();
  for (const v of vehicles) {
    if (NO_POSITIONS.has(v.route)) continue;
    const trip = v.tripId ? schedule.tripTimes(v.tripId, now) : null;
    const rec = { ...v, trip };
    if (trip) {
      stats.matched++;
      const key = `${v.route}|${trip.direction}`;
      if (!byRouteDir.has(key)) byRouteDir.set(key, []);
      byRouteDir.get(key).push(rec);
    }
    if (!byRoute.has(v.route)) byRoute.set(v.route, { mode: v.mode, vehicles: [] });
    byRoute.get(v.route).vehicles.push(rec);
  }

  // Mid-route, and where it says it is: a frozen trolley (see vehicleScreen.js) is somewhere in
  // the tunnel, not at the repeated fix, so it neither bunches with a car near that fix nor is
  // "held" there.
  const midRoute = (v) =>
    !v.frozen &&
    v.trip &&
    v.nextStopSequence != null &&
    v.nextStopSequence > cfg.terminalStops &&
    v.nextStopSequence < v.trip.lastSequence - 1;

  // --- gap + bunching, per route and direction.
  for (const [key, list] of byRouteDir) {
    const [route, dirStr] = key.split('|');
    const direction = Number(dirStr);
    const mode = list[0].mode;
    const tracked = new Map(list.map((v) => [v.trip.tripId, v]));
    const active = schedule.activeTrips(route, direction, now);

    // Gap: walk each pattern (trips from the same origin) in scheduled order.
    const patterns = new Map();
    for (const t of active) {
      if (!patterns.has(t.origin)) patterns.set(t.origin, []);
      patterns.get(t.origin).push(t);
    }
    let worstGap = null;
    for (const [origin, trips] of patterns) {
      const headway = schedule.headwayMin(route, direction, now, origin);
      if (!headway) continue;
      let lead = null;
      let cancelledBetween = 0;
      for (const t of trips) {
        const v = tracked.get(t.tripId);
        if (cancelledTripIds.has(t.tripId)) {
          cancelledBetween++;
          continue;
        }
        if (!v || v.lateMin == null) {
          // A scheduled trip we can't see: the spacing across it is unknown.
          lead = null;
          cancelledBetween = 0;
          continue;
        }
        if (lead) {
          const spacing =
            (t.startTs + v.lateMin * 60000 - (lead.t.startTs + lead.v.lateMin * 60000)) / 60000;
          const threshold = Math.max(cfg.gap.minMin, cfg.gap.factor * headway);
          if (spacing >= threshold && (!worstGap || spacing > worstGap.spacing)) {
            worstGap = { spacing, headway, cancelledBetween, ahead: lead.v, behind: v };
          }
        }
        lead = { t, v };
        cancelledBetween = 0;
      }
    }
    if (worstGap) {
      const { ahead, behind } = worstGap;
      const scope = metroScope(mode, route, behind, ahead);
      const gapMin = Math.round(worstGap.spacing);
      const headwayMin = Math.round(worstGap.headway);
      const noun = vehicleNoun(mode, route);
      // TransitView's headsign reads better than GTFS's final-stop name.
      const toward = ahead.destination ?? ahead.trip.destination;
      const extra = worstGap.cancelledBetween
        ? `; ${worstGap.cancelledBetween === 1 ? '1 trip in between was' : `${worstGap.cancelledBetween} trips in between were`} cancelled`
        : '';
      conditions.set(`gap|${mode}|${route}|${direction}`, {
        source: 'gap',
        mode,
        route,
        direction,
        directionName: ahead.directionName,
        destination: toward,
        scope,
        metric: gapMin,
        description: `~${gapMin} min between ${routeName(mode, route)} ${noun}${toward ? ` toward ${toward}` : ''} — scheduled every ~${headwayMin} min${extra}`,
        details: {
          kind: 'gap',
          direction_id: direction,
          gap_min: gapMin,
          headway_min: headwayMin,
          cancelled_between: worstGap.cancelledBetween,
          vehicles: [ahead.label, behind.label],
        },
      });
    }

    // Bunching: mid-route vehicles scheduled well apart, now within a few
    // hundred meters of each other.
    const headwayAll = schedule.headwayMin(route, direction, now);
    const minSpacing = Math.max(cfg.bunching.minSpacingMin, (headwayAll ?? 0) / 2);
    const mid = list.filter(midRoute);
    let worstBunch = null;
    for (let i = 0; i < mid.length; i++) {
      const group = [mid[i]];
      let closest = Infinity;
      for (let j = 0; j < mid.length; j++) {
        // Scheduled starts only compare within a pattern: a short-turn trip
        // starting midway is scheduled to run close behind a full-length one.
        if (i === j || mid[i].trip.origin !== mid[j].trip.origin) continue;
        const d = distanceM(mid[i], mid[j]);
        const spacing = Math.abs(mid[i].trip.startTs - mid[j].trip.startTs) / 60000;
        if (d <= cfg.bunching.maxDistM && spacing >= minSpacing) {
          group.push(mid[j]);
          closest = Math.min(closest, d);
        }
      }
      if (group.length >= 2 && (!worstBunch || group.length > worstBunch.group.length)) {
        const starts = group.map((v) => v.trip.startTs);
        worstBunch = {
          group,
          distance: closest,
          spacing: (Math.max(...starts) - Math.min(...starts)) / 60000,
        };
      }
    }
    if (worstBunch) {
      const { group } = worstBunch;
      const scope = metroScope(mode, route, group[0], null);
      const noun = vehicleNoun(mode, route);
      const toward = group[0].destination ?? group[0].trip.destination;
      const near = scope.from ?? group[0].nextStopName;
      conditions.set(`bunching|${mode}|${route}|${direction}`, {
        source: 'bunching',
        mode,
        route,
        direction,
        directionName: group[0].directionName,
        destination: toward,
        scope,
        metric: group.length,
        description: `${group.length} ${routeName(mode, route)} ${noun}${toward ? ` toward ${toward}` : ''} running together${near ? ` near ${near}` : ''} — ~${Math.round(worstBunch.distance)} m apart, scheduled ~${Math.round(worstBunch.spacing)} min apart`,
        details: {
          kind: 'bunching',
          direction_id: direction,
          vehicle_count: group.length,
          distance_m: Math.round(worstBunch.distance),
          scheduled_spacing_min: Math.round(worstBunch.spacing),
          headway_min: headwayAll != null ? Math.round(headwayAll) : null,
          vehicles: group.map((v) => v.label),
        },
      });
    }
  }

  // --- held, per route (needs the previous tick's positions).
  const prevVehicles = state.vehicles ?? {};
  const nextVehicles = {};
  for (const [route, { mode, vehicles: list }] of byRoute) {
    const stopped = [];
    for (const v of list) {
      const prev = prevVehicles[v.id];
      let since = v.reportTs;
      if (
        prev &&
        prev.tripId === v.tripId &&
        v.reportTs > prev.reportTs &&
        distanceM(prev, v) <= cfg.held.maxMoveM
      ) {
        since = prev.since ?? prev.reportTs;
      }
      nextVehicles[v.id] = {
        lat: v.lat,
        lon: v.lon,
        reportTs: v.reportTs,
        tripId: v.tripId,
        since,
      };
      const stoppedMin = (v.reportTs - since) / 60000;
      if (stoppedMin >= cfg.held.minStationaryMin && midRoute(v)) stopped.push({ v, stoppedMin });
    }
    if (stopped.length < cfg.held.minVehicles) continue;
    // Largest group of stopped vehicles within clusterM of one of them.
    let best = [];
    for (const a of stopped) {
      const group = stopped.filter((b) => distanceM(a.v, b.v) <= cfg.held.clusterM);
      if (group.length > best.length) best = group;
    }
    if (best.length < cfg.held.minVehicles) continue;
    const longest = Math.max(...best.map((b) => b.stoppedMin));
    const scope = metroScope(mode, route, best[0].v, null);
    const near = scope.from ?? best[0].v.nextStopName;
    const noun = vehicleNoun(mode, route);
    conditions.set(`pulse-held|${mode}|${route}`, {
      source: 'pulse-held',
      mode,
      route,
      direction: null,
      scope,
      metric: best.length,
      description: `${best.length} ${routeName(mode, route)} ${noun} stopped${near ? ` near ${near}` : ''} for ${Math.floor(longest)}+ min`,
      details: {
        kind: 'held',
        vehicle_count: best.length,
        ...(mode === 'bus' ? { busCount: best.length } : {}),
        stationaryMs: Math.round(longest * 60000),
        vehicles: best.map((b) => b.v.label),
      },
    });
  }
  state.vehicles = nextVehicles;

  // --- ghost, per route: scheduled trips in progress vs. trips on the tracker.
  const perRoute = [];
  for (const key of schedule.byRouteDir.keys()) {
    const [route, dirStr] = key.split('|');
    if (NO_POSITIONS.has(route)) continue;
    const active = schedule.activeTrips(route, Number(dirStr), now);
    if (active.length === 0) continue;
    let entry = perRoute.find((r) => r.route === route);
    if (!entry) {
      entry = { route, scheduled: 0, tracked: 0, cancelled: 0 };
      perRoute.push(entry);
    }
    const onRoute = byRoute.get(route)?.vehicles ?? [];
    const trackedTrips = new Set(onRoute.map((v) => v.tripId));
    for (const t of active) {
      if (cancelledTripIds.has(t.tripId)) entry.cancelled++;
      else {
        entry.scheduled++;
        if (trackedTrips.has(t.tripId)) entry.tracked++;
      }
    }
  }
  for (const r of perRoute) {
    // Vehicles still running trips past their scheduled end count as running.
    const extra = (byRoute.get(r.route)?.vehicles ?? []).filter(
      (v) => !v.trip || v.trip.endTs < now,
    ).length;
    r.tracked = Math.min(r.scheduled, r.tracked + extra);
    stats.scheduled += r.scheduled;
    stats.tracked += r.tracked;
  }
  const coverage = stats.scheduled > 0 ? stats.tracked / stats.scheduled : 0;
  stats.coverage = Math.round(coverage * 100) / 100;
  // A tracker covering under half of a busy system's trips is a feed problem:
  // the caller holds detections as they are rather than resolve them all.
  stats.feedHealthy = !(stats.scheduled >= 20 && coverage < cfg.minSystemCoverage);
  const typical = state.routeCoverage ?? {};
  const ghostEnabled = stats.scheduled >= 20 && coverage >= cfg.minSystemCoverage;
  // Exponential average over time, so it remembers ~coverageMemoryMs whether
  // polls come every 2 minutes or every 10.
  const sinceLastMs = state.updated_at
    ? Math.min(now - state.updated_at, 60 * 60 * 1000)
    : 10 * 60 * 1000;
  const alpha = 1 - Math.exp(-Math.max(0, sinceLastMs) / cfg.coverageMemoryMs);
  const lastSeen = state.routeLastSeen ?? {};
  for (const r of perRoute) {
    if (r.scheduled < 2) continue;
    const ratio = r.tracked / r.scheduled;
    const usual = typical[r.route];
    const missing = r.scheduled - r.tracked;
    const mode = classifyRoute(r.route)?.mode === 'metro' ? 'metro' : 'bus';
    if (
      ghostEnabled &&
      usual != null &&
      usual >= cfg.ghost.typicalRatio &&
      r.scheduled >= cfg.ghost.minScheduled &&
      missing >= cfg.ghost.minMissing &&
      ratio <= cfg.ghost.maxRatio
    ) {
      const noun = vehicleNoun(mode, r.route);
      conditions.set(`ghost|${mode}|${r.route}`, {
        source: 'ghost',
        mode,
        route: r.route,
        direction: null,
        scope: { from: null, to: null, stations: [] },
        metric: missing,
        description: `Only ${r.tracked} of ${r.scheduled} scheduled ${routeName(mode, r.route)} ${noun} showing on SEPTA's tracker${r.cancelled ? ` (another ${r.cancelled} cancelled)` : ''}`,
        details: {
          kind: 'ghost',
          scheduled: r.scheduled,
          tracked: r.tracked,
          missing,
          cancelled: r.cancelled,
          usual_tracked_pct: Math.round(usual * 100),
        },
      });
    }
    // Thin gap: a sparse route with nothing on the tracker for long enough to
    // have missed two trips. The silence clock only runs during scheduled
    // service (see routeLastSeen below), so overnight breaks don't count.
    const headway = scheduledHeadway(schedule, r.route, now);
    if (lastSeen[r.route] == null) lastSeen[r.route] = now; // start the clock
    const silentMs = now - lastSeen[r.route];
    const windowMin = headway
      ? Math.max(cfg.thinGap.headwayFactor * headway, cfg.thinGap.minWindowMin)
      : null;
    if (
      ghostEnabled &&
      windowMin &&
      r.tracked === 0 &&
      r.scheduled < cfg.ghost.minScheduled &&
      usual != null &&
      usual >= cfg.ghost.typicalRatio &&
      silentMs >= windowMin * 60000
    ) {
      const silentMin = Math.round(silentMs / 60000);
      const noun = vehicleNoun(mode, r.route);
      conditions.set(`thin-gap|${mode}|${r.route}`, {
        source: 'thin-gap',
        mode,
        route: r.route,
        direction: null,
        scope: { from: null, to: null, stations: [] },
        metric: silentMin,
        onsetTs: lastSeen[r.route],
        description: `No ${routeName(mode, r.route)} ${noun} on SEPTA's tracker for ~${silentMin} min — scheduled every ~${Math.round(headway)} min`,
        details: {
          kind: 'thin-gap',
          silent_min: silentMin,
          headway_min: Math.round(headway),
          missed_trips: Math.floor(silentMin / headway),
          scheduled: r.scheduled,
        },
      });
    }
    // Time-weighted average of how well this route is usually tracked.
    if (ghostEnabled) typical[r.route] = usual == null ? ratio : usual + alpha * (ratio - usual);
  }
  state.routeCoverage = typical;
  // A route counts as "seen" whenever a vehicle is on the tracker or nothing
  // is scheduled to be running, so silence measures missed service only.
  const inService = new Set(perRoute.map((r) => r.route));
  for (const route of byRoute.keys()) lastSeen[route] = now;
  for (const key of schedule.byRouteDir.keys()) {
    const route = key.split('|')[0];
    if (!inService.has(route)) lastSeen[route] = now;
  }
  state.routeLastSeen = lastSeen;
  return { conditions, stats };
}

// --- Lifecycle -----------------------------------------------------------------

function closedLifecycle(lc, resolvedTs) {
  const resolved = Math.max(lc.first_seen_ts, resolvedTs);
  return {
    ...lc,
    resolved_ts: resolved,
    active: false,
    duration_ms: resolved - (lc.onset_ts ?? lc.first_seen_ts),
  };
}

const RESOLVED_TEXT = {
  gap: (n) => `${n[0].toUpperCase()}${n.slice(1)} back to normal spacing.`,
  bunching: (n) => `${n[0].toUpperCase()}${n.slice(1)} spread out again.`,
  ghost: (n) => `${n[0].toUpperCase()}${n.slice(1)} back on the tracker.`,
  'pulse-held': (n) => `${n[0].toUpperCase()}${n.slice(1)} moving again.`,
  'thin-gap': (n) => `${n[0].toUpperCase()}${n.slice(1)} back on the tracker.`,
};

function buildDetection(id, c, onsetTs, now) {
  return {
    id,
    source: c.source,
    scope: {
      route: c.route,
      from_station: c.scope.from,
      to_station: c.scope.to,
      stations: c.scope.stations,
      direction: c.directionName ? compass(c.directionName) : null,
      direction_label: c.destination ? `toward ${c.destination}` : null,
    },
    lifecycle: {
      first_seen_ts: now,
      onset_ts: c.onsetTs ?? onsetTs,
      resolved_ts: null,
      active: true,
      duration_ms: null,
    },
    post_url: null,
    resolved_post_url: null,
    description: c.description,
    evidence: {
      train_number: null,
      signals: null,
      details: { ...c.details, worst: c.metric, last_seen_ts: now },
      bullets: [],
      onset_description: null,
      resolved_description: null,
      updates: [],
    },
  };
}

// Whether a metric change is worth a timeline update.
function worsened(source, prev, next) {
  if (source === 'gap') return next >= prev + 10;
  return next > prev;
}

function uniqueId(incidents, base) {
  if (!incidents.has(base)) return base;
  for (let n = 2; ; n++) if (!incidents.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Turn this tick's conditions into detections (mutates `incidents` and `state`).
 * @param {Map<string, object>} incidents
 * @param {Map<string, object>} conditions findConditions().conditions
 * @param {object} state detector state
 * @param {number} now
 * @returns {{ changed: Set<string>, stats: object }}
 */
export function applyVehicleConditions(incidents, conditions, state, now) {
  const cfg = DETECTOR_CONFIG;
  const changed = new Set();
  const stats = { opened: 0, resolved: 0, active: 0 };
  const candidates = state.candidates ?? {};
  const active = state.active ?? {};
  const nextCandidates = {};

  const findDetection = (st) => {
    const inc = incidents.get(st.incidentId);
    const idx = inc?.detections?.findIndex((d) => d.id === st.detectionId) ?? -1;
    return idx >= 0 ? { inc, idx } : null;
  };
  const writeDetection = (inc, idx, det, lifecycleForBot) => {
    const detections = inc.detections.map((d, i) => (i === idx ? det : d));
    const next = { ...inc, detections };
    if (!inc.official_alert && lifecycleForBot) next.lifecycle = lifecycleForBot;
    incidents.set(inc.id, next);
    changed.add(inc.id);
  };
  const resolve = (key, st, resolvedTs) => {
    const found = findDetection(st);
    if (found) {
      const { inc, idx } = found;
      const det = inc.detections[idx];
      const lifecycle = closedLifecycle(det.lifecycle, resolvedTs);
      const noun = vehicleNoun(inc.mode, det.scope.route);
      const resolvedText = RESOLVED_TEXT[det.source]?.(
        `${routeName(inc.mode, det.scope.route)} ${noun}`,
      );
      const nextDet = {
        ...det,
        lifecycle,
        evidence: { ...det.evidence, resolved_description: resolvedText ?? null },
      };
      const { onset_ts: _onset, ...incLifecycle } = lifecycle;
      writeDetection(inc, idx, nextDet, incLifecycle);
      stats.resolved++;
    }
    delete active[key];
  };

  // Detections whose SEPTA alert has since resolved end with it; the
  // condition reopens as a bot incident if it persists.
  for (const [key, st] of Object.entries(active)) {
    const found = findDetection(st);
    if (!found) {
      delete active[key];
      continue;
    }
    if (found.inc.official_alert && !found.inc.lifecycle.active) {
      resolve(key, st, found.inc.lifecycle.resolved_ts ?? now);
    }
  }

  for (const [key, c] of conditions) {
    const st = active[key];
    if (st) {
      const found = findDetection(st);
      if (!found) {
        delete active[key];
        continue;
      }
      const { inc, idx } = found;
      const det = inc.detections[idx];
      const prevWorst = det.evidence.details?.worst ?? c.metric;
      const updates = [...(det.evidence.updates ?? [])];
      if (worsened(c.source, prevWorst, c.metric)) {
        updates.push({ ts: now, description: c.description, post_url: null, evidence: null });
      }
      const nextDet = {
        ...det,
        description: worsened(c.source, prevWorst, c.metric) ? c.description : det.description,
        evidence: {
          ...det.evidence,
          details: {
            ...(worsened(c.source, prevWorst, c.metric) ? c.details : det.evidence.details),
            worst: Math.max(prevWorst, c.metric),
            last_seen_ts: now,
          },
          updates: updates.slice(-cfg.maxUpdates),
        },
      };
      writeDetection(inc, idx, nextDet, null);
      st.lastPositiveTs = now;
      st.misses = 0;
      continue;
    }

    const cand = candidates[key];
    const confirmed =
      cand &&
      now - cand.lastTs <= cfg.tickGapMs &&
      cand.count + 1 >= cfg.confirmTicks &&
      now - cand.firstTs >= cfg.confirmMs;
    if (!confirmed) {
      const fresh = cand && now - cand.lastTs <= cfg.tickGapMs;
      nextCandidates[key] = {
        firstTs: fresh ? cand.firstTs : now,
        lastTs: now,
        count: fresh ? cand.count + 1 : 1,
      };
      continue;
    }

    // Open: attach to an active, unplanned SEPTA alert on the route, or
    // start a bot incident.
    const stamp = easternStamp(now);
    const prefix = ID_PREFIX[c.source];
    const host = [...incidents.values()].find(
      (inc) =>
        inc.official_alert &&
        inc.lifecycle?.active &&
        inc.mode === c.mode &&
        (inc.routes ?? []).includes(c.route) &&
        !isPlannedWork(inc),
    );
    if (host) {
      const detId = uniqueId(
        new Map(host.detections.map((d) => [d.id, d])),
        `${host.id}-${prefix}-${stamp.hhmm}`,
      );
      const det = buildDetection(detId, c, cand.firstTs, now);
      incidents.set(host.id, {
        ...host,
        sources: host.sources.includes('bot') ? host.sources : [...host.sources, 'bot'],
        detections: [...host.detections, det],
      });
      changed.add(host.id);
      active[key] = { incidentId: host.id, detectionId: detId, lastPositiveTs: now, misses: 0 };
    } else {
      const dir = c.direction != null ? `-${c.direction}` : '';
      const id = uniqueId(incidents, `${prefix}-${stamp.date}-${c.route}${dir}-${stamp.hhmm}`);
      const det = buildDetection(id, c, cand.firstTs, now);
      incidents.set(id, {
        id,
        agency: 'septa',
        mode: c.mode,
        routes: [c.route],
        sources: ['bot'],
        lifecycle: {
          first_seen_ts: now,
          resolved_ts: null,
          active: true,
          duration_ms: null,
        },
        official_alert: null,
        detections: [det],
        status: null,
      });
      changed.add(id);
      active[key] = { incidentId: id, detectionId: id, lastPositiveTs: now, misses: 0 };
    }
    stats.opened++;
  }

  // Conditions that didn't show this tick: resolve after clearTicks misses.
  for (const [key, st] of Object.entries(active)) {
    if (conditions.has(key)) continue;
    st.misses = (st.misses ?? 0) + 1;
    if (st.misses === 1) st.firstMissTs = now;
    const firstMiss = st.firstMissTs ?? now;
    if (st.misses >= cfg.clearTicks && now - firstMiss >= cfg.clearMs) resolve(key, st, firstMiss);
  }

  state.candidates = nextCandidates;
  state.active = active;
  stats.active = Object.keys(active).length;
  return { changed, stats };
}
