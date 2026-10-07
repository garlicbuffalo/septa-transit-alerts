// Geographic line-map helpers for the SEPTA Metro line-page heatmap. Loads
// station and track data (from SEPTA GTFS, lat/lon) and projects it into SVG
// coordinates so the rendered map has real Philadelphia shape rather than a
// stylized strip.
//
// Bus is excluded by design — the data files cover SEPTA Metro only, and a bus
// route's stop count makes a per-stop heatmap noisy at this scale.

import { fitMercator } from './basemap.js';
import lines from './metroLineShapes.json' with { type: 'json' };
import { METRO_LINE_ORDER, METRO_LINES, normalizeMetroLine } from './metroLines.js';
import stations from './metroStations.json' with { type: 'json' };
import { slugifyStation } from './stations.js';

// Bounding box around Center City — covers the L1 between 30th St and 2nd St,
// the trolley tunnel from 33rd St to 13th St, and the B1/B3 stations around
// City Hall. Lines with ≥4 stations inside this box get a zoom inset on their
// map page so the dense cluster doesn't render as overlapping dots.
const DOWNTOWN_BBOX = {
  latLo: 39.945,
  latHi: 39.958,
  lonLo: -75.19,
  lonHi: -75.14,
};
const DOWNTOWN_INSET_THRESHOLD = 4;

// Terminal stations per line — the first and last stop in each line's GTFS
// stop order (metroStations.json carries it as `seq`). Used as anchors for the
// only labels we render on the main map: labeling every station overcrowds the
// SVG, but flagging the endpoints gives a rider enough context to orient
// ("69th St at one end, Frankford at the other").
const LINE_TERMINALS = (() => {
  const out = {};
  for (const key of METRO_LINE_ORDER) {
    const onLine = stations.filter((s) => s.seq?.[key] != null);
    if (onLine.length === 0) continue;
    onLine.sort((a, b) => a.seq[key] - b.seq[key]);
    out[key] = [...new Set([onLine[0].name, onLine[onLine.length - 1].name])];
  }
  return out;
})();

// The projected terminus stations of a line (from LINE_TERMINALS). EventReplay
// uses these to tell a vehicle that cleanly ran off at the end of its line from
// one the feed simply lost mid-route.
export function terminalPointsFor(map, lineKey) {
  if (!map?.stations) return [];
  const names = new Set((LINE_TERMINALS[lineKey] ?? []).map((n) => slugifyStation(n)));
  return map.stations.filter((s) => names.has(slugifyStation(s.name)));
}

function inBox(lat, lon, bbox) {
  return lat >= bbox.latLo && lat <= bbox.latHi && lon >= bbox.lonLo && lon <= bbox.lonHi;
}

// Compute a lat/lon → SVG projection over a set of points. Returns the chosen
// SVG dimensions and a `project(lat, lon) → {x, y}` function. Pulled out of
// projectInto so both single-line and multi-line maps share identical scale
// math (cosine correction, aspect-driven sizing, optional rotation).
//
// `maxWidth` / `maxHeight` are upper bounds. The actual returned SVG
// dimensions are computed from the input's natural aspect ratio (after
// latitude-cosine correction so distances scale equivalently in x and y).
//
// `rotate: true` rotates the projection 90° counter-clockwise: north → left,
// south → right. Used for very vertical lines (B1, Lansdale/Doylestown) so the SVG
// stays landscape-ish rather than becoming a tall narrow strip that demands
// page scroll to get past.
//
// `basemap: true` projects in Web Mercator onto a fixed-size canvas instead, so
// map tiles can sit under the SVG (see basemap.js); it never rotates, and the
// result carries `basemap` ({ z, tiles }) for <BasemapTiles>.
function makeProjection(
  points,
  { maxWidth, maxHeight, margin, minHeight = 200, rotate = false, basemap = false },
) {
  if (points.length === 0) return null;
  if (basemap) return fitMercator(points, { maxWidth, maxHeight, margin, minHeight });

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const [lat, lon] of points) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  const latRange = Math.max(maxLat - minLat, 1e-6);
  const lonRange = Math.max(maxLon - minLon, 1e-6);

  // Cosine-of-latitude correction: 1° of longitude is shorter than 1° of
  // latitude in distance terms. At Philadelphia (~39.95°N) the ratio is ~0.77.
  // Multiplying lonRange by this factor lets us treat them as equivalent
  // distances downstream, so the rendered map preserves visual scale.
  const meanLat = (minLat + maxLat) / 2;
  const lonScaleCorrection = Math.cos((meanLat * Math.PI) / 180);
  const effectiveLonRange = lonRange * lonScaleCorrection;

  // After rotation, latitude span drives the horizontal axis and longitude
  // span drives the vertical axis. Compute the effective horizontal/vertical
  // ranges based on orientation.
  const xRange = rotate ? latRange : effectiveLonRange;
  const yRange = rotate ? effectiveLonRange : latRange;
  const aspect = xRange / yRange; // wider-than-tall when > 1

  // Pick natural dimensions from the aspect ratio, bounded by the caller's
  // maxes. Wider lines fill maxWidth and shrink height; taller lines fill
  // maxHeight and shrink width. minHeight prevents an extremely wide line
  // (e.g. a hypothetical horizontal trunk) from collapsing to a thin strip.
  let width;
  let height;
  if (aspect >= 1) {
    width = maxWidth;
    height = Math.max(minHeight, Math.min(maxHeight, Math.round(maxWidth / aspect)));
  } else {
    height = maxHeight;
    width = Math.max(minHeight, Math.min(maxWidth, Math.round(maxHeight * aspect)));
  }

  const innerW = width - 2 * margin;
  const innerH = height - 2 * margin;
  // Same scale on both axes so geometry stays distortion-free.
  const scale = Math.min(innerW / xRange, innerH / yRange);
  const projW = xRange * scale;
  const projH = yRange * scale;
  const offX = margin + (innerW - projW) / 2;
  const offY = margin + (innerH - projH) / 2;

  // 90° CCW: north → left (x grows toward south), east → top (y grows
  // toward west). Default (no rotate): east → right, north → top.
  const project = rotate
    ? (lat, lon) => ({
        x: offX + (maxLat - lat) * scale,
        y: offY + (maxLon - lon) * lonScaleCorrection * scale,
      })
    : (lat, lon) => ({
        x: offX + (lon - minLon) * lonScaleCorrection * scale,
        y: offY + (maxLat - lat) * scale,
      });

  return { width, height, project };
}

// Slice the highlighted stretch of track between two stations. Picks the
// polyline in `tracks` that best covers both endpoints (the wrong branch —
// the T3's Yeadon leg when the incident is on its Darby leg — has one station
// far off and loses), slices it between the closest indices, then trims any
// boundary point that sits past its station so the highlight doesn't overshoot.
// Returns an SVG path string, or null when no polyline covers both. Shared by
// the single-line EventMap and the multi-line map so both highlight identically.
//
// `a` / `b` are projected station points ({ x, y }); `tracks` are projected
// polylines (arrays of { x, y }).
export function sliceTrackBetween(tracks, a, b) {
  let bestScore = Number.POSITIVE_INFINITY;
  let highlightPath = null;
  for (const track of tracks) {
    if (!track || track.length < 2) continue;
    let aIdx = -1;
    let bIdx = -1;
    let aBest = Number.POSITIVE_INFINITY;
    let bBest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < track.length; i++) {
      const dxa = track[i].x - a.x;
      const dya = track[i].y - a.y;
      const da = dxa * dxa + dya * dya;
      if (da < aBest) {
        aBest = da;
        aIdx = i;
      }
      const dxb = track[i].x - b.x;
      const dyb = track[i].y - b.y;
      const db = dxb * dxb + dyb * dyb;
      if (db < bBest) {
        bBest = db;
        bIdx = i;
      }
    }
    // Score: how well does this polyline cover BOTH stations? Lower is better.
    const score = aBest + bBest;
    if (aIdx >= 0 && bIdx >= 0 && score < bestScore) {
      bestScore = score;
      const lo = Math.min(aIdx, bIdx);
      const hi = Math.max(aIdx, bIdx);
      let slice = track.slice(lo, hi + 1);
      const startStation = aIdx <= bIdx ? a : b;
      const endStation = aIdx <= bIdx ? b : a;
      // Keep only the track vertices that fall *between* the two stations,
      // measured by their projection onto the start→end chord (parameter t in
      // [0, 1]). Track vertices are sparse on some stretches, so the nearest
      // vertex to a station can sit past it, and appending the station after it
      // would draw a stub overshooting the dot. Curved runs keep
      // their bend vertices (those still project inside the chord), while
      // overshoot/undershoot vertices drop out regardless of how many the slice
      // has — the previous per-segment trim only fired when the slice had ≥2.
      const ex = endStation.x - startStation.x;
      const ey = endStation.y - startStation.y;
      const chordLen2 = ex * ex + ey * ey;
      if (chordLen2 > 0) {
        slice = slice.filter((p) => {
          const t = ((p.x - startStation.x) * ex + (p.y - startStation.y) * ey) / chordLen2;
          return t >= 0 && t <= 1;
        });
      }
      const points = [startStation, ...slice, endStation];
      highlightPath = `M${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}`;
    }
  }
  return highlightPath;
}

// Project a set of stations + track segments into a target SVG box. Thin
// wrapper over makeProjection that also maps the station + track geometry
// through the resulting projection. Exported so the parallel Regional Rail
// builder (railLineMap.js) shares the exact same projection math.
export function projectInto(rawStations, segments, opts) {
  if (rawStations.length === 0) return null;
  const points = [];
  for (const s of rawStations) points.push([s.lat, s.lon]);
  for (const seg of segments) {
    for (const p of seg) points.push(p);
  }
  const proj = makeProjection(points, opts);
  if (!proj) return null;

  const projectedStations = rawStations.map((s) => ({
    name: s.name,
    slug: s.slug,
    count: s.count,
    isTerminal: !!s.isTerminal,
    ...proj.project(s.lat, s.lon),
  }));
  const projectedTracks = segments.map((seg) => seg.map(([lat, lon]) => proj.project(lat, lon)));

  return {
    width: proj.width,
    height: proj.height,
    stations: projectedStations,
    tracks: projectedTracks,
    project: proj.project,
    basemap: proj.basemap ?? null,
  };
}

// Build the projected geometry for a single Metro line. Returns null when
// the line key isn't recognized or the data is missing — the caller should
// render nothing in that case rather than a half-broken SVG.
//
//   stationIndex — Map<slug, { count, ... }> from buildStationIndex.
//                  Optional; missing entries → count 0.
/**
 * @param {string} lineKey Metro line key ('l1', 'b1', 't3', …)
 * @param {Map<string, any> | null} [stationIndex]
 * @param {object} [options]
 * @param {number} [options.maxWidth]
 * @param {number} [options.maxHeight]
 * @param {number} [options.margin]
 * @param {boolean} [options.basemap] project onto map tiles (Web Mercator, never
 *   rotated); the result's `basemap` (and `downtown.basemap`) say which tiles
 * @returns {{
 *   width: number,
 *   height: number,
 *   tracks: Array<Array<{ x: number, y: number }>>,
 *   stations: Array<{ name: string, slug: string, count: number, x: number, y: number }>,
 *   maxCount: number,
 *   downtown: null | {
 *     stations: Array<{ name: string, slug: string, count: number, x: number, y: number }>,
 *     tracks: Array<Array<{ x: number, y: number }>>,
 *     width: number,
 *     height: number,
 *     mainBoxRect: { x: number, y: number, width: number, height: number } | null,
 *   },
 * } | null}
 */
export function buildLineMap(
  lineKey,
  stationIndex = null,
  { maxWidth = 720, maxHeight = 540, margin = 24, preferPortrait = false, basemap = false } = {},
) {
  if (!METRO_LINE_ORDER.includes(lineKey)) return null;
  const segments = lines[lineKey];
  const lineStations = stations.filter((s) => Array.isArray(s.lines) && s.lines.includes(lineKey));
  if (!segments || lineStations.length === 0) return null;

  // Annotate stations with their incident counts up front so both projections
  // share the same enriched records. `isTerminal` flags endpoint stations
  // for the renderer, which uses it to attach text labels.
  const terminals = new Set(LINE_TERMINALS[lineKey] ?? []);
  const enriched = lineStations.map((s) => {
    const slug = slugifyStation(s.name);
    const count = slug && stationIndex ? (stationIndex.get(slug)?.count ?? 0) : 0;
    return {
      name: s.name,
      slug,
      lat: s.lat,
      lon: s.lon,
      count,
      isTerminal: terminals.has(s.name),
    };
  });

  // Orientation. Default (desktop): rotate only a "very vertical" line 90° CCW
  // so a tall N-S line doesn't waste a wide content column — below 0.5 aspect
  // it's >2x taller than wide, render sideways. preferPortrait (mobile): orient
  // so the line's LONG axis runs vertically — keep tall lines tall, rotate
  // naturally-wide lines upright — to use a portrait screen's height.
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
  // Tiles can't be turned (their street names would run sideways), so a
  // basemap never rotates.
  const rotate = !basemap && (preferPortrait ? naturalAspect > 1 : naturalAspect < 0.5);

  const main = projectInto(enriched, segments, {
    maxWidth,
    // Desktop rotation implies landscape, so cap the height. In portrait mode a
    // rotation is to stand the line UP, so let it use the full height instead.
    maxHeight: rotate && !preferPortrait ? 240 : maxHeight,
    margin,
    rotate,
    basemap,
  });
  if (!main) return null;

  let maxCount = 0;
  for (const s of main.stations) {
    if (s.count > maxCount) maxCount = s.count;
  }

  // Downtown inset — only when enough stations cluster there. Scope the
  // track segments to points inside the bbox, with one bridging point on
  // either side to avoid clipped lines that look chopped.
  let downtown = null;
  const downtownStations = enriched.filter((s) => inBox(s.lat, s.lon, DOWNTOWN_BBOX));
  if (downtownStations.length >= DOWNTOWN_INSET_THRESHOLD) {
    const downtownSegments = [];
    for (const seg of segments) {
      let current = [];
      let lastWasInside = false;
      for (let i = 0; i < seg.length; i++) {
        const [lat, lon] = seg[i];
        const inside = inBox(lat, lon, DOWNTOWN_BBOX);
        if (inside) {
          // Include the previous point too so segments entering the bbox
          // start from the right edge rather than mid-air.
          if (!lastWasInside && i > 0 && current.length === 0) {
            current.push(seg[i - 1]);
          }
          current.push([lat, lon]);
          lastWasInside = true;
        } else {
          if (lastWasInside) {
            // Bridge one point past the bbox so segments exiting also land
            // smoothly at the edge.
            current.push([lat, lon]);
            downtownSegments.push(current);
            current = [];
          }
          lastWasInside = false;
        }
      }
      if (current.length >= 2) downtownSegments.push(current);
    }

    const inset = projectInto(downtownStations, downtownSegments, {
      maxWidth: 320,
      maxHeight: 280,
      margin: 14,
      minHeight: 160,
      // Match the main map's orientation so the dashed "zoom here" rect on
      // the main lines up with the inset's geometry — if main is rotated
      // sideways, the inset should be too.
      rotate,
      basemap,
    });
    if (inset) {
      // Marker rect on the main map showing the area the inset zooms into.
      // Same coordinate space as the main projection.
      const c1 = main.project(DOWNTOWN_BBOX.latHi, DOWNTOWN_BBOX.lonLo);
      const c2 = main.project(DOWNTOWN_BBOX.latLo, DOWNTOWN_BBOX.lonHi);
      downtown = {
        stations: inset.stations,
        tracks: inset.tracks,
        width: inset.width,
        height: inset.height,
        basemap: inset.basemap,
        mainBoxRect: {
          x: Math.min(c1.x, c2.x),
          y: Math.min(c1.y, c2.y),
          width: Math.abs(c2.x - c1.x),
          height: Math.abs(c2.y - c1.y),
        },
      };
    }
  }

  return {
    width: main.width,
    height: main.height,
    tracks: main.tracks,
    stations: main.stations,
    // Same lat/lon → SVG transform the tracks/stations were projected through,
    // exposed so callers can drop arbitrary points (e.g. live vehicle positions
    // for event replay) onto the schematic in the same coordinate space.
    project: main.project,
    basemap: main.basemap,
    maxCount,
    downtown,
  };
}

// Build a combined map covering several Metro lines in one shared coordinate
// space — used by the multi-line event map so an incident touching the whole
// trolley tunnel renders every affected line at once instead of one arbitrary
// line.
//
// All requested lines' stations and tracks are projected through a single
// projection (no rotation — the multi-line bbox spans the system and is
// roughly square, so the vertical-line rotation that single lines use would
// only confuse). Returns:
//   tracksByLine — one entry per drawable line, with its brand color and the
//                  line's projected polylines (for faint context + per-line
//                  segment highlighting).
//   stations     — every station on any requested line, projected once, each
//                  tagged with the (normalized) line keys it serves so the
//                  renderer can decide which dots are affected.
// Returns null when no requested line resolves to data.
// Build the four corners of a padded bounding box around the named stations,
// for use as the only inputs to makeProjection. Padding adds ~25% breathing
// room on each axis so the affected area doesn't run up against the SVG edge,
// plus a small absolute floor (≈ 0.5 km) so a single-station crop doesn't
// collapse to a point. Returns null when no station name resolves — caller
// falls back to projecting over the full geometry.
function cropProjectionPoints(stationNames, lineStations) {
  if (!Array.isArray(stationNames) || stationNames.length === 0) return null;
  const wanted = new Set(stationNames.map((n) => normalizeStationKey(n)));
  const hits = lineStations.filter((s) => wanted.has(normalizeStationKey(s.name)));
  if (hits.length === 0) return null;

  let minLat = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let minLon = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  for (const s of hits) {
    if (s.lat < minLat) minLat = s.lat;
    if (s.lat > maxLat) maxLat = s.lat;
    if (s.lon < minLon) minLon = s.lon;
    if (s.lon > maxLon) maxLon = s.lon;
  }
  const latPad = (maxLat - minLat) * 0.25 + 0.005;
  const lonPad = (maxLon - minLon) * 0.25 + 0.005;
  return [
    [minLat - latPad, minLon - lonPad],
    [minLat - latPad, maxLon + lonPad],
    [maxLat + latPad, minLon - lonPad],
    [maxLat + latPad, maxLon + lonPad],
  ];
}

// Loose station-name key for crop lookup: lowercase, strip trailing line
// qualifiers ("Walnut St (D1)" → "walnut st"), trim whitespace.
// Mirrors EventMap's `normalize` so callers can pass either the raw or
// qualified form.
function normalizeStationKey(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

/**
 * @param {string[]} lineKeys Metro line keys ('t1', 't2', …)
 * @param {object} [options]
 * @param {number} [options.maxWidth]
 * @param {number} [options.maxHeight]
 * @param {number} [options.margin]
 * @param {boolean} [options.basemap] project onto map tiles (see buildLineMap)
 * @param {string[]} [options.cropToStationNames] When provided, the projection's
 *   bounding box is computed from these stations + a buffer instead of the full
 *   line geometries. Tracks/stations outside this box still get projected (and
 *   so are clipped by the SVG viewBox) — used to zoom into just the affected
 *   area on an incident map so dense urban clusters don't squish together.
 * @returns {{
 *   width: number,
 *   height: number,
 *   tracksByLine: Array<{ key: string, label: string, color: string, tracks: Array<Array<{x:number,y:number}>> }>,
 *   stations: Array<{ name: string, slug: string|null, lines: string[], x: number, y: number }>,
 *   basemap: { z: number, tiles: Array<object> } | null,
 * } | null}
 */
export function buildMultiLineMap(
  lineKeys,
  { maxWidth = 720, maxHeight = 420, margin = 24, cropToStationNames = null, basemap = false } = {},
) {
  const keys = [...new Set((lineKeys || []).filter((k) => METRO_LINE_ORDER.includes(k)))];
  if (keys.length === 0) return null;

  // Keep line key + its data together; drop any line with no track geometry.
  const drawable = [];
  for (const key of keys) {
    const segs = lines[key];
    if (Array.isArray(segs) && segs.length > 0) drawable.push({ key, segs });
  }
  if (drawable.length === 0) return null;

  const drawn = new Set(drawable.map((d) => d.key));
  const lineStations = stations.filter(
    (s) => Array.isArray(s.lines) && s.lines.some((l) => drawn.has(l)),
  );

  // Either project over the affected area (with buffer for context) or the full
  // line geometries. The crop path uses the four corners of the padded
  // bounding box as the only projection points so off-screen geometry can't
  // expand the box back out.
  let projectionPoints;
  const cropped = cropProjectionPoints(cropToStationNames, lineStations);
  if (cropped) {
    projectionPoints = cropped;
  } else {
    projectionPoints = [];
    for (const s of lineStations) projectionPoints.push([s.lat, s.lon]);
    for (const d of drawable) {
      for (const seg of d.segs) {
        for (const p of seg) projectionPoints.push(p);
      }
    }
  }
  const proj = makeProjection(projectionPoints, {
    maxWidth,
    maxHeight,
    margin,
    rotate: false,
    basemap,
  });
  if (!proj) return null;

  const projectedStations = lineStations.map((s) => ({
    name: s.name,
    slug: slugifyStation(s.name),
    lines: (s.lines || []).map(normalizeMetroLine),
    ...proj.project(s.lat, s.lon),
  }));

  const tracksByLine = drawable.map((d) => ({
    key: d.key,
    label: METRO_LINES[d.key]?.label ?? d.key,
    color: METRO_LINES[d.key]?.color ?? '#475569',
    tracks: d.segs.map((seg) => seg.map(([lat, lon]) => proj.project(lat, lon))),
  }));

  return {
    width: proj.width,
    height: proj.height,
    tracksByLine,
    stations: projectedStations,
    basemap: proj.basemap ?? null,
  };
}
