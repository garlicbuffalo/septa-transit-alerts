// Route classification for SEPTA's route identifiers. SEPTA's alert and
// realtime APIs share one route namespace across three networks — SEPTA Metro
// ("L1", "T3"), buses ("17", "LUCYGO", "L1 OWL"), and Regional Rail ("PAO") —
// so every raw route id is resolved here to the `{ mode, key }` pair the
// published data uses:
//
//   mode  'metro' | 'bus' | 'regional_rail'  (incident.mode on the wire)
//   key   lowercase Metro/Regional Rail key ('l1', 'pao') or the hyphenated bus
//         route ('17', 'L1-OWL') — incident.routes[] on the wire
import busRoutes from '../../src/lib/busRoutes.json' with { type: 'json' };
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { RAIL_LINES } from '../../src/lib/railLines.js';

const BUS_KEYS_UPPER = new Map(Object.keys(busRoutes).map((k) => [k.toUpperCase(), k]));
const RAIL_BY_TRAINVIEW = new Map(
  Object.entries(RAIL_LINES).map(([key, info]) => [info.trainView.toLowerCase(), key]),
);

/** Hyphenate a SEPTA bus route name the way busRoutes.json keys do. */
export function busRouteKey(raw) {
  return String(raw).trim().replace(/\s+/g, '-');
}

/**
 * Resolve a raw SEPTA route id to its network and published key. Unknown ids
 * fall back to bus — SEPTA's long tail of route variants (shuttles, school
 * trippers, renamed routes) is almost entirely bus — keyed the same way.
 * @param {string | null | undefined} raw
 * @returns {{ mode: 'metro' | 'bus' | 'regional_rail', key: string, known: boolean } | null}
 */
export function classifyRoute(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (METRO_LINES[lower]) return { mode: 'metro', key: lower, known: true };
  if (RAIL_LINES[lower]) return { mode: 'regional_rail', key: lower, known: true };
  const busKey = BUS_KEYS_UPPER.get(busRouteKey(trimmed).toUpperCase());
  if (busKey) return { mode: 'bus', key: busKey, known: true };
  return { mode: 'bus', key: busRouteKey(trimmed), known: false };
}

/** Regional Rail key for a TrainView `line` name ("Media/Wawa" → 'med'), or null. */
export function railKeyForTrainViewLine(line) {
  if (!line) return null;
  return RAIL_BY_TRAINVIEW.get(String(line).trim().toLowerCase()) ?? null;
}

/**
 * Group a list of raw route ids by network, preserving first-seen order and
 * de-duplicating keys. Returns `[[mode, keys[]], …]` in the order modes first
 * appear, so a mixed alert keeps its primary network first.
 */
export function groupRoutesByMode(rawRoutes) {
  const groups = new Map();
  for (const raw of rawRoutes || []) {
    const c = classifyRoute(raw);
    if (!c) continue;
    if (!groups.has(c.mode)) groups.set(c.mode, []);
    const keys = groups.get(c.mode);
    if (!keys.includes(c.key)) keys.push(c.key);
  }
  return [...groups.entries()];
}
