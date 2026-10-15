// The site's map style: CARTO's dark-matter vector style (its layers, fonts and
// data, from CARTO's vector tiles) in the colours the bots' tint gives CARTO's
// raster map (darkMatter.js), so the site's maps and the bots' images match.
// CARTO restyled its dark map on 2026-10-14; this keeps the old look.
//
// scripts/build-map-style.js runs it over CARTO's style.json and writes
// public/maps/dark-matter.json, which the maps load (basemap.js).

import { PALETTE } from './darkMatter.js';

// Two colours the tint has no rule for (they are thin lines it blends into
// their neighbours): rivers and state lines, given Dark Matter's own
// (@rivers_stroke, @admin1_high).
const OWN = { waterway: '#242424', boundary_state: '#292929' };

// Labels. The tint gives road names #333 on #030303 and every other name #444
// on #191919, each over CARTO's 80% halo. CARTO's raster text is softened when
// drawn and never reaches #444: measured against the tint (2026-10-15), place
// names peak at #36-#39 there and at #44 when MapLibre draws them crisp, so
// they are #393939 here; road names peak at #31-#33 in both. Place and park
// names also drop to Montserrat Regular (CARTO's raster labels' weight) at
// NAME_SCALE the size: two measured park names wanted 0.956 and 1.01.
const PLACE_TEXT = '#393939';
const NAME_SCALE = 0.975;

const hex2 = (v) =>
  Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, '0');

function parse(c) {
  if (typeof c !== 'string') return null;
  let m = c.match(/^#([0-9a-f]{3})$/i);
  if (m) return { rgb: [...m[1]].map((h) => Number.parseInt(h + h, 16)), a: 1 };
  m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return { rgb: [0, 2, 4].map((i) => Number.parseInt(m[1].slice(i, i + 2), 16)), a: 1 };
  m = c.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const p = m[1].split(',').map(Number);
    return { rgb: p.slice(0, 3), a: p[3] ?? 1 };
  }
  return null;
}

const withAlpha = (rgb, a) =>
  a < 1 ? `rgba(${rgb.join(', ')}, ${a})` : `#${rgb.map(hex2).join('')}`;

/** One colour of CARTO's map, as the tint turns it (unchanged if it has no rule). */
export function tintColour(c) {
  const p = parse(c);
  if (!p) return c;
  for (const { rgb, to } of PALETTE.flat) {
    if (rgb.every((v, i) => Math.abs(v - p.rgb[i]) <= 1))
      return p.a < 1 ? withAlpha(parse(to).rgb, p.a) : to;
  }
  if (Math.max(...p.rgb) - Math.min(...p.rgb) <= 2) {
    const v = Math.max(0, p.rgb[1] - PALETTE.greyShift);
    return withAlpha([v, v, v], p.a);
  }
  return c;
}

// Colours inside a paint value: a plain colour, or zoom stops of them.
function mapColours(value) {
  if (typeof value === 'string') return tintColour(value);
  if (value && typeof value === 'object' && Array.isArray(value.stops)) {
    return { ...value, stops: value.stops.map(([z, c]) => [z, mapColours(c)]) };
  }
  return value;
}

// Every zoom in a value moved by `by` (zoom stops only: CARTO's style uses no
// expressions).
function shiftZoom(value, by) {
  if (Array.isArray(value)) return value.map((v) => shiftZoom(v, by));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        k === 'stops'
          ? v.map(([z, x]) => [Math.max(0, z + by), shiftZoom(x, by)])
          : shiftZoom(v, by);
    }
    return out;
  }
  return value;
}

const scaleSize = (size, k) =>
  typeof size === 'number' ? size * k : { ...size, stops: size.stops.map(([z, s]) => [z, s * k]) };

/**
 * CARTO's dark-matter style.json, recoloured to the tint's Dark Matter.
 * @param {object} carto the style as CARTO serves it
 * @returns {object} a new style
 */
export function darkMatterStyle(carto) {
  const style = structuredClone(carto);
  const halo = (grey) => `rgba(${parse(grey).rgb.join(', ')}, ${PALETTE.haloOpacity})`;
  for (const layer of style.layers) {
    const paint = { ...layer.paint };
    if (layer.type === 'symbol') {
      const road = layer.id.startsWith('roadname_');
      const shown = (k) => k in paint && paint[k] !== 'transparent';
      if (shown('text-color')) paint['text-color'] = road ? PALETTE.roadText : PLACE_TEXT;
      if (shown('text-halo-color'))
        paint['text-halo-color'] = halo(road ? PALETTE.roadHalo : PALETTE.placeHalo);
      if ('icon-color' in paint) paint['icon-color'] = PLACE_TEXT;
    } else if (layer.id === 'building-top') {
      paint['fill-color'] = PALETTE.building;
      paint['fill-outline-color'] = PALETTE.buildingLine;
    } else {
      for (const k of Object.keys(paint)) if (k.endsWith('-color')) paint[k] = mapColours(paint[k]);
    }
    if (OWN[layer.id]) paint['line-color'] = OWN[layer.id];
    // Main roads and motorways (and trunks) get the tint's lighter casing.
    if (/^(road|bridge)_(pri|trunk|mot)_case/.test(layer.id))
      paint['line-color'] = PALETTE.roadCase;
    layer.paint = paint;

    if (/^(place|poi)_/.test(layer.id) && layer.layout) {
      const layout = { ...layer.layout };
      if (layout['text-font']) {
        layout['text-font'] = layout['text-font'].map((f) =>
          f
            .replace('Montserrat Medium', 'Montserrat Regular')
            .replace('Open Sans Bold', 'Open Sans Regular'),
        );
      }
      if (layout['text-size'] != null)
        layout['text-size'] = scaleSize(layout['text-size'], NAME_SCALE);
      layer.layout = layout;
    }
  }

  // CARTO's raster tiles, which the tint works on, are drawn on 256-px tiles;
  // MapLibre lays the world out on 512-px tiles, so the same scale on screen is
  // one zoom lower there. Every zoom in the style moves down one, so the map
  // shows what the raster map shows at that scale, at the same size.
  for (const layer of style.layers) {
    if (layer.minzoom != null) layer.minzoom = Math.max(0, layer.minzoom - 1);
    if (layer.maxzoom != null && layer.maxzoom < 24) layer.maxzoom -= 1;
    if (layer.paint) layer.paint = shiftZoom(layer.paint, -1);
    if (layer.layout) layer.layout = shiftZoom(layer.layout, -1);
  }
  style.name = 'Dark Matter, as the bots tint it (septa-transit-alerts)';
  return style;
}
