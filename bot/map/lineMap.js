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

// Where a station's label can go: beside its dot on either side, level with it first, then
// nudged up or down (with a leader line back to the dot).
const LABEL_SIZE = 26;
const LABEL_GAP = 18;
const LABEL_STEPS = [0, -40, 40, -80, 80, -120, 120];
// Kept clear: the title along the top, the map credit in the bottom-right corner.
const TITLE_BOTTOM = 100;
const CREDIT = { w: 420, h: 40 };

/**
 * Lay out station labels so they don't cover each other, the station dots, the title or the
 * credit, or run off the image. Each label tries both sides of its dot, level first, then nudged
 * further away; it takes the first spot that's clear, else (a stretch's end, `keep`) the one that
 * overlaps least. A label with no clear spot that isn't an end is left off: its dot still shows.
 * @param {Array<{ name: string, x: number, y: number, keep?: boolean }>} labels most important first
 * @param {{ width: number, height: number, dots?: Array<{ x: number, y: number, r: number }> }} opts
 * @returns {string} SVG
 */
export function placeLabels(labels, { width, height, dots = [] }) {
  const boxes = [];
  const pad = 4;
  const area = (a, b) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left) + pad) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + pad);
  const blockers = [
    { left: 0, top: 0, right: width, bottom: TITLE_BOTTOM },
    { left: width - CREDIT.w, top: height - CREDIT.h, right: width, bottom: height },
  ];
  // How much a box covers what's already there (labels, dots, title, credit), or runs off.
  const cost = (b, own) => {
    if (b.left < 8 || b.right > width - 8 || b.top < 8 || b.bottom > height - 8) return Infinity;
    let c = 0;
    for (const o of [...boxes, ...blockers]) c += area(b, o);
    for (const d of dots) {
      if (d === own) continue;
      c += area(b, { left: d.x - d.r, right: d.x + d.r, top: d.y - d.r, bottom: d.y + d.r });
    }
    return c;
  };
  let svg = '';
  for (const l of labels) {
    const own = dots.find((d) => d.x === l.x && d.y === l.y);
    // Facing the side with more room first.
    const sides = l.x > width / 2 ? ['right', 'left'] : ['left', 'right'];
    let best = null;
    for (const dy of LABEL_STEPS) {
      for (const anchor of sides) {
        const x = anchor === 'left' ? l.x + LABEL_GAP : l.x - LABEL_GAP;
        const label = pill(l.name, { x, y: l.y + dy, size: LABEL_SIZE, anchor });
        const c = cost(label.box, own);
        if (!best || c < best.c) best = { ...label, c, dy, anchor };
        if (c === 0) break;
      }
      if (best?.c === 0) break;
    }
    if (!best || best.c === Infinity || (best.c > 0 && !l.keep)) continue;
    if (best.dy !== 0) {
      // A leader line from the dot to the label's near edge.
      const ex = best.anchor === 'left' ? best.box.left : best.box.right;
      const ey = (best.box.top + best.box.bottom) / 2;
      svg += `<line x1="${l.x.toFixed(1)}" y1="${l.y.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#fff" stroke-opacity="0.7" stroke-width="2"/>`;
    }
    boxes.push(best.box);
    svg += best.svg;
  }
  return svg;
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
  // Station dots, then labels for the named stations: the stretch's ends first.
  const labeled = new Map();
  const dots = [];
  for (const l of plan.lines) {
    for (const s of l.inside) {
      const p = px([s.lat, s.lon]);
      body += dot(p, { r: 6, fill: '#fff', strokeWidth: 2 });
      dots.push({ ...p, r: 8 });
    }
    for (const s of l.marked) {
      const p = px([s.lat, s.lon]);
      body += dot(p, { r: 10, fill: '#fff', stroke: l.color, strokeWidth: 5 });
      dots.push({ ...p, r: 13 });
      labeled.set(s.name, { p, end: s === l.from || s === l.to });
    }
  }
  const order = [...labeled].sort(([, a], [, b]) => Number(b.end) - Number(a.end));
  body += placeLabels(
    order.map(([name, { p, end }]) => ({ name, x: p.x, y: p.y, keep: end })),
    { width: view.width, height: view.height, dots },
  );
  body += titlePill(plan.title, { width: view.width });
  return composite(await basemap(view), body, { width: view.width, height: view.height });
}

/** Plan and render, or null when the alert has no mappable stations. */
export async function renderAlertMap(incident, { basemap }) {
  const plan = planAlertMap(incident);
  return plan ? renderPlan(plan, { basemap }) : null;
}
