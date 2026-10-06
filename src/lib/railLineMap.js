// Geographic line-map geometry for Regional Rail — the commuter-rail parallel
// of the SEPTA Metro builder in lineMap.js. Projects a Regional Rail line's
// track polylines + ordered stations (lat/lon) into SVG space so the rendered
// map keeps real metro-area shape. Shares the exact projection math
// (projectInto / sliceTrackBetween) with the Metro side; what differs is the
// data source and the lack of a downtown inset — Regional Rail's Center City
// stops are few, and its lines fan out across the suburbs, so a single
// projection reads fine end-to-end.

import { projectInto, sliceTrackBetween } from './lineMap.js';
import lineShapes from './railLineShapes.json' with { type: 'json' };
import { normalizeRailLine, RAIL_LINE_ORDER } from './railLines.js';
import railStations from './railStations.json' with { type: 'json' };
import { slugifyStation } from './stations.js';

// railStations.json is keyed by the lowercase line key; normalize anyway so a
// hand-edited roster in SEPTA's uppercase codes still resolves.
const STATIONS_BY_KEY = new Map(
  Object.entries(railStations).map(([route, list]) => [normalizeRailLine(route), list]),
);

export { sliceTrackBetween };

/**
 * Build the projected geometry for a single Regional Rail line. Same return shape as
 * buildLineMap (lineMap.js) so the shared LineMap/EventMap renderers can consume
 * either — except `downtown` is always null (no Regional Rail inset).
 *
 * @param {string} lineKey lowercase Regional Rail key ('pao', 'wtr', …)
 * @param {Map<string, {count:number}> | null} [stationIndex] slug → record
 * @param {object} [options]
 * @returns {{
 *   width: number, height: number,
 *   tracks: Array<Array<{x:number,y:number}>>,
 *   stations: Array<{name:string, slug:string, count:number, isTerminal:boolean, x:number, y:number}>,
 *   project: (lat:number, lon:number) => {x:number,y:number},
 *   maxCount: number,
 *   downtown: null,
 * } | null}
 */
export function buildRailLineMap(
  lineKey,
  stationIndex = null,
  { maxWidth = 720, maxHeight = 540, margin = 24, preferPortrait = false } = {},
) {
  const key = normalizeRailLine(lineKey);
  if (!RAIL_LINE_ORDER.includes(key)) return null;
  const segments = lineShapes[key];
  const lineStations = STATIONS_BY_KEY.get(key);
  if (!segments || !lineStations || lineStations.length === 0) return null;

  // Terminals = the first and last station in the line's GTFS stop order
  // (railStations.json preserves it), which is all we label — naming every
  // suburban stop would crowd the map.
  const lastIdx = lineStations.length - 1;
  const enriched = lineStations.map((s, i) => {
    const slug = slugifyStation(s.name);
    const count = slug && stationIndex ? (stationIndex.get(slug)?.count ?? 0) : 0;
    return {
      name: s.name,
      slug,
      lat: s.lat,
      lon: s.lon,
      count,
      isTerminal: i === 0 || i === lastIdx,
    };
  });

  // Orientation — same rule as the Metro builder: rotate a very vertical line
  // 90° CCW on desktop so a tall N-S corridor doesn't render as a thin strip;
  // in portrait, stand the line's long axis up to use screen height.
  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const s of enriched) {
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
  }
  const meanLat = (minLat + maxLat) / 2;
  const cosCorrection = Math.cos((meanLat * Math.PI) / 180);
  const naturalAspect =
    (Math.max(maxLon - minLon, 1e-6) * cosCorrection) / Math.max(maxLat - minLat, 1e-6);
  const rotate = preferPortrait ? naturalAspect > 1 : naturalAspect < 0.5;

  const main = projectInto(enriched, segments, {
    maxWidth,
    maxHeight: rotate && !preferPortrait ? 240 : maxHeight,
    margin,
    rotate,
  });
  if (!main) return null;

  let maxCount = 0;
  for (const s of main.stations) {
    if (s.count > maxCount) maxCount = s.count;
  }

  return {
    width: main.width,
    height: main.height,
    tracks: main.tracks,
    stations: main.stations,
    project: main.project,
    maxCount,
    downtown: null,
  };
}
