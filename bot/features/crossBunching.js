// Cross-route clusters: vehicles from several routes stopped together in one
// spot (a blocked street, a crash, a broken signal), which per-route
// detectors can't see. Bluesky-only — not a site incident. Adapted from
// cta-insights' cross-bunching bin (ISC), tightened for SEPTA, where many
// Center City routes share stops: at least MIN_VEHICLES vehicles from
// MIN_ROUTES routes within LINK_M of each other, MIN_STOPPED of them stopped
// for STOPPED_MIN minutes, none at the ends of their trips.

import { distanceM } from '../../collector/lib/vehicles.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { cleanStopName } from '../../src/lib/stops.js';
import { acquireCooldown } from '../lib/db.js';
import { observationsSince } from '../lib/observations.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits, linkFacets } from '../lib/text.js';
import { PALETTE, planRouteMap, renderRouteMap } from '../map/routeMap.js';
import { markPosted, postedSince, recordEvent, startOfEasternDay } from './history.js';

export const CROSS_CONFIG = {
  linkM: 200,
  minVehicles: 4,
  minRoutes: 2,
  minStopped: 3,
  stoppedMin: 4,
  stoppedMoveM: 60,
  // Trips this close to either end are laying over, not stuck.
  endStops: 2,
  cooldownMs: 60 * 60 * 1000,
  dailyCapPerPlace: 2,
  dailyCapTotal: 4,
};
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const OFF_STREET = new Set(['l1']);
const SITE_HOST = new URL(SITE_ORIGIN).host;

/** Ids of vehicles that have barely moved over the last few minutes. */
export function stoppedVehicles(db, now, cfg = CROSS_CONFIG) {
  const rows = observationsSince(db, { since: now - (cfg.stoppedMin + 2) * 60_000 });
  const byVehicle = new Map();
  for (const r of rows) {
    if (r.mode === 'regional_rail') continue;
    if (!byVehicle.has(r.vehicle_id)) byVehicle.set(r.vehicle_id, []);
    byVehicle.get(r.vehicle_id).push(r);
  }
  const out = new Set();
  for (const [id, list] of byVehicle) {
    if (list.length < 3) continue;
    const span = list.at(-1).ts - list[0].ts;
    if (span < cfg.stoppedMin * 60_000) continue;
    const moved = Math.max(...list.map((p) => distanceM(p, list[0])));
    if (moved <= cfg.stoppedMoveM) out.add(id);
  }
  return out;
}

/** Single-link clusters of vehicles within `linkM` of each other. */
export function clusters(vehicles, linkM) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < vehicles.length; i++) {
    if (seen.has(i)) continue;
    const group = [];
    const queue = [i];
    seen.add(i);
    while (queue.length) {
      const k = queue.pop();
      group.push(vehicles[k]);
      for (let j = 0; j < vehicles.length; j++) {
        if (!seen.has(j) && distanceM(vehicles[k], vehicles[j]) <= linkM) {
          seen.add(j);
          queue.push(j);
        }
      }
    }
    out.push(group);
  }
  return out;
}

/**
 * The worst qualifying cluster right now, or null.
 * @param {{ vehicles: object[], stopped: Set<string>, schedule: object | null, now: number }} opts
 */
export function findCluster({ vehicles, stopped, schedule, now, cfg = CROSS_CONFIG }) {
  const candidates = vehicles.filter((v) => {
    if (v.mode === 'regional_rail' || v.nextStopSequence == null) return false;
    // The El and the subway share no street with the buses.
    if (OFF_STREET.has(v.route)) return false;
    if (v.nextStopSequence <= cfg.endStops) return false;
    const trip = v.tripId && schedule ? schedule.tripTimes(v.tripId, now) : null;
    if (trip?.lastSequence && v.nextStopSequence >= trip.lastSequence - cfg.endStops + 1)
      return false;
    return true;
  });
  let best = null;
  for (const group of clusters(candidates, cfg.linkM)) {
    const routes = new Set(group.map((v) => v.route));
    const stoppedCount = group.filter((v) => stopped.has(v.id)).length;
    if (group.length < cfg.minVehicles || routes.size < cfg.minRoutes) continue;
    if (stoppedCount < cfg.minStopped) continue;
    if (!best || group.length > best.length) best = group;
  }
  return best;
}

function placeOf(group) {
  const lat = group.reduce((s, v) => s + v.lat, 0) / group.length;
  const lon = group.reduce((s, v) => s + v.lon, 0) / group.length;
  const names = new Map();
  for (const v of group) {
    const n = cleanStopName(v.nextStopName);
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
  }
  const name = [...names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { lat, lon, key: `${lat.toFixed(3)},${lon.toFixed(3)}`, name };
}

export function composeCluster(group, place, shapes) {
  const routes = [...new Set(group.map((v) => v.route))];
  const allBus = group.every((v) => v.mode === 'bus');
  const noun = allBus ? 'buses' : 'vehicles';
  const ordered = routes.flatMap((r) => group.filter((v) => v.route === r));
  const lines = routes.map((r) => {
    const mode = group.find((v) => v.route === r).mode;
    const list = ordered
      .map((v, i) => (v.route === r ? `#${v.label} (${KEYCAPS[i] ?? i + 1})` : null))
      .filter(Boolean);
    return `${routeShortLabel(mode, r)}: ${list.join(', ')}`;
  });
  const head = `🚍 ${group.length} ${noun} from ${routes.length} routes stopped together${place.name ? ` near ${place.name}` : ''} right now`;
  const text = firstThatFits([
    [head, lines.join('\n'), `🔗 ${SITE_HOST}`].join('\n\n'),
    [head, `🔗 ${SITE_HOST}`].join('\n\n'),
  ]);
  const colorFor = new Map(routes.map((r, i) => [r, PALETTE[i % PALETTE.length]]));
  const plan = planRouteMap({
    routes: routes.flatMap((r) =>
      (shapes?.shapes(r) ?? []).map((points) => ({ points, color: colorFor.get(r) })),
    ),
    markers: ordered.map((v, i) => ({
      lat: v.lat,
      lon: v.lon,
      tag: String(i + 1),
      color: colorFor.get(v.route),
    })),
    title: `⚠ ${group.length} ${noun} · ${routes.length} routes`,
  });
  const alt = `Map of ${group.length} ${noun} from ${routes.map((r) => routeShortLabel(group.find((v) => v.route === r).mode, r)).join(', ')} stopped together${place.name ? ` near ${place.name}` : ''}, numbered and colored by route.`;
  // The vehicles a timelapse follows, numbered and colored as on the map.
  const focus = ordered.map((v, i) => ({
    id: String(v.id),
    label: String(v.label),
    tag: String(i + 1),
    route: v.route,
    color: colorFor.get(v.route),
  }));
  return {
    text,
    facets: linkFacets(text, [{ text: SITE_HOST, uri: SITE_ORIGIN }]),
    plan,
    alt,
    focus,
    routes,
    noun,
  };
}

/**
 * Find and post the worst cross-route cluster this tick, within cooldowns
 * and daily caps.
 */
export async function postCrossBunching({
  vehicles,
  schedule,
  db,
  poster,
  shapes,
  basemap,
  timelapse = null,
  now,
  log = () => {},
}) {
  // A frozen trolley (see vehicleScreen.js) is in the tunnel, not at the fix it keeps repeating.
  const located = vehicles.filter((v) => !v.frozen);
  const group = findCluster({
    vehicles: located,
    stopped: stoppedVehicles(db, now),
    schedule,
    now,
  });
  if (!group) return null;
  const place = placeOf(group);
  const account = group.some((v) => v.mode === 'bus') ? 'bus' : 'metro';
  if (!poster.client.hasAccount(account)) return null;
  const dayStart = startOfEasternDay(now);
  const postedToday = db
    .prepare(
      "SELECT route FROM detection_events WHERE source = 'cross-bunching' AND posted = 1 AND ts >= ?",
    )
    .all(dayStart);
  if (postedToday.length >= CROSS_CONFIG.dailyCapTotal) return { skipped: 'daily-cap' };
  if (
    postedSince(db, { source: 'cross-bunching', route: place.key, since: dayStart }).length >=
    CROSS_CONFIG.dailyCapPerPlace
  ) {
    return { skipped: 'place-cap' };
  }
  if (!acquireCooldown(db, [`xbunch:${place.key}`], now, CROSS_CONFIG.cooldownMs)) {
    return { skipped: 'cooldown' };
  }
  const subject = `xbunch:${place.key}:${now}`;
  recordEvent(db, {
    subject,
    source: 'cross-bunching',
    mode: account,
    route: place.key,
    metric: group.length,
    near: place.name,
    lat: place.lat,
    lon: place.lon,
    ts: now,
  });
  const { text, facets, plan, alt, focus, routes, noun } = composeCluster(group, place, shapes);
  let image = null;
  try {
    image = { data: await renderRouteMap(plan, { basemap }), alt };
  } catch (err) {
    log(`cross-bunching: map failed: ${err.message}`);
  }
  const post = await poster.post({
    account,
    kind: 'cross-bunching',
    subject,
    text,
    facets,
    highlight: 'cluster',
    ...(image && { image }),
  });
  markPosted(db, subject, now);
  if (timelapse && image) {
    try {
      timelapse({
        kind: 'cluster',
        subject,
        account,
        mode: account,
        routes,
        title: plan.title.replace(/^⚠\s*/, ''),
        header: `🎬 ${place.name ? `Near ${place.name}` : 'The cluster'} · the next 10 minutes`,
        noun,
        vehicles: focus,
        post,
        now,
      });
    } catch (err) {
      log(`cross-bunching: starting the timelapse failed: ${err.message}`);
    }
  }
  return { posted: 1, vehicles: group.length };
}
