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
 * The mark a vehicle gets on maps and timelapses: on the G1, which runs buses on most trips and
 * PCC trolleys on some (told apart by fleet number), an outline of a PCC (`pcc`) or a bus (`bus`);
 * every other vehicle, a circle. See map/draw.js vehicleMark.
 */
export function vehicleShape(route, label) {
  if (!isG1(route)) return 'circle';
  return isPccLabel(label) ? 'pcc' : 'bus';
}

/** True for a G1 vehicle, whose mark says whether it's a PCC trolley or a bus. */
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
  const kinds = new Set(vehicles.map((v) => vehicleShape(route, v.label)));
  const word = kinds.size === 1 ? (kinds.has('pcc') ? 'trolley' : 'bus') : 'vehicle';
  if (!plural) return word;
  return word === 'bus' ? 'buses' : `${word}s`;
}

/** Legend rows for the G1 vehicles among `vehicles` ({ route, label }), kinds present only. */
export function g1LegendRows(vehicles, { color = '#e8eaed' } = {}) {
  const shapes = new Set(
    vehicles.filter((v) => isG1(v?.route)).map((v) => vehicleShape(v.route, v.label)),
  );
  const rows = [];
  if (shapes.has('pcc')) rows.push({ label: 'PCC trolley', color, shape: 'pcc' });
  if (shapes.has('bus')) rows.push({ label: 'Bus', color, shape: 'bus' });
  return rows;
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
