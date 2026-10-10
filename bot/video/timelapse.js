// Timelapse rendering: the basemap and route lines are drawn once, then each
// frame composites that moment's vehicles and HUD (title, live readout, clock,
// progress bar) on top and goes straight to ffmpeg. The last frame holds for
// a second so the ending is readable. Modeled on cta-insights' timelapses (ISC).
import sharp from 'sharp';
import { escapeXml, FONT, pill, textWidth, titlePill } from '../map/draw.js';
import { encodeMp4, FPS } from './encode.js';

export { clockLabel, clockRange } from '../lib/clock.js';

export const VIDEO_SIZE = 1080;

/** Elapsed time as "+3:45". */
export function elapsedLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function svgDoc(body, width, height) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
  );
}

/**
 * Heads-up display: title pill, a live readout under it, the clock at the
 * bottom right, and a progress bar along the bottom edge.
 */
export function hud({ title, readout = null, clock, progress, width, height }) {
  let svg = titlePill(title, { width, maxSize: 36 });
  if (readout) svg += pill(readout, { x: 28, y: 136, size: 26, padX: 16, padY: 9 }).svg;
  svg += pill(clock, { x: width - 28, y: height - 56, size: 28, anchor: 'right' }).svg;
  const p = Math.max(0, Math.min(1, progress));
  svg += `<rect x="0" y="${height - 10}" width="${width}" height="10" fill="#fff" fill-opacity="0.18"/>`;
  svg += `<rect x="0" y="${height - 10}" width="${(width * p).toFixed(1)}" height="10" fill="#fff" fill-opacity="0.85"/>`;
  return svg;
}

/**
 * Dot legend rows at the bottom left, above the progress bar: [{ label, color, dashed? }], dashed
 * for vehicles placed by the schedule.
 */
export function dotLegend(rows, { height, margin = 28, size = 22 }) {
  const rowH = size + 12;
  const w = Math.max(...rows.map((r) => textWidth(r.label, size))) + 64; // + swatch, padding
  const h = rows.length * rowH + 18;
  const top = height - margin - 24 - h;
  let svg = `<rect x="${margin}" y="${top}" width="${w.toFixed(0)}" height="${h}" rx="14" fill="rgba(15,17,21,0.85)"/>`;
  rows.forEach((r, i) => {
    const cy = top + 9 + rowH * i + rowH / 2;
    svg += r.dashed
      ? `<circle cx="${margin + 24}" cy="${cy}" r="8" fill="${r.color}" fill-opacity="0.45" stroke="#fff" stroke-width="2" stroke-dasharray="4 3"/>`
      : `<circle cx="${margin + 24}" cy="${cy}" r="8" fill="${r.color}" stroke="#0b0d10" stroke-width="2"/>`;
    svg += `<text x="${margin + 44}" y="${(cy + size * 0.35).toFixed(1)}" font-family="${FONT}" font-size="${size}" fill="#e8eaed">${escapeXml(r.label)}</text>`;
  });
  return svg;
}

/** Evenly spaced frame times from start to end. */
export function frameTimes(start, end, frames) {
  if (frames <= 1) return [end];
  return Array.from({ length: frames }, (_, i) => start + ((end - start) * i) / (frames - 1));
}

/**
 * Render a scene to an MP4.
 * @param {{ view: {lat:number, lon:number, zoom:number, width:number, height:number},
 *   staticSvg: string, drawFrame: (t: number, progress: number) => string,
 *   start: number, end: number, basemap: Function, frames?: number, fps?: number,
 *   holdS?: number, encode?: typeof encodeMp4, ffmpeg?: string }} opts
 * @returns {Promise<{ data: Buffer, width: number, height: number, frames: number }>}
 */
export async function renderTimelapse({
  view,
  staticSvg,
  drawFrame,
  start,
  end,
  basemap,
  frames = 160,
  fps = FPS,
  holdS = 1,
  encode = encodeMp4,
  ffmpeg,
}) {
  const { width, height } = view;
  const base = await sharp(await basemap(view))
    .resize(width, height)
    .composite([{ input: svgDoc(staticSvg, width, height), top: 0, left: 0 }])
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const raw = { width, height, channels: base.info.channels };
  const times = frameTimes(start, end, frames);
  const frame = (t, i) =>
    sharp(base.data, { raw })
      .composite([
        { input: svgDoc(drawFrame(t, i / Math.max(1, times.length - 1)), width, height) },
      ])
      .jpeg({ quality: 85 })
      .toBuffer();
  async function* all() {
    let last = null;
    for (let i = 0; i < times.length; i++) {
      last = await frame(times[i], i);
      yield last;
    }
    for (let i = 0; i < Math.round(fps * holdS); i++) yield last;
  }
  const data = await encode(all(), { fps, ...(ffmpeg && { ffmpeg }) });
  return { data, width, height, frames: times.length };
}
