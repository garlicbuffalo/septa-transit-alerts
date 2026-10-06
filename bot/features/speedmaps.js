// Speed maps, adapted from cta-insights (ISC): every two hours during the day,
// each account maps how fast its vehicles moved along one route or line over
// the past hour. Speeds come from consecutive positions in the minute-by-minute
// observations, binned along the route's shape (40 stretches for a bus or
// trolley route, half-mile stretches for Regional Rail); each stretch's speed
// is its total distance over total time. Routes take turns, least recently
// mapped first; a map with data for under 30% of the route is skipped.

import { METRO_LINES } from '../../src/lib/metroLines.js';
import railShapes from '../../src/lib/railLineShapes.json' with { type: 'json' };
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { clockRange } from '../lib/clock.js';
import { locateAlong, measureShape, metersBetween } from '../lib/geo.js';
import { observationsSince } from '../lib/observations.js';
import { routeShortLabel } from '../lib/routes.js';
import { firstThatFits, linkFacets } from '../lib/text.js';
import { renderSpeedMap, SPEED_BANDS } from '../map/speedMap.js';
import { nearestShape } from '../video/scenes.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SITE_HOST = new URL(SITE_ORIGIN).host;

export const SPEED_CONFIG = {
  bus: { mode: 'bus', bins: 40, maxMph: 60, maxOffM: 150, endM: 400, minVehicles: 3 },
  metro: { mode: 'metro', bins: 40, maxMph: 60, maxOffM: 150, endM: 300, minVehicles: 2 },
  rail: { mode: 'regional_rail', binM: 805, maxMph: 90, maxOffM: 400, endM: 0, minVehicles: 2 },
  minDtMs: 20_000,
  maxDtMs: 3 * 60_000,
  minCoverage: 0.3,
  // Trying this many routes before giving up for the slot.
  attempts: 6,
};
const MPH_PER_MPS = 2.23694;

/**
 * Bin speeds along a measured shape.
 * @param {Array<{ vehicle_id: string, t: number, lat: number, lon: number }>} samples
 * @returns {{ bins: Array<{ mph: number, n: number } | null>, binM: number,
 *   coverage: number, avgMph: number | null, pairs: number }}
 */
export function computeSpeeds(samples, measured, cfg) {
  const binM = cfg.binM ?? measured.length / cfg.bins;
  const count = Math.max(1, Math.ceil(measured.length / binM));
  const acc = Array.from({ length: count }, () => ({ dist: 0, dt: 0, n: 0 }));
  const byVehicle = new Map();
  for (const s of samples) {
    if (!byVehicle.has(s.vehicle_id)) byVehicle.set(s.vehicle_id, []);
    byVehicle.get(s.vehicle_id).push(s);
  }
  let pairs = 0;
  let totalDist = 0;
  let totalDt = 0;
  for (const list of byVehicle.values()) {
    list.sort((a, b) => a.t - b.t);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      const dt = b.t - a.t;
      if (dt < SPEED_CONFIG.minDtMs || dt > SPEED_CONFIG.maxDtMs) continue;
      const dist = metersBetween(a, b);
      if ((dist / (dt / 1000)) * MPH_PER_MPS > cfg.maxMph) continue;
      const loc = locateAlong(measured, { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
      if (loc.off > cfg.maxOffM) continue;
      // Layovers at the ends of the route aren't traffic.
      if (loc.along < cfg.endM || loc.along > measured.length - cfg.endM) continue;
      const bin = acc[Math.min(count - 1, Math.floor(loc.along / binM))];
      bin.dist += dist;
      bin.dt += dt;
      bin.n++;
      totalDist += dist;
      totalDt += dt;
      pairs++;
    }
  }
  const bins = acc.map((b) =>
    b.n ? { mph: (b.dist / (b.dt / 1000)) * MPH_PER_MPS, n: b.n } : null,
  );
  const eligible = acc.filter((_, i) => {
    const mid = (i + 0.5) * binM;
    return mid >= cfg.endM && mid <= measured.length - cfg.endM;
  }).length;
  return {
    bins,
    binM,
    coverage: eligible ? bins.filter(Boolean).length / eligible : 0,
    avgMph: totalDt ? (totalDist / (totalDt / 1000)) * MPH_PER_MPS : null,
    pairs,
  };
}

/** Routes of a mode seen in the window, least recently mapped first. */
export function speedCandidates(db, account, { since, cfg = SPEED_CONFIG[account] }) {
  const rows = db
    .prepare(
      `SELECT route, COUNT(DISTINCT vehicle_id) AS vehicles FROM observations
       WHERE mode = ? AND ts >= ? GROUP BY route HAVING vehicles >= ?`,
    )
    .all(cfg.mode, since, cfg.minVehicles);
  const last = new Map(
    db
      .prepare('SELECT route, MAX(ts) AS ts FROM speedmap_runs WHERE account = ? GROUP BY route')
      .all(account)
      .map((r) => [r.route, r.ts]),
  );
  return rows
    .filter((r) => account !== 'metro' || METRO_LINES[r.route])
    .sort((a, b) => (last.get(a.route) ?? 0) - (last.get(b.route) ?? 0) || b.vehicles - a.vehicles);
}

function routePageUrl(mode, route) {
  if (mode === 'regional_rail') return `${SITE_ORIGIN}/rail/line/${route}`;
  if (mode === 'metro') return `${SITE_ORIGIN}/line/${route}`;
  return `${SITE_ORIGIN}/route/${encodeURIComponent(route)}`;
}

/** Slowest or fastest of this route's maps in the past 14 days (with 3+ to compare). */
export function speedCallout(db, { account, route, avgMph, now }) {
  const prior = db
    .prepare('SELECT avg_mph FROM speedmap_runs WHERE account = ? AND route = ? AND ts >= ?')
    .all(account, route, now - 14 * DAY_MS)
    .map((r) => r.avg_mph);
  if (prior.length < 3) return null;
  if (prior.every((v) => avgMph < v)) return '📊 slowest reported in 14 days';
  if (prior.every((v) => avgMph > v)) return '📊 fastest reported in 14 days';
  return null;
}

/** Post text and alt text for a speed map. */
export function composeSpeedMap({ mode, route, direction, start, end, result, bands, callout }) {
  const label = routeShortLabel(mode, route);
  const noun = mode === 'bus' ? 'buses' : mode === 'regional_rail' ? 'trains' : 'vehicles';
  const where = mode === 'bus' ? 'route' : 'line';
  const head = `🚦 ${label}${direction ? ` — ${direction}` : ''}`;
  const stat = `${clockRange(start, end)} · average speed ${result.avgMph.toFixed(1)} mph`;
  const key = `How fast ${noun} moved along the ${where}:\n${bands.map((b) => `${b.emoji} ${b.label}`).join(' · ')}`;
  const tail = `🔗 ${SITE_HOST}`;
  const text = firstThatFits([
    [[head, stat, callout].filter(Boolean).join('\n'), key, tail].join('\n\n'),
    [[head, stat].join('\n'), key, tail].join('\n\n'),
    [head, stat].join('\n'),
  ]);
  const slow = result.bins.filter(Boolean).filter((b) => b.mph < bands[0].below).length;
  const alt =
    `Map of ${label}${direction ? ` ${direction.toLowerCase()}` : ''} colored by how fast ${noun} moved along it, ${clockRange(start, end)}, ` +
    `averaging ${result.avgMph.toFixed(1)} mph${slow ? `, with ${slow} of ${result.bins.length} stretches under ${bands[0].below} mph` : ''}. Gray stretches had no data.`;
  return {
    text,
    alt,
    facets: linkFacets(text, [{ text: SITE_HOST, uri: routePageUrl(mode, route) }]),
    title: `${label}${direction ? ` · ${direction}` : ''} · speeds ${clockRange(start, end)}`,
  };
}

/** The shape and samples to map for a route: the busier direction, on its own shape. */
function routeSamples(db, account, route, { since, shapes }) {
  const cfg = SPEED_CONFIG[account];
  const rows = observationsSince(db, { routes: [route], mode: cfg.mode, since }).map((r) => ({
    vehicle_id: r.vehicle_id,
    t: r.report_ts ?? r.ts,
    lat: r.lat,
    lon: r.lon,
    direction: r.direction,
  }));
  if (account === 'rail') {
    const shape = nearestShape(railShapes[route] ?? [], rows.slice(0, 200));
    return { samples: rows, shape, direction: null };
  }
  const byDir = new Map();
  for (const r of rows) {
    const k = r.direction ?? '';
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push(r);
  }
  const [direction, samples] = [...byDir].sort((a, b) => b[1].length - a[1].length)[0] ?? ['', []];
  const shape = nearestShape(shapes?.shapes(route) ?? [], samples.slice(0, 200));
  return { samples, shape, direction: direction || null };
}

/**
 * Map and post one route's past hour for an account ('bus', 'metro', 'rail').
 */
export async function postSpeedMap({ db, poster, shapes, basemap, account, now, log = () => {} }) {
  if (!poster.client.hasAccount(account)) return null;
  const cfg = SPEED_CONFIG[account];
  const start = now - HOUR_MS;
  const candidates = speedCandidates(db, account, { since: start });
  const bands = account === 'rail' ? SPEED_BANDS.rail : SPEED_BANDS.road;
  for (const { route } of candidates.slice(0, SPEED_CONFIG.attempts)) {
    const { samples, shape, direction } = routeSamples(db, account, route, {
      since: start,
      shapes,
    });
    if (!shape || samples.length < 10) continue;
    const measured = measureShape(shape);
    const result = computeSpeeds(samples, measured, cfg);
    if (result.coverage < SPEED_CONFIG.minCoverage || result.avgMph == null) continue;
    const callout = speedCallout(db, { account, route, avgMph: result.avgMph, now });
    const { text, alt, facets, title } = composeSpeedMap({
      mode: cfg.mode,
      route,
      direction,
      start,
      end: now,
      result,
      bands,
      callout,
    });
    let image = null;
    try {
      image = {
        data: await renderSpeedMap({
          measured,
          bins: result.bins,
          binM: result.binM,
          bands,
          title,
          basemap,
        }),
        alt,
      };
    } catch (err) {
      log(`speedmaps: map for ${route} failed: ${err.message}`);
      continue;
    }
    const res = await poster.post({
      account,
      kind: 'speedmap',
      subject: `speedmap:${account}:${route}:${now}`,
      text,
      facets,
      image,
    });
    db.prepare(
      'INSERT INTO speedmap_runs (account, route, direction, ts, avg_mph, coverage) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(account, route, direction, now, result.avgMph, result.coverage);
    return { posted: route, avgMph: Math.round(result.avgMph * 10) / 10, url: res.url };
  }
  return { skipped: 'no-route', candidates: candidates.length };
}
