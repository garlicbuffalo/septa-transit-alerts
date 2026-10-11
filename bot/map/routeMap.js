// Maps for vehicle detections: a route's line, the vehicles involved as
// numbered or lettered markers, and for gaps the empty stretch dashed between
// them. Also draws several routes at once (cross-route clusters). Modeled on
// cta-insights' bunching and gap maps (ISC).
import { METRO_LINES } from '../../src/lib/metroLines.js';
import { g1LegendRows, vehicleShape } from '../lib/routes.js';
import { composite, dotLegend, escapeXml, FONT, line, titlePill, vehicleMark } from './draw.js';
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
 *   markers: Array<{ lat: number, lon: number, tag: string, color?: string, estimated?: boolean,
 *     route?: string, label?: string }>,
 *   dots?: Array<{ lat: number, lon: number, color?: string, route?: string, label?: string }>,
 *   stretch?: { points: number[][] } | null, title: string,
 *   legend?: Array<{ label: string, color: string, shape?: string }> | null,
 *   fit?: number[][] | null }} opts
 *   estimated: a vehicle placed by the schedule (an L1 train in the tunnel), drawn dashed;
 *   route and label: the vehicle's, so a G1 vehicle is drawn as an outline of a PCC trolley or a
 *   bus (lib/routes.js vehicleShape), with a legend saying which is which; dots: unnumbered
 *   vehicles drawn small, for context; fit: [lat, lon] points the view must show instead of
 *   framing the markers (a whole line)
 */
export function planRouteMap({
  routes,
  markers: rawMarkers,
  dots: rawDots = [],
  stretch = null,
  title,
  legend = null,
  fit = null,
}) {
  const shaped = (m) => ({ ...m, shape: vehicleShape(m.route, m.label) });
  const markers = rawMarkers.map(shaped);
  const dots = rawDots.map(shaped);
  const focus = [...markers.map((m) => [m.lat, m.lon]), ...(stretch?.points ?? [])];
  if (focus.length === 0) return null;
  const legendRows = legend ?? g1LegendRows([...markers, ...dots]);
  const plan = {
    routes,
    markers,
    dots,
    stretch,
    title,
    legend: legendRows.length ? legendRows : null,
  };
  if (fit?.length) {
    const view = fitView(bboxOf([...fit, ...focus]), MAP_SIZE, MAP_SIZE, {
      pad: 120,
      minZoom: 11,
      maxZoom: 16,
    });
    return { ...plan, view };
  }
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
    ...plan,
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
  // Unnumbered context vehicles (`dots`: { lat, lon, color?, shape? }), under the markers.
  for (const d of plan.dots ?? []) {
    const p = px([d.lat, d.lon]);
    body += vehicleMark(p.x, p.y, 11, {
      shape: d.shape,
      fill: d.color ?? '#e8eaed',
      fillOpacity: 0.9,
      stroke: '#0b0d10',
      detail: true,
    });
  }
  // Vehicle outlines are wider than a circle: give them more room.
  const outlines = plan.markers.some((m) => m.shape && m.shape !== 'circle');
  const placed = separate(
    plan.markers.map((m) => ({ ...m, ...px([m.lat, m.lon]) })),
    outlines ? MARKER_R * 2.7 + 6 : undefined,
  );
  for (const m of placed) {
    body +=
      vehicleMark(m.x, m.y, MARKER_R, {
        shape: m.shape,
        fill: m.color ?? MARKER,
        strokeWidth: 4,
        ...(m.estimated && { dash: '10 7', fillOpacity: 0.75 }),
      }) +
      `<text x="${m.x.toFixed(1)}" y="${(m.y + 8).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="23" font-weight="800" fill="#fff">${escapeXml(m.tag)}</text>`;
  }
  if (plan.legend?.length) body += dotLegend(plan.legend, { height: view.height, bottom: 0 });
  body += titlePill(plan.title, { width: view.width });
  return composite(await basemap(view), body, { width: view.width, height: view.height });
}
