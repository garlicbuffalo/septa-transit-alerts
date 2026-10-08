// Route shapes from SEPTA's GTFS (google_bus.zip: buses, trolleys, and SEPTA
// Metro): for each route and direction, the shape most of its trips follow,
// simplified to a few meters. The bot service draws its maps on these (route
// lines under gaps, bunches, and stuck vehicles) and measures positions along
// them. Built alongside the schedule index (see schedule.js) and cached as
// SHAPES_FILE next to it.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanStopName } from '../../src/lib/stops.js';
import { eachCsvRow, parseCsvLine } from './gtfsFiles.js';
import { classifyRoute } from './network.js';

export const SHAPES_VERSION = 1;
export const SHAPES_FILE = 'route-shapes.json';
const SIMPLIFY_M = 6;
// The shapes published for the site's route maps: one file per bus route
// under shapes/, simplified to what a map can show.
export const PUBLISHED_SHAPES_DIR = 'shapes';
const PUBLISHED_SIMPLIFY_M = 15;
const PUBLISHED_VERSION = 1;
// All the bus routes together in one file, for the site's system map: it draws
// every route at once, and fetching 150-odd shapes files for that would be
// 150-odd requests. Lines are simplified a little more than the route pages'.
export const SYSTEM_MAP_FILE = 'system-map.json';
const SYSTEM_MAP_SIMPLIFY_M = 20;
const SYSTEM_MAP_VERSION = 1;
// A route's second direction is left out when it runs along the first (the
// same street both ways), at this distance for this share of its points: at the
// system map's scale it would only draw the same line twice.
const SAME_STREET_M = 30;
const SAME_STREET_SHARE = 0.9;

const toRad = (d) => (d * Math.PI) / 180;

// Perpendicular distance (m) from p to segment a–b, in a local flat projection.
function offsetM(p, a, b) {
  const k = Math.cos(toRad(p[0]));
  const ax = a[1] * k;
  const bx = b[1] * k;
  const px = p[1] * k;
  const dx = bx - ax;
  const dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (p[0] - a[0]) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), p[0] - (a[0] + t * dy)) * 111_320;
}

/** Douglas–Peucker simplification of [lat, lon] points to `toleranceM`. */
export function simplify(points, toleranceM = SIMPLIFY_M) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let worst = -1;
    let worstD = toleranceM;
    for (let k = i + 1; k < j; k++) {
      const d = offsetM(points[k], points[i], points[j]);
      if (d > worstD) {
        worst = k;
        worstD = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([i, worst], [worst, j]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The stops of the given trips, in order: tripId → [stopId, …]. stop_times.txt
 * is ~100 MB, so it's scanned line by line and only those trips' rows are kept.
 */
function stopsOfTrips(zip, tripIds) {
  const text = zip.read('stop_times.txt').toString('utf8');
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nl = text.indexOf('\n', pos);
  const header = parseCsvLine(text.slice(pos, nl).replace(/\r$/, ''));
  const iTrip = header.indexOf('trip_id');
  const iStop = header.indexOf('stop_id');
  const iSeq = header.indexOf('stop_sequence');
  const rows = new Map(); // tripId → [[seq, stopId], …]
  pos = nl + 1;
  while (pos < text.length) {
    nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    pos = nl + 1;
    if (!line) continue;
    const cells = line.includes('"') ? parseCsvLine(line) : line.split(',');
    if (!tripIds.has(cells[iTrip])) continue;
    if (!rows.has(cells[iTrip])) rows.set(cells[iTrip], []);
    rows.get(cells[iTrip]).push([Number(cells[iSeq]), cells[iStop]]);
  }
  const out = new Map();
  for (const [tripId, list] of rows)
    out.set(
      tripId,
      list.sort((a, b) => a[0] - b[0]).map((r) => r[1]),
    );
  return out;
}

/**
 * @param {{ read(name: string): Buffer }} zip google_bus.zip
 * @returns {{ version: number, built_at: number, routes: Record<string, Record<string, number[][]>>,
 *   stops: Record<string, Record<string, Array<[number, number, string]>>> }}
 *   routes[routeKey][direction] = [[lat, lon], …];
 *   stops[routeKey][direction] = [[lat, lon, name], …] along the route (from a
 *   trip that runs the chosen shape), so they sit on the line that's drawn
 */
export function buildRouteShapes(zip, now = Date.now()) {
  // Trips per (route, direction, shape): the busiest shape represents the route.
  const counts = new Map();
  const sampleTrip = new Map(); // `${key}|${shape_id}` → a trip that runs it
  eachCsvRow(zip.read('trips.txt').toString('utf8'), (r) => {
    const route = classifyRoute(r.route_id);
    if (!route || route.mode === 'regional_rail' || !r.shape_id) return;
    const key = `${route.key}|${r.direction_id || '0'}`;
    if (!counts.has(key)) counts.set(key, new Map());
    const byShape = counts.get(key);
    byShape.set(r.shape_id, (byShape.get(r.shape_id) ?? 0) + 1);
    if (!sampleTrip.has(`${key}|${r.shape_id}`)) sampleTrip.set(`${key}|${r.shape_id}`, r.trip_id);
  });
  const wanted = new Map(); // shape_id → [routeKey|dir]
  const stopTrips = new Map(); // tripId → [routeKey|dir]
  for (const [key, byShape] of counts) {
    const [shapeId] = [...byShape.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!wanted.has(shapeId)) wanted.set(shapeId, []);
    wanted.get(shapeId).push(key);
    const trip = sampleTrip.get(`${key}|${shapeId}`);
    if (trip) {
      if (!stopTrips.has(trip)) stopTrips.set(trip, []);
      stopTrips.get(trip).push(key);
    }
  }
  const points = new Map();
  eachCsvRow(zip.read('shapes.txt').toString('utf8'), (r) => {
    if (!wanted.has(r.shape_id)) return;
    if (!points.has(r.shape_id)) points.set(r.shape_id, []);
    points
      .get(r.shape_id)
      .push([Number(r.shape_pt_sequence), Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
  });
  const routes = {};
  for (const [shapeId, keys] of wanted) {
    const pts = (points.get(shapeId) ?? [])
      .sort((a, b) => a[0] - b[0])
      .map(([, lat, lon]) => [lat, lon]);
    if (pts.length < 2) continue;
    const line = simplify(pts).map(([lat, lon]) => [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
    ]);
    for (const key of keys) {
      const [route, dir] = key.split('|');
      if (!routes[route]) routes[route] = {};
      routes[route][dir] = line;
    }
  }
  return { version: SHAPES_VERSION, built_at: now, routes, stops: buildRouteStops(zip, stopTrips) };
}

// Each route and direction's stops, in order, from its sample trip.
function buildRouteStops(zip, stopTrips) {
  const byTrip = stopsOfTrips(zip, stopTrips);
  const places = new Map(); // stop_id → [lat, lon, name]
  eachCsvRow(zip.read('stops.txt').toString('utf8'), (r) => {
    const lat = Number(r.stop_lat);
    const lon = Number(r.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) return;
    places.set(r.stop_id, [
      Math.round(lat * 1e5) / 1e5,
      Math.round(lon * 1e5) / 1e5,
      cleanStopName(r.stop_name) || r.stop_id,
    ]);
  });
  const stops = {};
  for (const [tripId, keys] of stopTrips) {
    const list = (byTrip.get(tripId) ?? []).map((id) => places.get(id)).filter(Boolean);
    if (list.length === 0) continue;
    for (const key of keys) {
      const [route, dir] = key.split('|');
      if (!stops[route]) stops[route] = {};
      stops[route][dir] = list;
    }
  }
  return stops;
}

/** Read the cached shapes (or a fixture's), or null. */
export async function loadRouteShapes({ cacheDir = null, fixturesDir = null } = {}) {
  const dir = fixturesDir ?? cacheDir;
  if (!dir) return null;
  try {
    const data = JSON.parse(await readFile(join(dir, SHAPES_FILE), 'utf8'));
    return data?.version === SHAPES_VERSION ? new RouteShapes(data) : null;
  } catch {
    return null;
  }
}

export class RouteShapes {
  constructor(data) {
    this.data = data;
  }

  /** A route's shape in one direction, or its other direction, or null. */
  shape(route, direction = 0) {
    const r = this.data.routes[route];
    if (!r) return null;
    return r[String(direction)] ?? r['0'] ?? r['1'] ?? null;
  }

  /** Every direction's shape for a route. */
  shapes(route) {
    return Object.values(this.data.routes[route] ?? {});
  }

  /** Every direction's shape for a route, as [directionId, [[lat, lon], …]] pairs. */
  directions(route) {
    return Object.entries(this.data.routes[route] ?? {});
  }

  /** A route's stops in one direction, in order: [[lat, lon, name], …] (empty if unknown). */
  stops(route, direction = '0') {
    return this.data.stops?.[route]?.[String(direction)] ?? [];
  }

  /** Every route with a shape. */
  routes() {
    return Object.keys(this.data.routes);
  }
}

/**
 * Write each bus and Metro route's shapes, and its stops where the cache has
 * them, into the data directory for the site's route and speed maps, and
 * remove the files of routes that are gone. Files whose content is unchanged
 * are left alone.
 * @param {string} dir the data directory
 * @param {RouteShapes} shapes
 * @returns {Promise<{ written: number, removed: number }>}
 */
export async function publishRouteShapes(dir, shapes) {
  const out = join(dir, PUBLISHED_SHAPES_DIR);
  await mkdir(out, { recursive: true });
  const names = new Set();
  let written = 0;
  for (const route of shapes.routes()) {
    if (classifyRoute(route)?.mode === 'regional_rail') continue;
    const directions = {};
    for (const [id, points] of shapes.directions(route)) {
      directions[id] = simplify(points, PUBLISHED_SIMPLIFY_M).map(([lat, lon]) => [
        Math.round(lat * 1e5) / 1e5,
        Math.round(lon * 1e5) / 1e5,
      ]);
    }
    const name = `${encodeURIComponent(route)}.json`;
    names.add(name);
    // Stops come from the same trips as the shapes; a cache built before the
    // collector kept them has none, and the file just leaves them out.
    const stops = {};
    for (const [id] of shapes.directions(route)) {
      const list = shapes.stops(route, id);
      if (list.length) stops[id] = list;
    }
    const file = { schema_version: PUBLISHED_VERSION, route, directions };
    if (Object.keys(stops).length) file.stops = stops;
    const body = `${JSON.stringify(file)}\n`;
    const path = join(out, name);
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === body) continue;
    await writeFile(path, body);
    written++;
  }
  let removed = 0;
  for (const name of await readdir(out)) {
    if (names.has(name)) continue;
    await rm(join(out, name), { force: true });
    removed++;
  }
  return { written, removed };
}

// Whether (nearly) all of a line's points are within `toleranceM` of one of the
// other lines.
function runsAlong(line, others, toleranceM = SAME_STREET_M) {
  const near = line.filter((p) =>
    others.some((other) =>
      other.some((q, i) => i > 0 && offsetM(p, other[i - 1], q) <= toleranceM),
    ),
  );
  return near.length >= line.length * SAME_STREET_SHARE;
}

/**
 * Write every bus route's lines into one file for the site's system map:
 * `{ schema_version, generated_at, routes: { [route]: [[[lat, lon], …], …] } }`,
 * one line per direction that doesn't just retrace the other. Metro routes are
 * left out (the site carries those itself). Left alone when unchanged.
 * @param {string} dir the data directory
 * @param {RouteShapes} shapes
 * @returns {Promise<boolean>} whether the file was written
 */
export async function publishSystemMap(dir, shapes) {
  const routes = {};
  for (const route of [...shapes.routes()].sort()) {
    if (classifyRoute(route)?.mode !== 'bus') continue;
    const lines = [];
    for (const [, points] of shapes.directions(route)) {
      const line = simplify(points, SYSTEM_MAP_SIMPLIFY_M).map(([lat, lon]) => [
        Math.round(lat * 1e5) / 1e5,
        Math.round(lon * 1e5) / 1e5,
      ]);
      if (line.length >= 2 && !runsAlong(line, lines)) lines.push(line);
    }
    if (lines.length) routes[route] = lines;
  }
  const file = {
    schema_version: SYSTEM_MAP_VERSION,
    generated_at: shapes.data.built_at,
    routes,
  };
  const body = `${JSON.stringify(file)}\n`;
  const path = join(dir, SYSTEM_MAP_FILE);
  if ((await readFile(path, 'utf8').catch(() => null)) === body) return false;
  await mkdir(dir, { recursive: true });
  await writeFile(path, body);
  return true;
}
