// What each timelapse shows. A detection timelapse follows the vehicles from
// its post (numbered, or L and N for a gap) along their route for the next
// ten minutes, with the route's other vehicles as small dots. A system
// snapshot shows every tracked bus, or every Metro trolley and M1 car, colored
// by how late it's running.
import metroShapes from '../../src/lib/metroLineShapes.json' with { type: 'json' };
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { clockLabel } from '../lib/clock.js';
import { formatDistance, maxPairDistance, metersBetween, pathLength } from '../lib/geo.js';
import { escapeXml, FONT, line } from '../map/draw.js';
import { bboxOf, fitView, project } from '../map/projection.js';
import { MARKER, MARKER_R, STRETCH, separate, stretchBetween } from '../map/routeMap.js';
import { dotLegend, elapsedLabel, hud, VIDEO_SIZE } from './timelapse.js';
import { positionAt, trailAt } from './tracks.js';

const MIN_SPAN_DEG = 0.012;
// Metro lines on SEPTA's live tracker (the subway lines aren't).
export const TRACKED_METRO = ['t1', 't2', 't3', 't4', 't5', 'g1', 'd1', 'd2', 'm1'];

export const LATENESS = [
  { key: 'early', label: 'Early (3+ min)', color: '#c06cff' },
  { key: 'ontime', label: 'On time or up to 5 min late', color: '#00c2e0' },
  { key: 'late', label: '6–9 min late', color: '#ffb000' },
  { key: 'verylate', label: '10+ min late', color: '#ff2a6d' },
];
const NO_SCHEDULE = '#9aa0a6';

export function latenessKey(late) {
  if (late == null) return null;
  if (late <= -3) return 'early';
  if (late <= 5) return 'ontime';
  if (late < 10) return 'late';
  return 'verylate';
}

const latenessColor = (late) =>
  LATENESS.find((b) => b.key === latenessKey(late))?.color ?? NO_SCHEDULE;

// Meters from a point to a [[lat, lon], …] polyline.
function distanceToShape(shape, p) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i + 1 < shape.length; i++) {
    const [aLat, aLon] = shape[i];
    const [bLat, bLon] = shape[i + 1];
    const dx = (bLon - aLon) * k;
    const dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    const t = len2
      ? Math.max(0, Math.min(1, ((p.lon - aLon) * k * dx + (p.lat - aLat) * dy) / len2))
      : 0;
    const d = Math.hypot((p.lon - aLon) * k - t * dx, p.lat - aLat - t * dy);
    best = Math.min(best, d);
  }
  return best * 111_320;
}

/**
 * The shape the points sit on: of a route's shapes (one per direction, which
 * can run on different streets), the one nearest all of them.
 */
export function nearestShape(shapes, points) {
  let best = null;
  let bestScore = Infinity;
  for (const shape of shapes ?? []) {
    if (!shape || shape.length < 2) continue;
    const score = points.reduce((sum, p) => sum + distanceToShape(shape, p), 0);
    if (score < bestScore) {
      best = shape;
      bestScore = score;
    }
  }
  return best;
}

/** Distance between two positions along a route shape, else straight-line. */
export function alongRoute(shape, a, b) {
  const stretch = shape ? stretchBetween(shape, a, b) : null;
  return stretch ? pathLength(stretch) : metersBetween(a, b);
}

function fitPoints(points, size, { pad = 140, minZoom = 11, maxZoom = 16 } = {}) {
  const bb = bboxOf(points);
  const cLat = (bb.minLat + bb.maxLat) / 2;
  const cLon = (bb.minLon + bb.maxLon) / 2;
  const spanLat = Math.max(MIN_SPAN_DEG, bb.maxLat - bb.minLat) / 2;
  const spanLon = Math.max(MIN_SPAN_DEG, bb.maxLon - bb.minLon) / 2;
  return fitView(
    {
      minLat: cLat - spanLat,
      maxLat: cLat + spanLat,
      minLon: cLon - spanLon,
      maxLon: cLon + spanLon,
    },
    size,
    size,
    { pad, minZoom, maxZoom },
  );
}

/** Every point a track occupies during [start, end]. */
function trackPoints(track, start, end) {
  const out = track.points.filter((p) => p.t >= start && p.t <= end);
  const first = positionAt(track, start);
  if (first) out.push(first);
  return out;
}

/**
 * Detection timelapse (bunching, gap, cluster).
 * @param {{ capture: { kind: string, start_ts: number, end_ts: number },
 *   focus: { title: string, direction_id?: number, vehicles: Array<{ id: string, tag: string, color?: string }> },
 *   routes: Array<{ route: string, color: string, shapes: number[][][] }>,
 *   tracks: Map<string, object>, size?: number }} opts
 */
export function focusScene({ capture, focus, routes, tracks, size = VIDEO_SIZE }) {
  const start = capture.start_ts;
  const end = capture.end_ts;
  const focusIds = new Set(focus.vehicles.map((v) => v.id));
  const focusTracks = focus.vehicles
    .map((v) => ({ ...v, track: tracks.get(v.id) }))
    .filter((v) => v.track);
  const pts = focusTracks.flatMap((v) => trackPoints(v.track, start, end));
  if (pts.length === 0) return null;
  const view = fitPoints(pts, size);
  const px = (p) => project(view, p.lat, p.lon);
  const routeColor = new Map(routes.map((r) => [r.route, r.color]));
  // The route's shape the gap stretch follows.
  const gapShape =
    capture.kind === 'gap'
      ? nearestShape(
          routes.flatMap((r) => r.shapes),
          focusTracks.map((v) => positionAt(v.track, start)).filter(Boolean),
        )
      : null;

  let staticSvg = '';
  for (const r of routes) {
    for (const shape of r.shapes) {
      if (shape?.length >= 2) {
        staticSvg += line(
          shape.map(([lat, lon]) => project(view, lat, lon)),
          { color: r.color, width: 8, opacity: 0.9, casing: 3 },
        );
      }
    }
  }

  const others = [...tracks.values()].filter((t) => !focusIds.has(t.id) && routeColor.has(t.route));

  function readout(positions) {
    const live = positions.filter(Boolean);
    if (capture.kind === 'gap') {
      const [l, n] = positions;
      if (!l || !n) return null;
      return `Gap ${formatDistance(alongRoute(gapShape, n, l))}`;
    }
    if (capture.kind === 'cluster') {
      const still = focusTracks.filter((v, i) => {
        const p = positions[i];
        const s = positionAt(v.track, start);
        return p && s && metersBetween(p, s) <= 150;
      }).length;
      return `${still} of ${focusTracks.length} still there`;
    }
    if (live.length < 2) return null;
    return `${live.length} within ${formatDistance(maxPairDistance(live))}`;
  }

  function drawFrame(t, progress) {
    let svg = '';
    for (const o of others) {
      const p = positionAt(o, t);
      if (!p) continue;
      const q = px(p);
      svg += `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="9" fill="${routeColor.get(o.route)}" fill-opacity="${(0.9 * p.opacity).toFixed(2)}" stroke="#0b0d10" stroke-width="3" stroke-opacity="${p.opacity.toFixed(2)}"/>`;
    }
    const positions = focusTracks.map((v) => positionAt(v.track, t));
    if (capture.kind === 'gap' && gapShape && positions[0] && positions[1]) {
      const stretch = stretchBetween(gapShape, positions[1], positions[0]);
      if (stretch) {
        const s = stretch.map(([lat, lon]) => project(view, lat, lon));
        svg += line(s, { color: '#000', width: 16, opacity: 0.6 });
        svg += line(s, { color: STRETCH, width: 10, opacity: 1, dash: '20 14' });
      }
    }
    focusTracks.forEach((v) => {
      const trail = trailAt(v.track, t).map(px);
      if (trail.length >= 2) svg += line(trail, { color: '#ffffff', width: 6, opacity: 0.45 });
    });
    const placed = separate(
      focusTracks
        .map((v, i) => (positions[i] ? { ...v, ...px(positions[i]), p: positions[i] } : null))
        .filter(Boolean),
    );
    for (const m of placed) {
      const o = m.p.opacity.toFixed(2);
      svg +=
        `<g opacity="${o}"><circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${MARKER_R}" fill="${m.color ?? MARKER}" stroke="#fff" stroke-width="4"/>` +
        `<text x="${m.x.toFixed(1)}" y="${(m.y + 8).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="23" font-weight="800" fill="#fff">${escapeXml(m.tag)}</text></g>`;
    }
    svg += hud({
      title: focus.title,
      readout: readout(positions),
      clock: `${clockLabel(t)} · ${elapsedLabel(t - start)}`,
      progress,
      width: view.width,
      height: view.height,
    });
    return svg;
  }

  return { view, staticSvg, drawFrame };
}

/** Lines drawn under a system snapshot. */
export function snapshotLines(mode, shapes) {
  if (mode === 'metro') {
    return TRACKED_METRO.flatMap((key) =>
      (metroShapes[key] ?? []).map((points) => ({
        points,
        color: METRO_LINES[key]?.color ?? '#9aa0a6',
        width: 5,
        opacity: 0.85,
      })),
    );
  }
  const routes = shapes?.routes?.() ?? [];
  return routes
    .filter((r) => !METRO_LINES[r])
    .flatMap((r) =>
      shapes.shapes(r).map((points) => ({ points, color: '#4c7f91', width: 2.5, opacity: 0.5 })),
    );
}

// Middle 98% of values, so a stray report miles away doesn't zoom the map out.
function trimmedBounds(points) {
  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lons = points.map((p) => p.lon).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * f)))];
  return [
    { lat: q(lats, 0.01), lon: q(lons, 0.01) },
    { lat: q(lats, 0.99), lon: q(lons, 0.99) },
  ];
}

/**
 * System snapshot: every tracked vehicle of a mode.
 * @param {{ capture: { start_ts: number, end_ts: number }, mode: 'bus' | 'metro',
 *   title: string, noun: string, tracks: Map<string, object>, lines: Array<object>,
 *   size?: number }} opts
 */
export function snapshotScene({ capture, mode, title, noun, tracks, lines, size = VIDEO_SIZE }) {
  const start = capture.start_ts;
  const end = capture.end_ts;
  const all = [...tracks.values()];
  const pts = all.flatMap((t) => t.points);
  if (pts.length === 0) return null;
  const framePoints =
    mode === 'metro'
      ? lines.flatMap((l) => l.points.map(([lat, lon]) => ({ lat, lon })))
      : trimmedBounds(pts);
  // The Metro network is small enough to keep clear of the title and legend;
  // the bus network fills the frame.
  const view = fitPoints(framePoints, size, {
    pad: mode === 'metro' ? 170 : 60,
    minZoom: 9,
    maxZoom: 13,
  });
  let staticSvg = '';
  for (const l of lines) {
    if (l.points.length < 2) continue;
    staticSvg += line(
      l.points.map(([lat, lon]) => project(view, lat, lon)),
      l,
    );
  }
  const legend = dotLegend([...LATENESS, { label: 'Not matched to a trip', color: NO_SCHEDULE }], {
    height: view.height,
  });
  const r = mode === 'metro' ? 9 : 5.5;

  function drawFrame(t, progress) {
    let svg = '';
    let count = 0;
    for (const track of all) {
      const p = positionAt(track, t);
      if (!p || p.opacity <= 0) continue;
      count++;
      const q = project(view, p.lat, p.lon);
      svg += `<circle cx="${q.x.toFixed(1)}" cy="${q.y.toFixed(1)}" r="${r}" fill="${latenessColor(p.late)}" fill-opacity="${p.opacity.toFixed(2)}" stroke="#0b0d10" stroke-width="1.5" stroke-opacity="${p.opacity.toFixed(2)}"/>`;
    }
    svg += legend;
    svg += hud({
      title,
      readout: `${count} ${noun} on the tracker`,
      clock: `${clockLabel(t)} · ${elapsedLabel(t - start)}`,
      progress,
      width: view.width,
      height: view.height,
    });
    return svg;
  }

  return { view, staticSvg, drawFrame, start, end };
}
