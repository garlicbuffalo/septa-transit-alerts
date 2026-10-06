// Display helpers for schedule-anchored single-train Regional Rail cancellations.
//
// The collector publishes `status: { type: 'cancellation', … }` on an incident
// when SEPTA marks exactly one scheduled train cancelled (collector/lib/
// railTrains.js). It's an incident-level fact, not alert metadata — deliberately
// NOT under `official_alert`.
// It carries the rider-facing label and the train's timetable, computed upstream —
// so the frontend stays a dumb renderer: no clock math, no "is it past?" logic
// here. We just read `state` and the scheduled times and present them.
//
// Lifecycle (set server-side):
//   'upcoming'  — announced, before the train's scheduled departure
//   'cancelled' — the scheduled departure has passed; terminal
//
// Open-ended notices ("no Paoli/Thorndale service due to police activity") carry no
// cancellation object and keep the ordinary ongoing→resolved status.

import { formatTime } from './format.js';
import { officialAlert } from './incidents.js';

/**
 * Normalize an incident's cancellation block, or null when it isn't a
 * single-train cancellation.
 * @param {object} incident
 * @returns {{state:string,isUpcoming:boolean,isCancelled:boolean,departureTs:number|null,arrivalTs:number|null,trainNumber:string|null,origin:string|null}|null}
 */
export function cancellationInfo(incident, now = Date.now()) {
  const c = incident?.status?.type === 'cancellation' ? incident.status : null;
  if (!c?.state) return null;
  const departureTs = c.scheduled_departure_ts ?? null;
  // The collector stamps `state` at export time, but between exports the wall
  // clock can cross the scheduled departure (the export only refreshes when the
  // data changes, otherwise on its backstop). When we know the departure time,
  // re-derive upcoming/cancelled from it — the same now-vs-departure check
  // collectUpcomingCancellations already uses — so the label flips on schedule
  // instead of lagging the next export. Open-ended notices with no departure
  // time keep the server-supplied state.
  const isUpcoming = departureTs != null ? departureTs > now : c.state === 'upcoming';
  return {
    state: isUpcoming ? 'upcoming' : 'cancelled',
    isUpcoming,
    isCancelled: !isUpcoming,
    departureTs,
    arrivalTs: c.scheduled_arrival_ts ?? null,
    trainNumber: c.train_number ?? null,
    origin: c.origin ?? null,
  };
}

/** Short status-pill label, e.g. 'upcoming cancellation' / 'cancelled'. */
export function cancellationStatusLabel(info) {
  if (!info) return null;
  return info.isUpcoming ? 'upcoming cancellation' : 'cancelled';
}

/**
 * The upcoming (announced-but-not-yet-departed) single-train cancellations in a
 * set of incidents, soonest first. Filtered to departures still ahead of `now`
 * (an 'upcoming' whose time has passed is finalizing server-side; don't surface
 * it as still-upcoming). Each entry is flattened for direct rendering.
 * @returns {Array<{id:string,line:string|null,trainNumber:string|null,departureTs:number,origin:string|null,headline:string|null}>}
 */
export function collectUpcomingCancellations(incidents, { now = Date.now() } = {}) {
  const out = [];
  for (const inc of incidents || []) {
    const info = cancellationInfo(inc, now);
    if (!info?.isUpcoming || info.departureTs == null || info.departureTs <= now) continue;
    out.push({
      id: inc.id,
      line: Array.isArray(inc.routes) ? (inc.routes[0] ?? null) : null,
      trainNumber: info.trainNumber,
      departureTs: info.departureTs,
      origin: info.origin,
      headline: officialAlert(inc)?.headline ?? null,
    });
  }
  return out.sort((a, b) => a.departureTs - b.departureTs);
}

/**
 * Rider-facing scheduled-time phrase for the cancelled train, e.g.
 * "8:40 PM → 10:08 PM" (full run) or "8:40 PM departure" (departure only).
 * Null when no scheduled times are known.
 */
export function cancellationSchedulePhrase(info) {
  if (!info || info.departureTs == null) return null;
  const dep = formatTime(info.departureTs);
  if (info.arrivalTs == null) return `${dep} departure`;
  return `${dep} → ${formatTime(info.arrivalTs)}`;
}
