// The system map's data: the three modes it can show, each one's lines and
// stations as the lines and stops an InteractiveMap draws, and the `?modes=`
// the page keeps in the URL. Metro and Regional Rail are drawn from the data
// bundled with the site; bus routes come from the collector's system-map.json
// (see routeMaps.js), so they're built from whatever that file holds.

import { busRouteDisplayId, busRouteName, compareBusRoutes } from './busRoutes.js';
import metroLineShapes from './metroLineShapes.json' with { type: 'json' };
import { METRO_LINE_ORDER, METRO_LINES } from './metroLines.js';
import metroStations from './metroStations.json' with { type: 'json' };
import railLineShapes from './railLineShapes.json' with { type: 'json' };
import { RAIL_LINE_ORDER, RAIL_LINES, railLineFullName } from './railLines.js';
import railStations from './railStations.json' with { type: 'json' };
import { displayStationName } from './stations.js';

export const MAP_MODES = [
  { key: 'metro', label: 'SEPTA Metro' },
  { key: 'bus', label: 'Bus' },
  { key: 'rail', label: 'Regional Rail' },
];
export const MAP_MODE_KEYS = MAP_MODES.map((m) => m.key);

// Bus routes are many and thin: a pale line that sets the street grid and doesn't
// compete with the lines that carry the brand colors. Regional Rail is SEPTA's
// one slate, lightened to read on the dark map.
export const BUS_COLOR = '#aab4c3';
export const RAIL_COLOR = '#74a9c8';
const WEIGHTS = { metro: 4.5, rail: 3.25, bus: 1.75 };
const BUS_OPACITY = 0.7;
// What is drawn under what: buses, then Regional Rail, then Metro.
const DRAW_ORDER = ['bus', 'rail', 'metro'];
// A selected route is drawn again over everything, wider, in white.
const SELECTED_COLOR = '#ffffff';
const SELECTED_EXTRA = 3;

// Stations appear once the map is zoomed to about where Center City's stop apart.
export const STATION_ZOOM = 12;

/**
 * Metro's Market-Frankford, Broad Street, trolley, and other lines, grouped the
 * way their colors are, for the legend.
 */
export const METRO_LEGEND = [
  { label: 'L1', name: 'Market-Frankford', line: 'l1' },
  { label: 'B1–B3', name: 'Broad Street', line: 'b1' },
  { label: 'M1', name: 'Norristown', line: 'm1' },
  { label: 'T1–T5', name: 'Subway-surface trolleys', line: 't1' },
  { label: 'G1', name: 'Girard', line: 'g1' },
  { label: 'D1–D2', name: 'Media and Sharon Hill', line: 'd1' },
].map((e) => ({ ...e, color: METRO_LINES[e.line].color }));

/**
 * A route and every line it's drawn with. A layer's `routes` maps a route id to
 * `{ id, mode, label, name, href, color, textColor }`; its `lines` are the
 * InteractiveMap lines, each with the `routeId` it belongs to.
 * @typedef {{ lines: Array<object>, routes: Map<string, object> }} Layer
 */

function addRoute(layer, route, polylines, style) {
  // `order` is where the route comes in its mode, for listing routes in the site's order.
  layer.routes.set(route.id, { ...route, order: layer.routes.size });
  polylines.forEach((points, i) => {
    if (!(points?.length >= 2)) return;
    layer.lines.push({
      id: `${route.id}:${i}`,
      routeId: route.id,
      points,
      color: style.color,
      weight: style.weight,
      opacity: style.opacity,
      casing: style.casing,
      tip: route.tip,
    });
  });
}

/** SEPTA Metro's lines, from the bundled track shapes. @returns {Layer} */
export function buildMetroLayer() {
  const layer = { lines: [], routes: new Map() };
  for (const key of METRO_LINE_ORDER) {
    const info = METRO_LINES[key];
    const polylines = metroLineShapes[key] ?? [];
    if (!info || polylines.length === 0) continue;
    const name = `${info.label} ${info.name}`;
    const route = {
      id: `metro:${key}`,
      mode: 'metro',
      label: info.label,
      name: info.name,
      href: `/line/${key}`,
      color: info.color,
      textColor: info.textColor,
      tip: name,
    };
    addRoute(layer, route, polylines, { color: info.color, weight: WEIGHTS.metro, casing: true });
  }
  // The routes are listed in the site's order, but drawn in the reverse of it: the
  // subways (L1, then the B lines) end up on top, so where a trolley crosses one,
  // the subway is what is shown and what a click or tap gets.
  layer.lines = [...layer.routes.keys()]
    .reverse()
    .flatMap((id) => layer.lines.filter((l) => l.routeId === id));
  return layer;
}

/** Regional Rail's lines, from the bundled track shapes. @returns {Layer} */
export function buildRailLayer() {
  const layer = { lines: [], routes: new Map() };
  for (const key of RAIL_LINE_ORDER) {
    const info = RAIL_LINES[key];
    const polylines = railLineShapes[key] ?? [];
    if (!info || polylines.length === 0) continue;
    const route = {
      id: `rail:${key}`,
      mode: 'rail',
      label: info.code,
      name: railLineFullName(key),
      href: `/rail/line/${key}`,
      color: info.color,
      textColor: info.textColor,
      tip: `${railLineFullName(key)} (Regional Rail)`,
    };
    addRoute(layer, route, polylines, { color: RAIL_COLOR, weight: WEIGHTS.rail, casing: true });
  }
  return layer;
}

/**
 * Bus routes from the collector's system-map.json `routes`, in route order.
 * @param {Record<string, number[][][]> | null | undefined} routes
 * @returns {Layer}
 */
export function buildBusLayer(routes) {
  const layer = { lines: [], routes: new Map() };
  for (const key of Object.keys(routes ?? {}).sort(compareBusRoutes)) {
    const polylines = routes[key];
    if (!Array.isArray(polylines) || polylines.length === 0) continue;
    const label = `Route ${busRouteDisplayId(key)}`;
    const name = busRouteName(key);
    const route = {
      id: `bus:${key}`,
      mode: 'bus',
      label: busRouteDisplayId(key),
      name: name ?? label,
      href: `/route/${encodeURIComponent(key)}`,
      color: BUS_COLOR,
      textColor: '#1e293b',
      tip: name ? `${label} · ${name}` : label,
    };
    addRoute(layer, route, polylines, {
      color: BUS_COLOR,
      weight: WEIGHTS.bus,
      opacity: BUS_OPACITY,
      casing: false,
    });
  }
  return layer;
}

export const METRO_LAYER = buildMetroLayer();
export const RAIL_LAYER = buildRailLayer();

/**
 * The lines to draw for the chosen modes, bottom to top.
 * @param {{ metro?: Layer, bus?: Layer | null, rail?: Layer }} layers
 * @param {string[]} modes
 */
export function visibleLines(layers, modes) {
  const lines = [];
  for (const mode of DRAW_ORDER) {
    if (modes.includes(mode) && layers[mode]) lines.push(...layers[mode].lines);
  }
  return lines;
}

/**
 * Lines that draw the given routes again over everything else, wider, in white.
 * @param {Array<object>} lines the lines of `visibleLines`
 * @param {string[]} routeIds
 */
export function highlightLines(lines, routeIds) {
  if (routeIds.length === 0) return [];
  const wanted = new Set(routeIds);
  return lines
    .filter((l) => wanted.has(l.routeId))
    .map((l) => ({
      id: `selected:${l.id}`,
      routeId: l.routeId,
      points: l.points,
      color: SELECTED_COLOR,
      weight: (l.weight ?? 5) + SELECTED_EXTRA,
      casing: true,
    }));
}

// --- What is at a point ---------------------------------------------------------
// Hovering or tapping the map asks which routes run there. A line is hit only
// by a pointer right on it, and buses are thin, so this looks at every route
// with a line within a few pixels of the pointer instead of only the topmost.

const M_PER_DEG = 111_320;
const boundsCache = new WeakMap();

function boundsOf(line) {
  let b = boundsCache.get(line);
  if (!b) {
    let south = 90;
    let north = -90;
    let west = 180;
    let east = -180;
    for (const [lat, lon] of line.points) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
    }
    b = [south, west, north, east];
    boundsCache.set(line, b);
  }
  return b;
}

// Whether a polyline passes within `tolerance` meters of (lat, lon), measured in a
// flat projection around the point.
function passesWithin(points, lat, lon, kLon, tolerance) {
  for (let i = 1; i < points.length; i++) {
    const ax = (points[i - 1][1] - lon) * M_PER_DEG * kLon;
    const ay = (points[i - 1][0] - lat) * M_PER_DEG;
    const dx = (points[i][1] - lon) * M_PER_DEG * kLon - ax;
    const dy = (points[i][0] - lat) * M_PER_DEG - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    if (Math.hypot(ax + t * dx, ay + t * dy) <= tolerance) return true;
  }
  return false;
}

/**
 * The routes with a line within `toleranceM` meters of a point, each once.
 * @param {Array<object>} lines the lines of `visibleLines`
 * @returns {string[]} route ids
 */
export function routesNear(lines, lat, lon, toleranceM) {
  const kLon = Math.cos((lat * Math.PI) / 180);
  const dLat = toleranceM / M_PER_DEG;
  const dLon = toleranceM / (M_PER_DEG * kLon);
  const found = new Set();
  for (const line of lines) {
    if (found.has(line.routeId)) continue;
    const [south, west, north, east] = boundsOf(line);
    if (lat < south - dLat || lat > north + dLat || lon < west - dLon || lon > east + dLon)
      continue;
    if (passesWithin(line.points, lat, lon, kLon, toleranceM)) found.add(line.routeId);
  }
  return [...found];
}

const MODE_RANK = { metro: 0, rail: 1, bus: 2 };

/** Routes in the order to list them: Metro, then Regional Rail, then buses, each in the site's order. */
export function sortRoutes(routes) {
  return [...routes].sort((a, b) => MODE_RANK[a.mode] - MODE_RANK[b.mode] || a.order - b.order);
}

/**
 * Where a card of `w` by `h` pixels goes next to a point in a frame: to the right of
 * the point, else the left; under it, else over it; and kept inside the frame. A
 * frame that runs off the bottom of the screen (under a phone's tab bar, or below
 * the fold) is cut off there by `hiddenBelow`, so the card stays where it can be seen.
 * @param {{ x: number, y: number, width: number, height: number }} at the point, in the frame
 * @param {{ w: number, h: number, gap?: number, margin?: number, hiddenBelow?: number }} card
 * @returns {{ left: number, top: number }}
 */
export function placeCard(
  { x, y, width, height },
  { w, h, gap = 14, margin = 6, hiddenBelow = 0 },
) {
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  let left = x + gap;
  if (left + w > width - margin) left = x - gap - w;
  left = clamp(left, margin, width - w - margin);
  const floor = height - hiddenBelow - margin;
  let top = y + gap;
  if (top + h > floor) top = y - gap - h;
  top = clamp(top, margin, floor - h);
  return { left, top };
}

// Metro and rail stations as the stops an InteractiveMap draws. A rail station
// that several lines share is listed once.
function buildStops() {
  const metro = metroStations.map((s, i) => ({
    id: `metro:${i}`,
    mode: 'metro',
    point: [s.lat, s.lon],
    name: s.name,
  }));
  const seen = new Set();
  const rail = [];
  for (const key of RAIL_LINE_ORDER) {
    for (const s of railStations[key] ?? []) {
      const name = displayStationName(s.name);
      const dedupe = `${name}|${s.lat.toFixed(3)}|${s.lon.toFixed(3)}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rail.push({ id: `rail:${s.id}`, mode: 'rail', point: [s.lat, s.lon], name });
    }
  }
  return { metro, rail };
}
const STOPS = buildStops();

/** The stations of the chosen modes (Metro's and Regional Rail's; buses have none here). */
export function visibleStops(modes) {
  return [
    ...(modes.includes('metro') ? STOPS.metro : []),
    ...(modes.includes('rail') ? STOPS.rail : []),
  ];
}

// The first view: the whole of Metro and Regional Rail, wherever the modes are
// toggled to. A pair of corners, not every point: this is only for fitting.
export const SYSTEM_FIT = (() => {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  const take = (shapes) => {
    for (const polylines of Object.values(shapes)) {
      for (const line of polylines) {
        for (const [lat, lon] of line) {
          south = Math.min(south, lat);
          north = Math.max(north, lat);
          west = Math.min(west, lon);
          east = Math.max(east, lon);
        }
      }
    }
  };
  take(metroLineShapes);
  take(railLineShapes);
  return [
    [south, west],
    [north, east],
  ];
})();

// --- Choosing modes -----------------------------------------------------------
// As on the Stations page's line filter: with every mode showing, picking one
// narrows the map to it, and picking others adds them; clearing the last one
// goes back to every mode, since "no modes" most usefully means "all of them"
// (an empty map says nothing).

/**
 * The modes after the reader picks (or un-picks) `key`, in the map's order.
 * @param {string[]} modes the modes now showing (never empty)
 * @param {string} key
 * @returns {string[]}
 */
export function toggleMode(modes, key) {
  if (!MAP_MODE_KEYS.includes(key)) return modes;
  if (modes.length >= MAP_MODE_KEYS.length) return [key];
  const next = modes.includes(key) ? modes.filter((m) => m !== key) : [...modes, key];
  return next.length === 0 ? [...MAP_MODE_KEYS] : MAP_MODE_KEYS.filter((m) => next.includes(m));
}

// `?modes=metro,rail`. No param means every mode. The spellings the data and the
// site's other pages use for a mode are understood too.
const MODE_ALIASES = { regional_rail: 'rail', 'regional-rail': 'rail', buses: 'bus' };

/**
 * The modes a query string asks for, in the map's order; every mode when it asks
 * for none it knows, so a stale or mistyped link still shows a map.
 * @param {string} search `window.location.search`
 * @returns {string[]}
 */
export function parseModes(search) {
  const raw = new URLSearchParams(search).get('modes') ?? '';
  const asked = raw
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .map((m) => MODE_ALIASES[m] ?? m);
  const modes = MAP_MODE_KEYS.filter((m) => asked.includes(m));
  return modes.length > 0 ? modes : [...MAP_MODE_KEYS];
}

/** The `modes` param for these modes, or null when every mode is shown (no param). */
export function modesParam(modes) {
  if (MAP_MODE_KEYS.every((m) => modes.includes(m))) return null;
  return MAP_MODE_KEYS.filter((m) => modes.includes(m)).join(',');
}
