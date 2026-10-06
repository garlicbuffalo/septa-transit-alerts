// Speed maps: a route or line drawn in stretches colored by how fast its
// vehicles moved there, gray where there was no data. Modeled on
// cta-insights' speedmaps (ISC), including its traffic-light colors, which
// match the colored squares the post text uses as its legend.
import { sliceAlong } from '../lib/geo.js';
import { composite, legend, line, titlePill } from './draw.js';
import { bboxOf, fitView, project } from './projection.js';

export const SPEED_MAP_SIZE = 1200;
export const NO_DATA = '#4a4a48';

/** Color bands: road vehicles (buses, trolleys, M1) and Regional Rail. */
export const SPEED_BANDS = {
  road: [
    { below: 5, color: '#ff2a2a', emoji: '🟥', label: 'under 5 mph' },
    { below: 10, color: '#ff8c1a', emoji: '🟧', label: '5–10' },
    { below: 15, color: '#ffd21a', emoji: '🟨', label: '10–15' },
    { below: Infinity, color: '#2ad17f', emoji: '🟩', label: '15+ mph' },
  ],
  rail: [
    { below: 15, color: '#ff2a2a', emoji: '🟥', label: 'under 15 mph' },
    { below: 25, color: '#ff8c1a', emoji: '🟧', label: '15–25' },
    { below: 35, color: '#ffd21a', emoji: '🟨', label: '25–35' },
    { below: 45, color: '#a855f7', emoji: '🟪', label: '35–45' },
    { below: Infinity, color: '#2ad17f', emoji: '🟩', label: '45+ mph' },
  ],
};

export const bandFor = (bands, mph) => bands.find((b) => mph < b.below) ?? bands.at(-1);

/**
 * @param {{ measured: { points: number[][], cum: number[], length: number },
 *   bins: Array<{ mph: number } | null>, binM: number, bands: object[], title: string,
 *   basemap: Function }} opts
 * @returns {Promise<Buffer>} JPEG
 */
export async function renderSpeedMap({ measured, bins, binM, bands, title, basemap }) {
  const size = SPEED_MAP_SIZE;
  const view = fitView(bboxOf(measured.points), size, size, {
    pad: 140,
    minZoom: 9,
    maxZoom: 15,
  });
  const px = ([lat, lon]) => project(view, lat, lon);
  const all = measured.points.map(px);
  let body = line(all, { color: '#000', width: 20, opacity: 0.75 });
  body += line(all, { color: NO_DATA, width: 11, opacity: 1 });
  bins.forEach((b, i) => {
    if (!b) return;
    const from = i * binM;
    const to = Math.min(measured.length, (i + 1) * binM);
    const pts = sliceAlong(measured, from, to).map(px);
    body += line(pts, { color: bandFor(bands, b.mph).color, width: 11, opacity: 1 });
  });
  body += legend(
    [
      ...[...bands].reverse().map((b) => ({ label: b.label, color: b.color, width: 10 })),
      { label: 'no data', color: NO_DATA, width: 10 },
    ],
    { height: size },
  );
  body += titlePill(title, { width: size });
  return composite(await basemap(view), body, { width: size, height: size });
}
