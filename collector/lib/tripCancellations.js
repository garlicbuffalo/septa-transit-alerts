// Bus and SEPTA Metro trip cancellations, from SEPTA's GTFS-realtime
// TripUpdates feed. SEPTA publishes each day's cancelled trips — often hours
// ahead, when a run has no operator — as CANCELED trip updates carrying only
// the GTFS trip_id; the schedule index supplies when and where each trip runs.
//
// One incident per route per service day ("Route 16: 14 trips cancelled
// today"), id `trip-cancellations-<YYYY-MM-DD>-<route>`. It stays active until
// the last cancelled trip's scheduled end and records each change in count as
// an update. A trip that drops out of the feed before its scheduled start was
// reinstated and is removed; one that drops out afterwards stays counted.
import { classifyRoute } from './network.js';
import { formatClock } from './railTrains.js';
import { vehicleNoun } from './vehicles.js';

export const TRIP_CANCELLATIONS = 'trip-cancellations';
const MAX_UPDATES = 12;

const pad = (n) => String(n).padStart(2, '0');
const dateKey = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;

function routeLabel(mode, route) {
  return mode === 'bus' ? `Route ${route.replace(/-/g, ' ')}` : route.toUpperCase();
}

function describe(mode, route, trips, scheduled) {
  const n = trips.length;
  const noun = mode === 'bus' ? 'trip' : `${vehicleNoun(mode, route, false)} trip`;
  const upcoming = trips.slice(0, 3).map((t) => formatClock(t.start_ts));
  const more = n > 3 ? `, and ${n - 3} more` : '';
  const of = scheduled ? ` (${n} of ${scheduled} scheduled)` : '';
  return `${n} ${routeLabel(mode, route)} ${noun}${n === 1 ? '' : 's'} cancelled — ${upcoming.join(', ')}${more}${of}`;
}

function bullet(n, scheduled) {
  return scheduled
    ? `${n} of ${scheduled} scheduled trips cancelled`
    : `${n} scheduled trip${n === 1 ? '' : 's'} cancelled`;
}

function lifecycleFor(firstSeen, trips, now) {
  const lastEnd = Math.max(...trips.map((t) => t.end_ts), firstSeen);
  const active = trips.length > 0 && lastEnd > now;
  const resolved = active ? null : Math.max(firstSeen, trips.length ? lastEnd : now);
  return {
    first_seen_ts: firstSeen,
    resolved_ts: resolved,
    active,
    duration_ms: active ? null : resolved - firstSeen,
  };
}

function build(existing, { id, mode, route, service_date, trips, scheduled, now, update }) {
  const firstSeen = existing?.lifecycle?.first_seen_ts ?? now;
  const lifecycle = lifecycleFor(firstSeen, trips, now);
  const prev = existing?.detections?.[0];
  const updates = [...(prev?.evidence?.updates ?? [])];
  if (update) updates.push({ ts: now, description: update, post_url: null, evidence: null });
  const description =
    trips.length > 0
      ? describe(mode, route, trips, scheduled)
      : `${routeLabel(mode, route)}: cancelled trips reinstated`;
  return {
    id,
    agency: 'septa',
    mode,
    routes: [route],
    sources: ['bot'],
    lifecycle,
    official_alert: null,
    detections: [
      {
        id,
        source: TRIP_CANCELLATIONS,
        scope: {
          route,
          from_station: null,
          to_station: null,
          stations: [],
          direction: null,
          direction_label: null,
        },
        lifecycle: { ...lifecycle, onset_ts: null },
        // Bluesky links, filled in by the bot service; kept across rebuilds.
        post_url: prev?.post_url ?? null,
        resolved_post_url: prev?.resolved_post_url ?? null,
        description,
        evidence: {
          train_number: null,
          signals: null,
          details: {
            kind: TRIP_CANCELLATIONS,
            service_date,
            cancelled: trips.length,
            scheduled: scheduled || null,
            trips,
          },
          bullets: [bullet(trips.length, scheduled)],
          onset_description: null,
          updates: updates.slice(-MAX_UPDATES),
        },
      },
    ],
    status: null,
  };
}

/**
 * Apply one successful TripUpdates fetch (mutates `incidents`).
 * @param {Map<string, object>} incidents
 * @param {{ trips: Array<{ tripId: string, relationship: string }> }} feed decodeTripUpdates() output
 * @param {import('./schedule.js').Schedule} schedule
 * @param {number} now
 * @returns {{ changed: Set<string>, stats: object }}
 */
export function applyTripCancellations(incidents, feed, schedule, now) {
  const changed = new Set();
  const stats = { cancelled: 0, unmatched: 0, routes: 0, reinstated: 0 };

  // Group today's cancelled trips by route and service date.
  const groups = new Map();
  for (const t of feed.trips) {
    if (t.relationship !== 'CANCELED') continue;
    const trip = schedule.tripTimes(t.tripId, now);
    if (!trip) {
      stats.unmatched++;
      continue;
    }
    stats.cancelled++;
    const mode = classifyRoute(trip.route)?.mode === 'metro' ? 'metro' : 'bus';
    const service_date = dateKey(trip.date);
    const id = `${TRIP_CANCELLATIONS}-${service_date}-${trip.route}`;
    if (!groups.has(id)) {
      groups.set(id, { id, mode, route: trip.route, service_date, date: trip.date, trips: [] });
    }
    groups.get(id).trips.push({
      trip_id: trip.tripId,
      direction: trip.direction,
      start_ts: trip.startTs,
      end_ts: trip.endTs,
      origin: trip.origin,
      destination: trip.destination,
    });
  }
  stats.routes = groups.size;

  // Reconcile with what's already recorded: add new trips, drop reinstated
  // ones (gone from the feed before they were due to start), keep past ones.
  for (const inc of incidents.values()) {
    const det = inc.detections?.[0];
    if (det?.source !== TRIP_CANCELLATIONS || !inc.lifecycle?.active) continue;
    if (!groups.has(inc.id)) {
      groups.set(inc.id, {
        id: inc.id,
        mode: inc.mode,
        route: inc.routes[0],
        service_date: det.evidence.details.service_date,
        trips: [],
      });
    }
  }

  for (const g of groups.values()) {
    const existing = incidents.get(g.id) ?? null;
    const prevTrips = existing?.detections?.[0]?.evidence?.details?.trips ?? [];
    const listed = new Set(g.trips.map((t) => t.trip_id));
    const kept = prevTrips.filter((t) => !listed.has(t.trip_id) && t.start_ts <= now);
    const reinstated = prevTrips.filter((t) => !listed.has(t.trip_id) && t.start_ts > now);
    stats.reinstated += reinstated.length;
    const trips = [...g.trips, ...kept].sort((a, b) => a.start_ts - b.start_ts);
    if (!existing && trips.length === 0) continue;

    const scheduled =
      existing?.detections?.[0]?.evidence?.details?.scheduled ??
      (g.date ? schedule.scheduledTripCount(g.route, g.date) : 0);
    const added = trips.filter((t) => !prevTrips.some((p) => p.trip_id === t.trip_id)).length;
    // The opening count is the detection itself; updates record later changes.
    let update = null;
    if (existing && added && reinstated.length)
      update = `${added} more cancelled, ${reinstated.length} reinstated (${trips.length} total)`;
    else if (existing && added)
      update = `${added} more trip${added === 1 ? '' : 's'} cancelled (${trips.length} total)`;
    else if (existing && reinstated.length)
      update = `${reinstated.length} trip${reinstated.length === 1 ? '' : 's'} reinstated (${trips.length} still cancelled)`;

    const next = build(existing, { ...g, trips, scheduled, now, update });
    if (!existing || JSON.stringify(existing) !== JSON.stringify(next)) {
      incidents.set(g.id, next);
      changed.add(g.id);
    }
  }
  return { changed, stats };
}

/**
 * Close any active trip-cancellation incident whose last cancelled trip has
 * run its scheduled course. Pure time progression — runs every tick, even when
 * the TripUpdates feed is unreachable.
 * @returns {Set<string>} ids changed
 */
export function advanceTripCancellations(incidents, now) {
  const changed = new Set();
  for (const inc of incidents.values()) {
    const det = inc.detections?.[0];
    if (det?.source !== TRIP_CANCELLATIONS || !inc.lifecycle?.active) continue;
    const trips = det.evidence?.details?.trips ?? [];
    const lifecycle = lifecycleFor(inc.lifecycle.first_seen_ts, trips, now);
    if (lifecycle.active) continue;
    incidents.set(inc.id, {
      ...inc,
      lifecycle,
      detections: [{ ...det, lifecycle: { ...lifecycle, onset_ts: null } }],
    });
    changed.add(inc.id);
  }
  return changed;
}
