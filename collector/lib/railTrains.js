// Regional Rail delays and cancellations, observed from SEPTA's TrainView feed.
//
// TrainView lists every train currently running plus the day's cancelled
// trains, each with the line it is on, its origin (`SOURCE`), destination, and
// minutes late — `999` is SEPTA's marker for a cancelled train. From that the
// collector records two bot-detected incident kinds, mirroring the commuter
// rail detectors of the Chicago project this site is modeled on:
//
//   delay         a train running DELAY_THRESHOLD_MIN+ late. Stays active while
//                 the train is still late, resolves once it recovers below
//                 DELAY_CLEAR_MIN or leaves the feed (arrived). One incident per
//                 train per service day.
//   cancellation  a train SEPTA marked cancelled. "Upcoming" (active) until its
//                 scheduled departure, then a closed point event — a cancelled
//                 train never un-cancels.
//
// Each new incident looks the train up in RRSchedules once to anchor it to its
// scheduled departure ("the 5:10 PM Wawa to Doylestown train").
import { railKeyForTrainViewLine } from './network.js';
import { canonicalRailStation } from './stations.js';
import { parseServiceClock, serviceDateKey } from './time.js';

export const DELAY_THRESHOLD_MIN = 15;
export const DELAY_CLEAR_MIN = 10;
export const CANCELLED_LATE = 999;
// A new delay update is logged each time lateness grows by this much.
const UPDATE_STEP_MIN = 10;
const MIN_MS = 60 * 1000;
// With an empty feed (overnight, or an outage), only time out delays whose
// train hasn't been seen for this long.
const STALE_DELAY_MS = 90 * MIN_MS;

const clockFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
});

/** "5:10 PM" in Philadelphia time. */
export function formatClock(ts) {
  return clockFmt.format(new Date(ts));
}

// "the 5:10 PM Wawa to Doylestown train (#3556)" — degrades gracefully when the
// schedule lookup or a station name is missing.
function trainPhrase({ trainNo, origin, dest, departureTs }) {
  const time = departureTs != null ? `${formatClock(departureTs)} ` : '';
  if (origin && dest && origin !== dest)
    return `the ${time}${origin} to ${dest} train (#${trainNo})`;
  if (origin) return `the ${time}train from ${origin} (#${trainNo})`;
  if (dest) return `the ${time}train to ${dest} (#${trainNo})`;
  return `train #${trainNo}`;
}

/**
 * Scheduled departure (at `origin`) and final arrival for a train, from its
 * RRSchedules rows on the given service date. Returns nulls when the schedule
 * is unavailable.
 * @param {Array<{ station: string, sched_tm: string }>} rows
 * @param {string | null} origin Roster name of the station the train starts from.
 * @param {string[]} lines
 * @param {string} day Service date "YYYY-MM-DD".
 */
export function scheduleAnchors(rows, origin, lines, day) {
  if (!Array.isArray(rows) || rows.length === 0) return { departureTs: null, arrivalTs: null };
  const at = (row) => parseServiceClock(row?.sched_tm, day);
  const originRow =
    (origin && rows.find((r) => canonicalRailStation(r.station, lines) === origin)) || rows[0];
  return { departureTs: at(originRow), arrivalTs: at(rows[rows.length - 1]) };
}

async function safeSchedule(lookup, trainNo) {
  if (!lookup) return [];
  try {
    return await lookup(trainNo);
  } catch {
    return [];
  }
}

function detectionScope(lineKey, origin, dest) {
  return {
    route: lineKey,
    from_station: origin,
    to_station: dest,
    stations: [],
    direction: null,
    direction_label: dest ? `toward ${dest}` : null,
  };
}

function addRoute(routes, key) {
  return routes.includes(key) ? routes : [...routes, key];
}

// --- Delays ------------------------------------------------------------------
function delayDescription(meta, lateMin) {
  return `~${lateMin} min late — ${trainPhrase(meta)}`;
}

function openDelay({ id, trainNo, lineKey, origin, dest, stop, late, service, sched }, now) {
  const meta = { trainNo, origin, dest, departureTs: sched.departureTs };
  const description = delayDescription(meta, late);
  return {
    id,
    agency: 'septa',
    mode: 'regional_rail',
    routes: [lineKey],
    sources: ['bot'],
    lifecycle: { first_seen_ts: now, resolved_ts: null, active: true, duration_ms: null },
    official_alert: null,
    detections: [
      {
        id,
        source: 'delay',
        scope: detectionScope(lineKey, origin, dest),
        lifecycle: {
          first_seen_ts: now,
          onset_ts: null,
          resolved_ts: null,
          active: true,
          duration_ms: null,
        },
        post_url: null,
        resolved_post_url: null,
        description,
        evidence: {
          train_number: trainNo,
          signals: null,
          details: {
            late_min: late,
            max_late_min: late,
            last_stop: stop,
            last_seen_ts: now,
            service: service || null,
          },
          bullets: [],
          onset_description: null,
          updates: [
            {
              ts: now,
              description: `${late} min late${stop ? ` at ${stop}` : ''}`,
              post_url: null,
              evidence: { late_min: late, stop },
            },
          ],
        },
      },
    ],
    status: {
      type: 'delay',
      train_number: trainNo,
      delay_min: late,
      origin,
      scheduled_departure_ts: sched.departureTs,
      scheduled_arrival_ts: sched.arrivalTs,
    },
  };
}

function updateDelay(inc, { lineKey, stop, late }, now) {
  const det = inc.detections[0];
  const details = det.evidence.details;
  const maxLate = Math.max(details.max_late_min ?? 0, late);
  const updates = [...(det.evidence.updates ?? [])];
  const lastLogged = updates.length ? (updates[updates.length - 1].evidence?.late_min ?? 0) : 0;
  const reopened = !inc.lifecycle.active;
  if (reopened || late >= lastLogged + UPDATE_STEP_MIN) {
    updates.push({
      ts: now,
      description: `${late} min late${stop ? ` at ${stop}` : ''}`,
      post_url: null,
      evidence: { late_min: late, stop },
    });
  }
  const meta = {
    trainNo: det.evidence.train_number,
    origin: det.scope.from_station,
    dest: det.scope.to_station,
    departureTs: inc.status?.scheduled_departure_ts ?? null,
  };
  const lifecycle = {
    first_seen_ts: inc.lifecycle.first_seen_ts,
    resolved_ts: null,
    active: true,
    duration_ms: null,
  };
  return {
    ...inc,
    routes: addRoute(inc.routes, lineKey),
    lifecycle,
    detections: [
      {
        ...det,
        lifecycle: { ...det.lifecycle, resolved_ts: null, active: true, duration_ms: null },
        description: delayDescription(meta, maxLate),
        evidence: {
          ...det.evidence,
          details: {
            ...details,
            late_min: late,
            max_late_min: maxLate,
            last_stop: stop,
            last_seen_ts: now,
          },
          updates,
        },
      },
    ],
    status: { ...inc.status, delay_min: maxLate },
  };
}

function resolveDelay(inc, now) {
  const first = inc.lifecycle.first_seen_ts;
  const resolved = Math.max(first, now);
  const det = inc.detections[0];
  return {
    ...inc,
    lifecycle: {
      first_seen_ts: first,
      resolved_ts: resolved,
      active: false,
      duration_ms: resolved - first,
    },
    detections: [
      {
        ...det,
        lifecycle: {
          ...det.lifecycle,
          resolved_ts: resolved,
          active: false,
          duration_ms: resolved - det.lifecycle.first_seen_ts,
        },
      },
    ],
  };
}

// --- Cancellations -----------------------------------------------------------
function openCancellation({ id, trainNo, lineKey, origin, dest, sched }, now) {
  const upcoming = sched.departureTs != null && sched.departureTs > now;
  const resolved = upcoming ? null : now;
  const lifecycle = {
    first_seen_ts: now,
    resolved_ts: resolved,
    active: upcoming,
    duration_ms: upcoming ? null : 0,
  };
  const description = `Canceled — ${trainPhrase({ trainNo, origin, dest, departureTs: sched.departureTs })}`;
  return {
    id,
    agency: 'septa',
    mode: 'regional_rail',
    routes: [lineKey],
    sources: ['bot'],
    lifecycle,
    official_alert: null,
    detections: [
      {
        id,
        source: 'cancellation',
        scope: detectionScope(lineKey, origin, dest),
        lifecycle: { ...lifecycle, onset_ts: sched.departureTs },
        post_url: null,
        resolved_post_url: null,
        description,
        evidence: {
          train_number: trainNo,
          signals: null,
          details: null,
          bullets: [],
          onset_description: null,
        },
      },
    ],
    status: {
      type: 'cancellation',
      state: upcoming ? 'upcoming' : 'cancelled',
      train_number: trainNo,
      scheduled_departure_ts: sched.departureTs,
      scheduled_arrival_ts: sched.arrivalTs,
      origin,
    },
  };
}

/**
 * Close any "upcoming" cancellation whose scheduled departure has passed. Pure
 * time progression — runs every tick, even when TrainView is unreachable.
 * @returns {Set<string>} ids changed
 */
export function advanceCancellations(incidents, now) {
  const changed = new Set();
  for (const inc of incidents.values()) {
    if (inc.status?.type !== 'cancellation' || inc.status.state !== 'upcoming') continue;
    const dep = inc.status.scheduled_departure_ts;
    if (dep == null || dep > now) continue;
    const first = inc.lifecycle.first_seen_ts;
    const resolved = Math.max(first, dep);
    const lifecycle = {
      first_seen_ts: first,
      resolved_ts: resolved,
      active: false,
      duration_ms: resolved - first,
    };
    incidents.set(inc.id, {
      ...inc,
      lifecycle,
      detections: inc.detections.map((d) => ({
        ...d,
        lifecycle: { ...d.lifecycle, ...lifecycle },
      })),
      status: { ...inc.status, state: 'cancelled' },
    });
    changed.add(inc.id);
  }
  return changed;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Apply one successful TrainView fetch (mutates `incidents`).
 * @param {Map<string, object>} incidents
 * @param {object[]} trains TrainView records
 * @param {number} now
 * @param {{ lookupSchedule?: (trainNo: string) => Promise<object[]> }} [opts]
 * @returns {Promise<{ changed: Set<string>, stats: object }>}
 */
export async function applyTrainView(incidents, trains, now, { lookupSchedule } = {}) {
  const changed = new Set();
  const stats = { trains: 0, delays: 0, cancellations: 0, opened: 0, resolved: 0 };
  const day = serviceDateKey(now);
  const present = new Set();
  const set = (id, next) => {
    const prev = incidents.get(id);
    if (!prev || !same(prev, next)) {
      incidents.set(id, next);
      changed.add(id);
    }
  };

  for (const t of Array.isArray(trains) ? trains : []) {
    const trainNo = String(t?.trainno ?? '').trim();
    const lineKey = railKeyForTrainViewLine(t?.line);
    const late = Number(t?.late);
    if (!trainNo || !lineKey || !Number.isFinite(late)) continue;
    stats.trains += 1;
    present.add(trainNo);
    const origin = canonicalRailStation(t.SOURCE, [lineKey]);
    const dest = canonicalRailStation(t.dest, [lineKey]);
    const stop = canonicalRailStation(t.currentstop || t.nextstop, [lineKey]);

    if (late === CANCELLED_LATE) {
      stats.cancellations += 1;
      const id = `cancel-${day}-${trainNo}`;
      const existing = incidents.get(id);
      if (existing) {
        set(id, { ...existing, routes: addRoute(existing.routes, lineKey) });
        continue;
      }
      const rows = await safeSchedule(lookupSchedule, trainNo);
      const sched = scheduleAnchors(rows, origin, [lineKey], day);
      set(id, openCancellation({ id, trainNo, lineKey, origin, dest, sched }, now));
      stats.opened += 1;
      continue;
    }

    const id = `delay-${day}-${trainNo}`;
    const existing = incidents.get(id);
    if (late >= DELAY_THRESHOLD_MIN) {
      stats.delays += 1;
      if (existing) {
        set(id, updateDelay(existing, { lineKey, stop, late }, now));
      } else {
        const rows = await safeSchedule(lookupSchedule, trainNo);
        const sched = scheduleAnchors(rows, origin, [lineKey], day);
        set(
          id,
          openDelay(
            { id, trainNo, lineKey, origin, dest, stop, late, service: t.service, sched },
            now,
          ),
        );
        stats.opened += 1;
      }
    } else if (existing?.lifecycle?.active && late < DELAY_CLEAR_MIN) {
      set(id, resolveDelay(existing, now));
      stats.resolved += 1;
    }
  }

  // Active delays whose train left the feed have arrived (or terminated). With
  // an empty feed, only time out ones not seen recently.
  const feedEmpty = present.size === 0;
  for (const inc of [...incidents.values()]) {
    if (inc.status?.type !== 'delay' || !inc.lifecycle?.active) continue;
    const trainNo = inc.status.train_number;
    if (present.has(trainNo) && inc.id.startsWith(`delay-${day}-`)) continue;
    const lastSeen =
      inc.detections[0]?.evidence?.details?.last_seen_ts ?? inc.lifecycle.first_seen_ts;
    if (feedEmpty && now - lastSeen < STALE_DELAY_MS) continue;
    set(inc.id, resolveDelay(inc, feedEmpty ? lastSeen : now));
    stats.resolved += 1;
  }

  for (const id of advanceCancellations(incidents, now)) changed.add(id);
  return { changed, stats };
}
