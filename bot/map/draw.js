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

// How much wider than a circle of the same radius each outline is (for spacing markers apart).
export const MARK_WIDTH = { circle: 2, trolley: 2.7, bus: 2.7, m1: 2.9, rail: 3.4 };

/**
 * A vehicle's mark centered on (x, y), about as heavy as a circle of radius r: a circle, or a
 * side-view outline of the vehicle, facing right:
 *   trolley  rounded ends, a trolley pole raked back to the wire, paired wheels
 *   bus      a boxy body on two big wheels
 *   m1       an M1 (Norristown High Speed Line) car: a squared-off body with a raked cab, roof
 *            equipment, and two bogies (third rail, so no pole)
 *   rail     a two-car Regional Rail train: a long body with a sloped nose, a pantograph, and the
 *            coupling between the cars
 * `detail` adds the windows (left off when a number is drawn on top).
 * @param {{ shape?: 'circle' | 'trolley' | 'bus' | 'm1' | 'rail', fill: string, stroke?: string,
 *   strokeWidth?: number, fillOpacity?: number, opacity?: number, dash?: string | null,
 *   detail?: boolean }} opts
 */
export function vehicleMark(
  x,
  y,
  r,
  {
    shape = 'circle',
    fill,
    stroke = '#fff',
    strokeWidth = 3,
    fillOpacity = 1,
    opacity = 1,
    dash = null,
    detail = false,
  },
) {
  const f = (n) => n.toFixed(1);
  // The pole, roof gear, and wheel rims take the outline's color, or the fill's when the outline
  // is dark (small marks on the dark map), so they stay visible.
  const light = /^#(0b0d10|000|000000)$/i.test(stroke) ? fill : stroke;
  const paint =
    `fill="${fill}" fill-opacity="${fillOpacity}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"` +
    (dash ? ` stroke-dasharray="${dash}"` : '');
  if (!MARK_WIDTH[shape] || shape === 'circle') {
    return `<circle cx="${f(x)}" cy="${f(y)}" r="${r}" ${paint} opacity="${opacity}"/>`;
  }
  const w = r * MARK_WIDTH[shape];
  const h = r * 1.45;
  const left = x - w / 2;
  const right = x + w / 2;
  const top = y - h / 2 - h * 0.08; // nudged up, so the wheels below keep it centered
  const bottom = top + h;
  const thin = f(Math.max(1.5, strokeWidth * 0.8));
  const wheel = (at, wr) =>
    `<circle cx="${f(left + w * at)}" cy="${f(bottom)}" r="${f(h * wr)}" fill="#0b0d10" stroke="${light}" stroke-width="${f(Math.max(1, strokeWidth * 0.6))}"/>`;
  const pane = (x0, y0, pw, ph, rr = h * 0.05) =>
    `<rect x="${f(x0)}" y="${f(y0)}" width="${f(pw)}" height="${f(ph)}" rx="${f(rr)}" fill="#0b0d10" fill-opacity="0.55"/>`;
  const poly = (pts) =>
    `<path d="M${pts.map(([px, py]) => `${f(px)},${f(py)}`).join(' L')} Z" ${paint}/>`;
  let svg = `<g opacity="${opacity}">`;
  if (shape === 'trolley') {
    svg += `<line x1="${f(left + w * 0.34)}" y1="${f(top)}" x2="${f(left + w * 0.06)}" y2="${f(top - h * 0.62)}" stroke="${light}" stroke-width="${thin}" stroke-linecap="round"/>`;
    for (const at of [0.17, 0.3, 0.7, 0.83]) svg += wheel(at, 0.13);
    svg += `<rect x="${f(left)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" rx="${f(h * 0.48)}" ${paint}/>`;
    if (detail) svg += pane(left + w * 0.12, top + h * 0.18, w * 0.76, h * 0.3, h * 0.15);
  } else if (shape === 'bus') {
    for (const at of [0.22, 0.78]) svg += wheel(at, 0.21);
    svg += `<rect x="${f(left)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" rx="${f(h * 0.14)}" ${paint}/>`;
    if (detail) {
      for (let i = 0; i < 4; i++)
        svg += pane(left + w * (0.08 + i * 0.19), top + h * 0.16, w * 0.15, h * 0.32);
      svg += pane(left + w * 0.86, top + h * 0.16, w * 0.08, h * 0.5, h * 0.04);
    }
  } else if (shape === 'm1') {
    // Roof equipment, then the bogies, then the body with its raked cab at the front.
    svg += `<rect x="${f(left + w * 0.32)}" y="${f(top - h * 0.2)}" width="${f(w * 0.3)}" height="${f(h * 0.24)}" rx="${f(h * 0.05)}" fill="${light}"/>`;
    for (const at of [0.14, 0.26, 0.7, 0.82]) svg += wheel(at, 0.12);
    svg += poly([
      [left, top + h * 0.06],
      [right - h * 0.42, top],
      [right, top + h * 0.38],
      [right, bottom],
      [left, bottom],
    ]);
    if (detail) {
      for (let i = 0; i < 3; i++)
        svg += pane(left + w * (0.07 + i * 0.22), top + h * 0.2, w * 0.17, h * 0.3);
    }
  } else {
    // Regional Rail: the pantograph, the bogies, the body with a sloped nose, the coupling.
    const px = left + w * 0.3;
    const pw = w * 0.09;
    const ph = h * 0.5;
    svg += `<path d="M${f(px - pw)},${f(top)} L${f(px)},${f(top - ph)} L${f(px + pw)},${f(top)} M${f(px - pw * 1.2)},${f(top - ph)} L${f(px + pw * 1.2)},${f(top - ph)}" fill="none" stroke="${light}" stroke-width="${thin}" stroke-linecap="round" stroke-linejoin="round"/>`;
    for (const at of [0.08, 0.17, 0.5, 0.59, 0.76, 0.86]) svg += wheel(at, 0.11);
    svg += poly([
      [left, top + h * 0.08],
      [right - h * 0.7, top],
      [right, top + h * 0.55],
      [right, bottom],
      [left, bottom],
    ]);
    // The coupling, off center so a number drawn on the train stays clear of it.
    const cx = left + w * 0.66;
    svg += `<line x1="${f(cx)}" y1="${f(top + h * 0.02)}" x2="${f(cx)}" y2="${f(bottom)}" stroke="${stroke}" stroke-width="${f(Math.max(1, strokeWidth * 0.6))}"/>`;
    if (detail) {
      // Four windows in the first car, one in the cab car behind its sloped nose.
      for (const at of [0.06, 0.19, 0.32, 0.45, 0.72]) {
        svg += pane(left + w * at, top + h * 0.22, w * 0.1, h * 0.28);
      }
    }
  }
  return `${svg}</g>`;
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

/**
 * Dot legend rows at the bottom left: [{ label, color, dashed?, shape? }], dashed for vehicles
 * placed by the schedule, `shape` for a vehicle outline (see vehicleMark). `bottom` is the space
 * kept clear beneath it.
 */
export function dotLegend(rows, { height, margin = 28, size = 22, bottom = 24 }) {
  const rowH = size + 12;
  const w = Math.max(...rows.map((r) => textWidth(r.label, size))) + 72; // + swatch, padding
  const h = rows.length * rowH + 18;
  const top = height - margin - bottom - h;
  let svg = `<rect x="${margin}" y="${top}" width="${w.toFixed(0)}" height="${h}" rx="14" fill="rgba(15,17,21,0.85)"/>`;
  rows.forEach((r, i) => {
    const cy = top + 9 + rowH * i + rowH / 2;
    svg += vehicleMark(
      margin + 24,
      cy,
      r.shape && r.shape !== 'circle' ? 11 : 8,
      r.dashed
        ? { shape: r.shape, fill: r.color, fillOpacity: 0.45, strokeWidth: 2, dash: '4 3' }
        : { shape: r.shape, fill: r.color, stroke: '#0b0d10', strokeWidth: 2, detail: true },
    );
    svg += `<text x="${margin + 52}" y="${(cy + size * 0.35).toFixed(1)}" font-family="${FONT}" font-size="${size}" fill="#e8eaed">${escapeXml(r.label)}</text>`;
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
