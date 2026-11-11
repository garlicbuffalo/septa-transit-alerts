// The slow-zones layer of the system map: the stretches where buses and
// trolleys were slowest over the past week (slow-zones.json, from the bot
// server; see bot/features/slowzones.js), drawn in the speed maps' colours.
import { formatBusRoute } from './busRoutes.js';
import { METRO_LINES } from './metroLines.js';
import { bandFor, bandsFor } from './speedBands.js';

// Zones older than this are from a bot server that's gone quiet.
export const SLOW_ZONES_STALE_MS = 3 * 24 * 60 * 60 * 1000;
const WEIGHT = 7;

/** Whether the URL asks for the slow-zones layer (?layer=slow). */
export function wantsSlowZones(search) {
  return new URLSearchParams(search).get('layer') === 'slow';
}

const labelOf = (z) =>
  z.mode === 'metro'
    ? (METRO_LINES[z.route]?.label ?? String(z.route).toUpperCase())
    : formatBusRoute(z.route);
const hrefOf = (z) =>
  z.mode === 'metro' ? `/line/${z.route}` : `/route/${encodeURIComponent(z.route)}`;

/**
 * The file's zones for the map modes on show, slowest first, each with its
 * label, page, and speed band. Empty for a missing or stale file.
 * @param {object | null} file
 * @param {string[]} modes the system map's modes ('metro' | 'rail' | 'bus')
 */
export function slowZoneRows(file, modes, now = Date.now()) {
  if (!file?.zones?.length || now - file.generated_at > SLOW_ZONES_STALE_MS) return [];
  return file.zones
    .filter((z) => modes.includes(z.mode) && z.points?.length >= 2)
    .map((z) => ({
      ...z,
      id: `slow:${z.mode}:${z.route}:${z.dir}`,
      label: labelOf(z),
      href: hrefOf(z),
      band: bandFor(bandsFor(z.mode, z.route), z.mph),
    }))
    .sort((a, b) => a.mph - b.mph);
}

/** The rows as lines for the map, the slowest drawn last (on top). */
export function slowZoneLines(rows) {
  return [...rows].reverse().map((z) => ({
    id: z.id,
    points: z.points,
    color: z.band.color,
    weight: WEIGHT,
    casing: true,
    tip: `${z.label} · ${z.mph.toFixed(1)} mph${z.name ? ` · ${z.name}` : ''}`,
  }));
}

/** The distinct speed bands among the rows, slowest first, for the legend. */
export function slowZoneBands(rows) {
  const seen = new Map();
  for (const z of rows) if (!seen.has(z.band.label)) seen.set(z.band.label, z.band);
  return [...seen.values()].sort((a, b) => a.below - b.below);
}
