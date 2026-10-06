// "Where is this alert?" maps for SEPTA Metro and Regional Rail: the line
// drawn dim, the stretch the alert names drawn bright, its end stations
// labeled. Built from the site's reference data (GTFS shapes and station
// rosters) and the collector's parse of the alert (official_alert.scope).
// Modeled on cta-insights' segment-dim disruption maps (ISC).

import metroShapes from '../../src/lib/metroLineShapes.json' with { type: 'json' };
import { METRO_LINES } from '../../src/lib/metroLines.js';
import metroStations from '../../src/lib/metroStations.json' with { type: 'json' };
import railShapes from '../../src/lib/railLineShapes.json' with { type: 'json' };
import { RAIL_LINES } from '../../src/lib/railLines.js';
import railStations from '../../src/lib/railStations.json' with { type: 'json' };
import { routesLabel } from '../lib/routes.js';
import { composite, dot, line, pill, titlePill } from './draw.js';
import { bboxOf, fitView, project } from './projection.js';

export const MAP_SIZE = 1200;
const MIN_SPAN_DEG = 0.025; // ~2.5 km: never zoom in past street-block scale

/** Ordered stations on a line: [{ name, lat, lon }]. */
export function lineStations(mode, line) {
  if (mode === 'regional_rail') return railStations[line] ?? [];
  return metroStations
    .filter((s) => s.seq?.[line] != null)
    .sort((a, b) => a.seq[line] - b.seq[line]);
}

/** Branch polylines of a line: [[[lat, lon], …], …]. */
export function lineShape(mode, line) {
  return (mode === 'regional_rail' ? railShapes[line] : metroShapes[line]) ?? [];
}

export function lineColor(mode, line) {
  if (mode === 'regional_rail') return RAIL_LINES[line]?.color ?? '#4F758B';
  return METRO_LINES[line]?.color ?? '#9aa0a6';
}

// Closest point on a branch to (lat, lon): { index (segment start), t, point, dist }.
function locate(branch, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = null;
  for (let i = 0; i < branch.length - 1; i++) {
    const [aLat, aLon] = branch[i];
    const [bLat, bLon] = branch[i + 1];
    const ax = aLon * k;
    const bx = bLon * k;
    const px = lon * k;
    const dx = bx - ax;
    const dy = bLat - aLat;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (lat - aLat) * dy) / len2)) : 0;
    const qx = ax + t * dx;
    const qy = aLat + t * dy;
    const dist = Math.hypot(px - qx, lat - qy);
    if (!best || dist < best.dist) {
      best = { index: i, t, point: [aLat + t * (bLat - aLat), aLon + t * (bLon - aLon)], dist };
    }
  }
  return best;
}

/** The part of a branch between two coordinates, or null if either is far off it. */
export function sliceBranch(branch, a, b, { maxOffDeg = 0.006 } = {}) {
  if (branch.length < 2) return null;
  let p = locate(branch, a.lat, a.lon);
  let q = locate(branch, b.lat, b.lon);
  if (!p || !q || p.dist > maxOffDeg || q.dist > maxOffDeg) return null;
  if (q.index < p.index || (q.index === p.index && q.t < p.t)) [p, q] = [q, p];
  return [p.point, ...branch.slice(p.index + 1, q.index + 1), q.point];
}

function stationByName(stations, name) {
  const key = String(name ?? '').toLowerCase();
  return stations.find((s) => s.name.toLowerCase() === key) ?? null;
}

/**
 * Plan the map for an official incident, or null when there is nothing to
 * show beyond the post text (bus alerts, no named stations).
 */
export function planAlertMap(incident) {
  const { mode } = incident;
  if (mode !== 'metro' && mode !== 'regional_rail') return null;
  const scope = incident.official_alert?.scope ?? {};
  const named = [
    ...new Set([scope.from_station, scope.to_station, ...(scope.stations ?? [])].filter(Boolean)),
  ];
  if (named.length === 0) return null;

  const lines = [];
  for (const route of incident.routes ?? []) {
    const stations = lineStations(mode, route);
    const branches = lineShape(mode, route);
    if (stations.length === 0 || branches.length === 0) continue;
    const from = stationByName(stations, scope.from_station);
    const to = stationByName(stations, scope.to_station);
    let stretch = null;
    if (from && to && from !== to) {
      for (const branch of branches) {
        stretch = sliceBranch(branch, from, to);
        if (stretch) break;
      }
    }
    const marked = named.map((n) => stationByName(stations, n)).filter(Boolean);
    if (!stretch && marked.length === 0) continue;
    // Stations inside the stretch get dots; the named ones get labels.
    let inside = [];
    if (stretch && from && to) {
      const i = stations.indexOf(from);
      const j = stations.indexOf(to);
      inside = stations.slice(Math.min(i, j), Math.max(i, j) + 1);
    }
    lines.push({
      route,
      color: lineColor(mode, route),
      branches,
      stretch,
      inside,
      marked,
      from,
      to,
    });
  }
  if (lines.length === 0) return null;

  // Frame the affected part with some line on either side for context.
  const focus = lines.flatMap((l) => [
    ...(l.stretch ?? []),
    ...l.marked.map((s) => [s.lat, s.lon]),
  ]);
  const bb = bboxOf(focus);
  const padLat = Math.max(MIN_SPAN_DEG, bb.maxLat - bb.minLat) * 0.35;
  const padLon = Math.max(MIN_SPAN_DEG, bb.maxLon - bb.minLon) * 0.35;
  const bbox = {
    minLat: bb.minLat - padLat,
    maxLat: bb.maxLat + padLat,
    minLon: bb.minLon - padLon,
    maxLon: bb.maxLon + padLon,
  };
  const first = lines[0];
  const label = routesLabel(
    mode,
    lines.map((l) => l.route),
  );
  const where =
    first.from && first.to && first.stretch
      ? `${first.from.name} ↔ ${first.to.name}`
      : first.marked.map((s) => s.name).join(', ');
  return {
    mode,
    lines,
    view: fitView(bbox, MAP_SIZE, MAP_SIZE, { pad: 150, maxZoom: 15 }),
    title: `⚠ ${label} · ${where}`,
  };
}

/** Render a plan to JPEG. */
export async function renderPlan(plan, { basemap }) {
  const { view } = plan;
  const px = (pt) => project(view, pt[0], pt[1]);
  let body = '';
  // Whole lines, dim.
  for (const l of plan.lines) {
    for (const branch of l.branches) {
      body += line(branch.map(px), { color: l.color, width: 8, opacity: 0.45, casing: 2 });
    }
  }
  // Affected stretches, bright with a light casing so they read on dark tiles.
  for (const l of plan.lines) {
    if (!l.stretch) continue;
    const pts = l.stretch.map(px);
    body += line(pts, { color: '#ffffff', width: 20, opacity: 0.9 });
    body += line(pts, { color: l.color, width: 13, opacity: 1 });
  }
  // Station dots, then labels for the named stations.
  const labeled = new Map();
  for (const l of plan.lines) {
    for (const s of l.inside)
      body += dot(px([s.lat, s.lon]), { r: 6, fill: '#fff', strokeWidth: 2 });
    for (const s of l.marked) {
      body += dot(px([s.lat, s.lon]), { r: 10, fill: '#fff', stroke: l.color, strokeWidth: 5 });
      labeled.set(s.name, px([s.lat, s.lon]));
    }
  }
  // Labels beside their dots, nudged up or down until they don't overlap.
  const placed = [];
  const overlaps = (b) =>
    placed.some(
      (o) => b.left < o.right && b.right > o.left && b.top < o.bottom + 4 && b.bottom > o.top - 4,
    );
  for (const [name, p] of labeled) {
    const anchor = p.x > view.width * 0.62 ? 'right' : 'left';
    const x = anchor === 'left' ? p.x + 18 : p.x - 18;
    let label = null;
    for (const dy of [0, -46, 46, -92, 92, -138, 138]) {
      label = pill(name, { x, y: p.y + dy, size: 26, anchor });
      if (!overlaps(label.box)) break;
    }
    placed.push(label.box);
    body += label.svg;
  }
  body += titlePill(plan.title, { width: view.width });
  return composite(await basemap(view), body, { width: view.width, height: view.height });
}

/** Plan and render, or null when the alert has no mappable stations. */
export async function renderAlertMap(incident, { basemap }) {
  const plan = planAlertMap(incident);
  return plan ? renderPlan(plan, { basemap }) : null;
}
