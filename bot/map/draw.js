// SVG building blocks composited over a basemap with sharp (librsvg). Fonts:
// Inter where installed (the server setup installs fonts-inter), falling back
// to the system sans. Text widths are estimated rather than measured, with
// generous padding, which is plenty for pills and labels.
import sharp from 'sharp';

export const FONT = 'Inter, Helvetica, Arial, sans-serif';

export function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Rough rendered width of text in px. */
export function textWidth(text, size, { bold = false } = {}) {
  let em = 0;
  for (const ch of String(text)) {
    if (ch === ' ') em += 0.28;
    else if (/[il.,:;'|!]/.test(ch)) em += 0.3;
    else if (/[mwMW@]/.test(ch)) em += 0.86;
    else if (/[A-Z0-9]/.test(ch)) em += 0.66;
    else if (/[←-⯿\u{1f300}-\u{1faff}]/u.test(ch)) em += 1.1;
    else em += 0.56;
  }
  return em * size * (bold ? 1.06 : 1);
}

/** Path data through pixel points. */
export function pathData(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

/** A stroked line with an optional dark casing beneath it. */
export function line(points, { color, width = 8, opacity = 1, casing = 0, dash = null }) {
  if (points.length < 2) return '';
  const d = pathData(points);
  const common = 'fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const under = casing
    ? `<path d="${d}" ${common} stroke="#000" stroke-opacity="${Math.min(1, opacity + 0.2)}" stroke-width="${width + casing * 2}"/>`
    : '';
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  return `${under}<path d="${d}" ${common} stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width}"${dashAttr}/>`;
}

export function dot(p, { r = 8, fill = '#fff', stroke = '#000', strokeWidth = 3 } = {}) {
  return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`;
}

/**
 * A rounded label. `anchor` places the pill relative to (x, y): 'left' puts
 * it to the right of the point, 'right' to the left, 'center' centered.
 */
export function pill(
  text,
  {
    x,
    y,
    size = 28,
    bold = true,
    fill = 'rgba(15,17,21,0.88)',
    color = '#fff',
    anchor = 'left',
    padX = 14,
    padY = 9,
  },
) {
  const w = textWidth(text, size, { bold }) + padX * 2;
  const h = size + padY * 2;
  let left = x;
  if (anchor === 'right') left = x - w;
  if (anchor === 'center') left = x - w / 2;
  const top = y - h / 2;
  return {
    svg:
      `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
      `<text x="${(left + padX).toFixed(1)}" y="${(top + padY + size * 0.82).toFixed(1)}" font-family="${FONT}" font-size="${size}" font-weight="${bold ? 700 : 500}" fill="${color}">${escapeXml(text)}</text>`,
    box: { left, top, right: left + w, bottom: top + h },
  };
}

/** Title pill across the top, shrinking the font until it fits. */
export function titlePill(text, { width, top = 28, maxSize = 40, minSize = 22, margin = 28 }) {
  let size = maxSize;
  while (size > minSize && textWidth(text, size, { bold: true }) + 48 > width - margin * 2)
    size -= 2;
  return pill(text, { x: margin, y: top + (size + 24) / 2, size, padX: 24, padY: 12 }).svg;
}

/** Small legend rows (color swatch + text) at the bottom-left. */
export function legend(rows, { height, margin = 28, size = 24 }) {
  const rowH = size + 14;
  const w = Math.max(...rows.map((r) => textWidth(r.label, size))) + 80;
  const h = rows.length * rowH + 20;
  const top = height - margin - h;
  let svg = `<rect x="${margin}" y="${top}" width="${w.toFixed(0)}" height="${h}" rx="14" fill="rgba(15,17,21,0.85)"/>`;
  rows.forEach((r, i) => {
    const cy = top + 10 + rowH * i + rowH / 2;
    svg += `<line x1="${margin + 18}" y1="${cy}" x2="${margin + 50}" y2="${cy}" stroke="${r.color}" stroke-width="${r.width ?? 8}" stroke-opacity="${r.opacity ?? 1}" stroke-linecap="round"/>`;
    svg += `<text x="${margin + 62}" y="${cy + size * 0.35}" font-family="${FONT}" font-size="${size}" fill="#e8eaed">${escapeXml(r.label)}</text>`;
  });
  return svg;
}

/** Composite SVG over a basemap and encode as JPEG. */
export async function composite(basemap, svgBody, { width, height, quality = 88 }) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgBody}</svg>`;
  return sharp(basemap)
    .resize(width, height)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
}
