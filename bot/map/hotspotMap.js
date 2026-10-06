// Hotspot maps for the recaps: one bubble per place, sized by how many
// events happened there (area grows with the log of the count, so one busy
// corner doesn't swamp the rest). One measure, one hue. Modeled on
// cta-insights' bunching heatmaps (ISC).
import { composite, escapeXml, FONT, titlePill } from './draw.js';
import { bboxOf, fitView, project } from './projection.js';

export const HOTSPOT_SIZE = 1200;
const BUBBLE = '#ff2a6d';
const MIN_SPAN_DEG = 0.03;

export const bubbleRadius = (n) => 12 + 14 * Math.log2(n + 1);

/**
 * @param {{ spots: Array<{ lat: number, lon: number, count: number }>, title: string,
 *   basemap: Function }} opts
 * @returns {Promise<Buffer>} JPEG
 */
export async function renderHotspotMap({ spots, title, basemap }) {
  const size = HOTSPOT_SIZE;
  const bb = bboxOf(spots);
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
  let circles = '';
  let labels = '';
  // Biggest first, so smaller bubbles stay visible on top; every count is
  // drawn above all the bubbles, outlined, so an overlap never hides one.
  for (const s of [...spots].sort((a, b) => b.count - a.count)) {
    const p = project(view, s.lat, s.lon);
    const r = bubbleRadius(s.count);
    circles += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${BUBBLE}" fill-opacity="0.55" stroke="#fff" stroke-width="2"/>`;
    labels += `<text x="${p.x.toFixed(1)}" y="${(p.y + 8).toFixed(1)}" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="800" fill="#fff" stroke="#0b0d10" stroke-width="4" paint-order="stroke">${escapeXml(String(s.count))}</text>`;
  }
  let body = circles + labels;
  body += titlePill(title, { width: size });
  return composite(await basemap(view), body, { width: size, height: size });
}
