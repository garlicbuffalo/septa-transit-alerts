// Route and speed maps for the bus route and line pages. The data comes from
// the files the collector and the bot server publish with the rest of the data:
//
//   shapes/<route>.json   a bus route's shape in each direction (collector)
//   speeds/<route>.json   the past week's average speeds along each direction
//                         of a bus route, trolley line, or the M1 (bot server;
//                         see bot/features/speedhistory.js)
//
// Either can be missing (a route with no vehicles on SEPTA's tracker has no
// speeds; the GitHub Actions collector publishes no speeds at all), and the
// pages simply leave the map out.

import { fitMercator } from './basemap.js';
import { dataUrl } from './dataSource.js';
import { bandFor, SPEED_BANDS } from './speedBands.js';

const SUPPORTED_VERSION = 1;
// Speeds older than this are from a bot server that's gone quiet.
export const SPEEDS_STALE_MS = 3 * 24 * 60 * 60 * 1000;

async function loadJson(file) {
  try {
    const res = await fetch(dataUrl(file), { cache: 'no-cache' });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.schema_version === SUPPORTED_VERSION ? body : null;
  } catch {
    // Missing files can come back as the site's HTML page, or as nothing.
    return null;
  }
}

/** A bus route's shapes: `{ route, directions: { [id]: [[lat, lon], …] } }`, or null. */
export async function loadRouteShapes(route) {
  const file = await loadJson(`shapes/${encodeURIComponent(route)}.json`);
  return file?.directions && Object.keys(file.directions).length > 0 ? file : null;
}

/** A route's week of speeds (see speedhistory.js for the shape), or null. */
export async function loadRouteSpeeds(route, { now = Date.now() } = {}) {
  const file = await loadJson(`speeds/${encodeURIComponent(route)}.json`);
  if (!file || !Array.isArray(file.directions) || file.directions.length === 0) return null;
  if (now - file.generated_at > SPEEDS_STALE_MS) return null;
  return file;
}

const MAP_SIZE = { maxWidth: 720, maxHeight: 540, margin: 40 };

const toRad = (d) => (d * Math.PI) / 180;

/** [lat, lon] points with each one's distance from the start, in meters. */
export function measure(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const k = Math.cos(toRad((points[i][0] + points[i - 1][0]) / 2));
    cum.push(
      cum[i - 1] +
        Math.hypot(
          (points[i][0] - points[i - 1][0]) * 111_320,
          (points[i][1] - points[i - 1][1]) * 111_320 * k,
        ),
    );
  }
  return { points, cum, length: cum.at(-1) ?? 0 };
}

/** The part of a measured line between two distances along it. */
export function sliceAlong({ points, cum }, from, to) {
  const at = (d) => {
    let i = 0;
    while (i + 1 < cum.length - 1 && cum[i + 1] < d) i++;
    const seg = cum[i + 1] - cum[i] || 1;
    const t = Math.max(0, Math.min(1, (d - cum[i]) / seg));
    return [
      points[i][0] + t * (points[i + 1][0] - points[i][0]),
      points[i][1] + t * (points[i + 1][1] - points[i][1]),
    ];
  };
  const out = [at(from)];
  for (let i = 0; i < cum.length; i++) if (cum[i] > from && cum[i] < to) out.push(points[i]);
  out.push(at(to));
  return out;
}

const pathOf = (pts) => `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`;

/**
 * A route's directions projected onto map tiles.
 * @param {Record<string, number[][]>} directions
 * @returns {{ width: number, height: number, basemap: object,
 *   paths: string[], ends: Array<{ x: number, y: number }> } | null}
 */
export function buildRouteMap(directions) {
  const lines = Object.values(directions ?? {}).filter((l) => l?.length >= 2);
  const fit = fitMercator(lines.flat(), MAP_SIZE);
  if (!fit) return null;
  const projected = lines.map((l) => l.map(([lat, lon]) => fit.project(lat, lon)));
  // The two directions usually end at the same places: one dot for each.
  const ends = [];
  for (const line of projected) {
    for (const p of [line[0], line.at(-1)]) {
      if (!ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 8)) ends.push(p);
    }
  }
  return {
    width: fit.width,
    height: fit.height,
    basemap: fit.basemap,
    paths: projected.map(pathOf),
    ends,
  };
}

/**
 * One direction's week of speeds projected onto map tiles: the route's line,
 * and over it each stretch with data in its speed band's color.
 * @param {{ shape: number[][], mph: Array<number | null>, n: number[], bin_m: number }} direction
 * @param {Array<{ below: number, color: string, label: string }>} [bands]
 */
export function buildSpeedMap(direction, bands = SPEED_BANDS.road) {
  const fit = fitMercator(direction.shape, MAP_SIZE);
  if (!fit) return null;
  const measured = measure(direction.shape);
  const project = ([lat, lon]) => fit.project(lat, lon);
  const stretches = [];
  direction.mph.forEach((mph, index) => {
    if (mph == null) return;
    const from = index * direction.bin_m;
    const to = Math.min(measured.length, (index + 1) * direction.bin_m);
    if (to <= from) return;
    stretches.push({
      index,
      mph,
      readings: direction.n[index] ?? 0,
      color: bandFor(bands, mph).color,
      d: pathOf(sliceAlong(measured, from, to).map(project)),
    });
  });
  return {
    width: fit.width,
    height: fit.height,
    basemap: fit.basemap,
    base: pathOf(direction.shape.map(project)),
    stretches,
  };
}

/** The headline numbers of a direction: its average, slowest and fastest stretch. */
export function summarizeSpeeds(direction) {
  const shown = direction.mph.filter((v) => v != null);
  if (shown.length === 0) return null;
  return {
    avgMph: direction.avg_mph,
    slowestMph: Math.min(...shown),
    fastestMph: Math.max(...shown),
    slowCount: shown.filter((v) => v < SPEED_BANDS.road[0].below).length,
    shownCount: shown.length,
    readings: direction.readings,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (key) => {
  const [, m, d] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
};

/** "Oct 1 – Oct 7" for a speed file's window. */
export function speedWindowLabel(file) {
  return file.from_day === file.to_day
    ? shortDay(file.from_day)
    : `${shortDay(file.from_day)} – ${shortDay(file.to_day)}`;
}
