// SEPTA bus route names, keyed by the route id used in the published data —
// GTFS `route_short_name` with spaces hyphenated ('17', 'K', 'LUCYGO',
// 'L1-OWL'). Generated from SEPTA's GTFS by scripts/build-reference-data.js;
// the long name is SEPTA's terminal-to-terminal description ("Front-Mkt to
// 20-Johnston"). Includes trackless trolleys (59, 66, 75) and the shuttle /
// overnight bus routes that stand in for Metro and Regional Rail service.
import busRoutes from './busRoutes.json' with { type: 'json' };

export const BUS_ROUTE_NAMES = busRoutes;

/** Every bus route id in SEPTA's display order. */
export const BUS_ROUTE_ORDER = Object.keys(busRoutes);

/**
 * Returns the display name for a bus route, or null if unknown.
 * @param {string|number} routeId
 * @returns {string|null}
 */
export function busRouteName(routeId) {
  return BUS_ROUTE_NAMES[routeId] ?? BUS_ROUTE_NAMES[String(routeId)] ?? null;
}

/**
 * The route id as riders see it — hyphenated keys revert to SEPTA's spaced
 * spelling ('L1-OWL' → 'L1 OWL').
 * @param {string|number} routeId
 * @returns {string}
 */
export function busRouteDisplayId(routeId) {
  return String(routeId ?? '').replace(/-(?=[A-Za-z])/g, ' ');
}

/**
 * Formats a bus route as `Route 17` (SEPTA's own convention). The long name
 * is left to callers that have room for it (see busRouteName).
 * @param {string|number} routeId
 * @returns {string}
 */
export function formatBusRoute(routeId) {
  return `Route ${busRouteDisplayId(routeId)}`;
}

// Compare two bus route IDs by their embedded number, then by the full
// string, so numbered routes sort numerically (`2, 9, 17, 108`) and lettered
// routes (K, LUCYGO, L1-OWL) group after them. A pure-number route always sorts
// before its lettered siblings (digit < letter codepoints under localeCompare).
export function compareBusRoutes(a, b) {
  const sa = String(a);
  const sb = String(b);
  const na = /^\d+$/.test(sa) ? parseInt(sa, 10) : Number.NaN;
  const nb = /^\d+$/.test(sb) ? parseInt(sb, 10) : Number.NaN;
  if (Number.isNaN(na) && Number.isNaN(nb)) return sa.localeCompare(sb);
  if (Number.isNaN(na)) return 1;
  if (Number.isNaN(nb)) return -1;
  return na - nb;
}
