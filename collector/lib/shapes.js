// Route shapes from SEPTA's GTFS (google_bus.zip: buses, trolleys, and SEPTA
// Metro): for each route and direction, the shape most of its trips follow,
// simplified to a few meters. The bot service draws its maps on these (route
// lines under gaps, bunches, and stuck vehicles) and measures positions along
// them. Built alongside the schedule index (see schedule.js) and cached as
// SHAPES_FILE next to it.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eachCsvRow } from './gtfsFiles.js';
import { classifyRoute } from './network.js';

export const SHAPES_VERSION = 1;
export const SHAPES_FILE = 'route-shapes.json';
const SIMPLIFY_M = 6;

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
 * @param {{ read(name: string): Buffer }} zip google_bus.zip
 * @returns {{ version: number, built_at: number, routes: Record<string, Record<string, number[][]>> }}
 *   routes[routeKey][direction] = [[lat, lon], …]
 */
export function buildRouteShapes(zip, now = Date.now()) {
  // Trips per (route, direction, shape): the busiest shape represents the route.
  const counts = new Map();
  eachCsvRow(zip.read('trips.txt').toString('utf8'), (r) => {
    const route = classifyRoute(r.route_id);
    if (!route || route.mode === 'regional_rail' || !r.shape_id) return;
    const key = `${route.key}|${r.direction_id || '0'}`;
    if (!counts.has(key)) counts.set(key, new Map());
    const byShape = counts.get(key);
    byShape.set(r.shape_id, (byShape.get(r.shape_id) ?? 0) + 1);
  });
  const wanted = new Map(); // shape_id → [routeKey|dir]
  for (const [key, byShape] of counts) {
    const [shapeId] = [...byShape.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!wanted.has(shapeId)) wanted.set(shapeId, []);
    wanted.get(shapeId).push(key);
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
  return { version: SHAPES_VERSION, built_at: now, routes };
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
}
