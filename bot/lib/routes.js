// Rider-facing names and emoji for routes in post text, built on the site's
// own route tables so the bots and the site always agree.
import { busRouteDisplayId, busRouteName } from '../../src/lib/busRoutes.js';
import { METRO_LINES } from '../../src/lib/metroLines.js';
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
