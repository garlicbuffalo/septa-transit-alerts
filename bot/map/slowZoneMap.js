// The weekly slow-zones map: each zone drawn along its street in the speed
// maps' colours, numbered slowest first.
import { bandFor, bandsFor } from '../../src/lib/speedBands.js';
import { composite, legend, line, pill, titlePill } from './draw.js';
import { bboxOf, fitView, project } from './projection.js';

export const SLOW_ZONE_MAP_SIZE = 1200;
const MIN_SPAN_DEG = 0.03;
// Where a zone's number may sit relative to its middle, in order of preference, and how far
// apart two numbers must be (pixels).
const LABEL_OFFSETS = [
  [0, -30],
  [0, 32],
  [-36, 0],
  [36, 0],
  [-32, -30],
  [32, -30],
  [-32, 32],
  [32, 32],
  [0, -62],
  [0, 64],
];
const LABEL_CLEAR = 44;

/**
 * @param {{ zones: Array<{ mode: string, route: string, mph: number, points: number[][] }>,
 *   title: string, basemap: Function }} opts zones in rank order
 * @returns {Promise<Buffer>} JPEG
 */
export async function renderSlowZoneMap({ zones, title, basemap }) {
  const size = SLOW_ZONE_MAP_SIZE;
  const bb = bboxOf(zones.flatMap((z) => z.points));
  const cLat = (bb.minLat + bb.maxLat) / 2;
  const cLon = (bb.minLon + bb.maxLon) / 2;
  const hLat = Math.max(MIN_SPAN_DEG, bb.maxLat - bb.minLat) / 2;
  const hLon = Math.max(MIN_SPAN_DEG, bb.maxLon - bb.minLon) / 2;
  const view = fitView(
    { minLat: cLat - hLat, maxLat: cLat + hLat, minLon: cLon - hLon, maxLon: cLon + hLon },
    size,
    size,
    { pad: 150, minZoom: 10, maxZoom: 15 },
  );
  const px = ([lat, lon]) => project(view, lat, lon);
  let lines = '';
  // Slowest last, so it's drawn on top.
  const drawn = zones.map((z) => {
    const kind = z.mode === 'regional_rail' ? 'rail' : z.mode;
    return { band: bandFor(bandsFor(kind, z.route), z.mph), pts: z.points.map(px) };
  });
  const bandsSeen = new Map();
  for (const d of [...drawn].reverse()) {
    bandsSeen.set(d.band.label, d.band);
    lines += line(d.pts, { color: d.band.color, width: 12, casing: 4 });
  }
  // Each zone's number beside its middle, slowest placed first: above it, or wherever nearby
  // is clear of the numbers already placed (zones crowd together downtown).
  const placed = [];
  let labels = '';
  drawn.forEach((d, i) => {
    const mid = d.pts[Math.floor(d.pts.length / 2)];
    const spot = LABEL_OFFSETS.map(([dx, dy]) => ({ x: mid.x + dx, y: mid.y + dy })).find((p) =>
      placed.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= LABEL_CLEAR),
    ) ?? { x: mid.x, y: mid.y - 30 };
    placed.push(spot);
    labels += pill(String(i + 1), {
      x: spot.x,
      y: spot.y,
      size: 26,
      anchor: 'center',
      padX: 12,
      padY: 7,
    }).svg;
  });
  let body = lines + labels;
  body += legend(
    [...bandsSeen.values()].map((b) => ({ label: b.label, color: b.color, width: 10 })),
    { height: size },
  );
  body += titlePill(title, { width: size });
  return composite(await basemap(view), body, { width: size, height: size });
}
