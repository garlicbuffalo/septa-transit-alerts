// Horizontal bar charts for recap posts (on-time share by line, gaps by
// route), drawn as SVG and rasterized with sharp. One measure per chart, so
// one hue: the reference palette's dark-surface blue, which clears the
// lightness, chroma, and 3:1 contrast checks on this surface. Bars grow from
// a zero baseline, square there and rounded 4 px at the data end, at most
// 24 px thick; the value sits at the tip in text ink, never the bar color.
import sharp from 'sharp';
import { escapeXml, FONT, textWidth } from './draw.js';

export const CHART = {
  surface: '#1a1a19',
  bar: '#3987e5',
  textPrimary: '#ffffff',
  textSecondary: '#c3c2b7',
  muted: '#898781',
  grid: '#2c2c2a',
};
const WIDTH = 1200;
const ROW = 46;
const BAR = 24;

function barPath(x, y, w, h, r = 4) {
  if (w <= r) return `M${x},${y}h${w}v${h}h${-w}z`;
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`;
}

const text = (x, y, s, { size, color, weight = 400, anchor = 'start' }) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${escapeXml(s)}</text>`;

/**
 * @param {{ title: string, subtitle?: string, rows: Array<{ label: string, value: number,
 *   display?: string }>, max?: number, ticks?: number[], tickFormat?: (v: number) => string,
 *   note?: string }} opts
 * @returns {{ svg: string, width: number, height: number }}
 */
export function barChartSvg({
  title,
  subtitle = null,
  rows,
  max = null,
  ticks = null,
  tickFormat = String,
  note = null,
}) {
  const top = subtitle ? 150 : 110;
  const labelW = Math.min(420, Math.max(...rows.map((r) => textWidth(r.label, 26))) + 24);
  const left = 48 + labelW;
  const right = WIDTH - 140; // room for the value at the tip
  const height = top + rows.length * ROW + (note ? 110 : 70);
  const hi = max ?? Math.max(1, ...rows.map((r) => r.value));
  const x = (v) => left + ((right - left) * Math.max(0, Math.min(v, hi))) / hi;

  let svg = `<rect width="${WIDTH}" height="${height}" fill="${CHART.surface}"/>`;
  svg += text(48, 70, title, { size: 40, color: CHART.textPrimary, weight: 700 });
  if (subtitle) svg += text(48, 114, subtitle, { size: 26, color: CHART.textSecondary });
  const bottom = top + rows.length * ROW;
  for (const t of ticks ?? []) {
    svg += `<line x1="${x(t).toFixed(1)}" y1="${top - 8}" x2="${x(t).toFixed(1)}" y2="${bottom}" stroke="${CHART.grid}" stroke-width="1"/>`;
    svg += text(x(t), bottom + 30, tickFormat(t), {
      size: 20,
      color: CHART.muted,
      anchor: 'middle',
    });
  }
  rows.forEach((r, i) => {
    const cy = top + i * ROW + ROW / 2;
    svg += text(left - 20, cy + 9, r.label, {
      size: 26,
      color: CHART.textSecondary,
      anchor: 'end',
    });
    const w = x(r.value) - left;
    if (w > 0) svg += `<path d="${barPath(left, cy - BAR / 2, w, BAR)}" fill="${CHART.bar}"/>`;
    svg += text(left + w + 12, cy + 9, r.display ?? String(r.value), {
      size: 24,
      color: CHART.textPrimary,
      weight: 700,
    });
  });
  // The zero baseline.
  svg += `<line x1="${left}" y1="${top - 8}" x2="${left}" y2="${bottom}" stroke="${CHART.muted}" stroke-width="2"/>`;
  if (note) svg += text(48, height - 36, note, { size: 22, color: CHART.muted });
  return { svg, width: WIDTH, height };
}

/** The chart as a JPEG. */
export async function renderBarChart(opts) {
  const { svg, width, height } = barChartSvg(opts);
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg>`;
  return sharp(Buffer.from(doc)).jpeg({ quality: 90 }).toBuffer();
}
