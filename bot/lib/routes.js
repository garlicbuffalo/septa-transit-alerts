// Rider-facing names and emoji for routes in post text, built on the site's
// own route tables so the bots and the site always agree.
import { vehicleNoun } from '../../collector/lib/vehicles.js';
import { busRouteDisplayId, busRouteName } from '../../src/lib/busRoutes.js';
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { isPccLabel, PCC_LINE } from '../../src/lib/pcc.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';

const TROLLEY = /^(t\d|g1|d\d)$/;

/** Mode emoji for a route: 🚇 subway, 🚋 trolley, 🚈 M1, 🚌 bus, 🚆 Regional Rail. */
export function routeEmoji(mode, route = null) {
  if (mode === 'bus') return '🚌';
  if (mode === 'regional_rail') return '🚆';
  const key = String(route ?? '').toLowerCase();
  if (TROLLEY.test(key)) return '🚋';
  if (key === 'm1') return '🚈';
  return '🚇';
}

/**
 * The outline a vehicle gets on still maps and line timelapses (map/draw.js vehicleMark): `bus` for a bus, including
 * the buses that run most G1 trips; `pcc` for the G1's PCC trolleys (told apart from its buses by
 * fleet number); `lrv` for the Kawasaki trolleys of T1–T5, D1, and D2; `subway` for the L1's (and
 * Broad Street's) trains; `m1` for an M1 car; `rail` for a Regional Rail train. Without a mode, it
 * comes from the route: a Metro line, a Regional Rail line, or else a bus route. The system
 * snapshots draw dots for everything.
 * @param {{ mode?: string, route?: string, label?: string }} v
 */
export function vehicleShape({ mode, route, label } = {}) {
  const key = String(route ?? '').toLowerCase();
  const m =
    mode ?? (!key ? null : METRO_LINES[key] ? 'metro' : RAIL_LINES[key] ? 'regional_rail' : 'bus');
  if (m === 'bus') return 'bus';
  if (m === 'regional_rail') return 'rail';
  if (m !== 'metro') return 'circle';
  if (key === PCC_LINE) return isPccLabel(label) ? 'pcc' : 'bus';
  if (TROLLEY.test(key)) return 'lrv';
  if (key === 'm1') return 'm1';
  if (/^(l1|b\d)$/.test(key)) return 'subway';
  return 'circle';
}

/** True for a G1 vehicle, which may be a PCC trolley or a bus. */
export function isG1(route) {
  return String(route ?? '').toLowerCase() === PCC_LINE;
}

/**
 * What to call vehicles on a route in post text: on the G1, what they are ("buses", "trolleys",
 * or "vehicles" for a mix, or when none is known); elsewhere vehicleNoun's word.
 * @param {Array<{ label: string }>} vehicles the ones the post is about
 */
export function vehiclesNoun(mode, route, vehicles = [], plural = true) {
  if (!isG1(route)) return vehicleNoun(mode, route, plural);
  const kinds = new Set(vehicles.map((v) => vehicleShape({ mode, route, label: v.label })));
  const word = kinds.size === 1 ? (kinds.has('pcc') ? 'trolley' : 'bus') : 'vehicle';
  if (!plural) return word;
  return word === 'bus' ? 'buses' : `${word}s`;
}

// In legend order.
const LEGEND_LABELS = {
  pcc: 'PCC trolley',
  lrv: 'Kawasaki trolley',
  subway: 'Subway train',
  m1: 'M1 train',
  rail: 'Regional Rail train',
  bus: 'Bus',
};

/**
 * Legend rows for a map's vehicles ({ mode, route, label, shape? }) when they're of more than one
 * kind (a map of one route's buses needs none).
 */
export function vehicleLegendRows(vehicles, { color = '#e8eaed' } = {}) {
  const kinds = new Map();
  for (const v of vehicles) {
    const shape = v.shape ?? vehicleShape(v);
    if (shape === 'circle') continue;
    if (!kinds.has(shape)) kinds.set(shape, []);
    kinds.get(shape).push(v);
  }
  if (kinds.size < 2) return [];
  return Object.keys(LEGEND_LABELS)
    .filter((shape) => kinds.has(shape))
    .map((shape) => ({ label: LEGEND_LABELS[shape], color, shape }));
}

/** "Route 17", "L1", "Paoli/Thorndale Line". */
export function routeShortLabel(mode, route) {
  if (mode === 'bus') return `Route ${busRouteDisplayId(route)}`;
  if (mode === 'regional_rail') return `${RAIL_LINES[route]?.label ?? route} Line`;
  return METRO_LINES[route]?.label ?? String(route).toUpperCase();
}

/** "Route 17 (20th-Johnston to Penn's Landing)", "L1 Market-Frankford Line". */
export function routeLongLabel(mode, route) {
  if (mode === 'bus') {
    const name = busRouteName(route);
    return name
      ? `Route ${busRouteDisplayId(route)} (${name})`
      : `Route ${busRouteDisplayId(route)}`;
  }
  if (mode === 'regional_rail') return routeShortLabel(mode, route);
  const info = METRO_LINES[route];
  return info ? `${info.label} ${info.name}` : String(route).toUpperCase();
}

/**
 * Several routes as one label: "Routes 17, 33", "B1/B2/B3", "Paoli/Thorndale,
 * Cynwyd +4 lines".
 */
export function routesLabel(mode, routes, { max = 3 } = {}) {
  const list = [...new Set(routes ?? [])];
  if (list.length === 0) return '';
  if (list.length === 1) return routeShortLabel(mode, list[0]);
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  if (mode === 'bus') {
    const ids = shown.map(busRouteDisplayId).join(', ');
    return `Routes ${ids}${more ? ` +${more}` : ''}`;
  }
  if (mode === 'regional_rail') {
    const names = shown.map((r) => RAIL_LINES[r]?.label ?? r).join(', ');
    return `${names}${more ? ` +${more} lines` : ' Lines'}`;
  }
  const labels = shown.map((r) => METRO_LINES[r]?.label ?? String(r).toUpperCase()).join('/');
  return `${labels}${more ? ` +${more}` : ''}`;
}
