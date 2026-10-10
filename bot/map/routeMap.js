// Maps for vehicle detections: a route's line, the vehicles involved as
// numbered or lettered markers, and for gaps the empty stretch dashed between
// them. Also draws several routes at once (cross-route clusters). Modeled on
// cta-insights' bunching and gap maps (ISC).
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { composite, escapeXml, FONT, line, titlePill } from './draw.js';
import { sliceBranch } from './lineMap.js';
import { bboxOf, fitView, project } from './projection.js';

export const MAP_SIZE = 1200;
export const BUS_LINE = '#00c2e0';
export const MARKER = '#ff2a6d';
export const STRETCH = '#ffb000';
// Distinct colors for several routes on one map.
export const PALETTE = ['#00c2e0', '#ffb000', '#7cd65a', '#c06cff', '#ff7a59', '#f5f5f5'];
const MIN_SPAN_DEG = 0.012; // ~1.3 km
export const MARKER_R = 22;

export function routeColor(mode, route) {
  if (mode === 'metro') return METRO_LINES[route]?.color ?? BUS_LINE;
  return BUS_LINE;
}

/** Push overlapping markers ({x, y} in pixels) apart so each stays readable. */
export function separate(points, minDist = MARKER_R * 2 + 6) {
  const pts = points.map((p) => ({ ...p }));
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        let dx = pts[j].x - pts[i].x;
        let dy = pts[j].y - pts[i].y;
        let d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d < 0.01) {
          dx = Math.cos(j);
          dy = Math.sin(j);
          d = 1;
        }
        const push = (minDist - d) / 2;
        pts[i].x -= (dx / d) * push;
        pts[i].y -= (dy / d) * push;
        pts[j].x += (dx / d) * push;
        pts[j].y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pts;
}

/**
 * @param {{ routes: Array<{ points: number[][], color: string }>,
 *   markers: Array<{ lat: number, lon: number, tag: string, color?: string, estimated?: boolean }>,
 *   stretch?: { points: number[][] } | null, title: string }} opts
 *   estimated: a vehicle placed by the schedule (an L1 train in the tunnel), drawn dashed
 */
export function planRouteMap({ routes, markers, stretch = null, title }) {
  const focus = [...markers.map((m) => [m.lat, m.lon]), ...(stretch?.points ?? [])];
  if (focus.length === 0) return null;
  const bb = bboxOf(focus);
  const spanLat = Math.max(MIN_SPAN_DEG, bb.maxLat - bb.minLat);
  const spanLon = Math.max(MIN_SPAN_DEG, bb.maxLon - bb.minLon);
  const cLat = (bb.minLat + bb.maxLat) / 2;
  const cLon = (bb.minLon + bb.maxLon) / 2;
  const bbox = {
    minLat: cLat - spanLat * 0.65,
    maxLat: cLat + spanLat * 0.65,
    minLon: cLon - spanLon * 0.65,
    maxLon: cLon + spanLon * 0.65,
  };
  return {
    routes,
    markers,
    stretch,
    title,
    view: fitView(bbox, MAP_SIZE, MAP_SIZE, { pad: 120, minZoom: 11, maxZoom: 17 }),
  };
}

/** The stretch of a route shape between two positions, or null. */
export function stretchBetween(shape, a, b) {
  if (!shape || shape.length < 2) return null;
  return sliceBranch(shape, a, b, { maxOffDeg: 0.004 });
}

export async function renderRouteMap(plan, { basemap }) {
  const { view } = plan;
  const px = ([lat, lon]) => project(view, lat, lon);
  let body = '';
  for (const r of plan.routes) {
    if (!r.points || r.points.length < 2) continue;
    body += line(r.points.map(px), { color: r.color, width: 8, opacity: 0.9, casing: 3 });
  }
  if (plan.stretch?.points?.length >= 2) {
    const pts = plan.stretch.points.map(px);
    body += line(pts, { color: '#000', width: 16, opacity: 0.6 });
    body += line(pts, { color: STRETCH, width: 10, opacity: 1, dash: '20 14' });
  }
  const placed = separate(plan.markers.map((m) => ({ ...m, ...px([m.lat, m.lon]) })));
  for (const m of placed) {
    const dash = m.estimated ? ` stroke-dasharray="10 7" fill-opacity="0.75"` : '';
    body +=
      `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${MARKER_R}" fill="${m.color ?? MARKER}" stroke="#fff" stroke-width="4"${dash}/>` +
      `<text x="${m.x.toFixed(1)}" y="${(m.y + 8).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="23" font-weight="800" fill="#fff">${escapeXml(m.tag)}</text>`;
  }
  body += titlePill(plan.title, { width: view.width });
  return composite(await basemap(view), body, { width: view.width, height: view.height });
}
