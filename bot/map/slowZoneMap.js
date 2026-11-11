// The weekly slow-zones map: each zone drawn along its street in the speed
// maps' colours, numbered slowest first.
import { bandFor, bandsFor } from '../../src/lib/speedBands.js';
import { composite, legend, line, pill, titlePill } from './draw.js';
import { bboxOf, fitView, project } from './projection.js';

export const SLOW_ZONE_MAP_SIZE = 1200;
const MIN_SPAN_DEG = 0.03;

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
  let labels = '';
  const bandsSeen = new Map();
  // Slowest last, so it's drawn on top.
  [...zones.entries()].reverse().forEach(([i, z]) => {
    const kind = z.mode === 'regional_rail' ? 'rail' : z.mode;
    const band = bandFor(bandsFor(kind, z.route), z.mph);
    bandsSeen.set(band.label, band);
    const pts = z.points.map(px);
    lines += line(pts, { color: band.color, width: 12, casing: 4 });
    const mid = pts[Math.floor(pts.length / 2)];
    labels += pill(String(i + 1), {
      x: mid.x,
      y: mid.y - 30,
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
