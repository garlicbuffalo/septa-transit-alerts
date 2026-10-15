// Street basemaps for the bots' maps — only the basemap: every line, marker, and
// label is drawn on top as SVG (see draw.js), which keeps the styling ours.
//
// The same CARTO dark map the site and the septa-tracker board use. CARTO
// serves 256-px slippy-map tiles, so the basemap is stitched here: the tiles
// covering the view are fetched (@2x, 512 px), placed where the view's own
// projection (projection.js) says they go, and cropped to the image. Tiles come
//
//   - from CARTO directly with a key (CARTO_KEY), sent with a Referer
//     (CARTO_REFERER, by default the site's address) for a key limited to a
//     domain; or
//   - from the tracker's relay (TILES_URL=https://<its domain>/api/tiles), which
//     holds CARTO's API key as a Cloudflare secret, so this server needs none.
//
// Either way the map and its labels come as two layers and are tinted back to
// CARTO's classic Dark Matter (below), unless CARTO_RETINT=off, which takes
// dark_all as CARTO draws it.
//
// If CARTO can't be reached and a Mapbox token is set, Mapbox's static dark map
// is used instead (the bots' first basemap, kept as a fallback); with neither,
// a plain dark background stands in so rendering still works end to end (tests,
// local dry runs). CARTO's picture carries its credit; Mapbox draws its own.
import sharp from 'sharp';
import { escapeXml, FONT, textWidth } from './draw.js';
import { TILE_SIZE, worldPx } from './projection.js';

export const MAPBOX_STYLE = 'mapbox/dark-v11';
export const PLACEHOLDER_BG = '#1d2126';
export const CARTO_DIRECT = 'https://{s}.basemaps.cartocdn.com/dark_all';
export const CARTO_CREDIT = '© OpenStreetMap contributors © CARTO';
const USER_AGENT =
  'septa-transit-alerts-bots (+https://github.com/garlicbuffalo/septa-transit-alerts)';
const MAX_ZOOM = 20;
const ZOOM_SLACK = 0.2; // 2^0.2 ≈ 1.15: how far a tile may be enlarged
const CACHE_TILES = 600; // source PNGs: two per tile from CARTO directly
const FETCH_AT_ONCE = 8;

export function staticMapUrl(view, token, { style = MAPBOX_STYLE } = {}) {
  const lon = view.lon.toFixed(5);
  const lat = view.lat.toFixed(5);
  return (
    `https://api.mapbox.com/styles/v1/${style}/static/${lon},${lat},${view.zoom}` +
    `/${view.width}x${view.height}@2x?access_token=${encodeURIComponent(token)}`
  );
}

/**
 * Which CARTO tiles cover a view, and where each lands in the image.
 *
 * `view.zoom` is the Mapbox-style zoom projection.js uses (a 512-px world at
 * zoom 0), so a CARTO tile of zoom z spans 512·2^(zoom−z) image px. z is the
 * smallest whole zoom that stretches a @2x tile (512 px) by at most 15%
 * (ZOOM_SLACK): the picture stays sharp, and labels come out one to two times
 * the size they are on the web — legible when a 1200-px image is shown small
 * in a feed. (Rounding up strictly would halve them for a view a hair past a
 * whole zoom.)
 *
 * Tile edges are whole pixels (neighbours share them), so there are no seams.
 *
 * @param {{ lat: number, lon: number, zoom: number, width: number, height: number }} view
 * @returns {{ z: number, size: number, // size: a tile's width in image px
 *   tiles: Array<{ x: number, y: number, left: number, top: number, right: number, bottom: number }> }}
 */
export function tilePlan(view) {
  const z = Math.max(0, Math.min(MAX_ZOOM, Math.ceil(view.zoom - ZOOM_SLACK - 1e-9)));
  const n = 2 ** z;
  const scale = 2 ** view.zoom; // image px per px of the zoom-0 world
  const tileWorld = TILE_SIZE / n; // a tile's width in zoom-0 world px
  const c = worldPx(view.lat, view.lon);
  const halfW = view.width / 2 / scale;
  const halfH = view.height / 2 / scale;
  const edgeX = (tx) => Math.round(view.width / 2 + (tx * tileWorld - c.x) * scale);
  const edgeY = (ty) => Math.round(view.height / 2 + (ty * tileWorld - c.y) * scale);
  const x0 = Math.max(0, Math.floor((c.x - halfW) / tileWorld));
  const x1 = Math.min(n - 1, Math.floor((c.x + halfW) / tileWorld));
  const y0 = Math.max(0, Math.floor((c.y - halfH) / tileWorld));
  const y1 = Math.min(n - 1, Math.floor((c.y + halfH) / tileWorld));
  const tiles = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      tiles.push({
        x,
        y,
        left: edgeX(x),
        top: edgeY(y),
        right: edgeX(x + 1),
        bottom: edgeY(y + 1),
      });
    }
  }
  return { z, size: tileWorld * scale, tiles };
}

/**
 * A CARTO tile's address in one of its dark layers: through the relay (dark_all
 * at /z/x/y, the others under their names), or CARTO itself with a key.
 */
export function cartoTileUrl({ tilesUrl = null, cartoKey = null }, z, x, y, layer = 'dark_all') {
  if (tilesUrl) {
    const dir = layer === 'dark_all' ? '' : `/${layer}`;
    return `${tilesUrl.replace(/\/+$/, '')}${dir}/${z}/${x}/${y}@2x.png`;
  }
  const host = CARTO_DIRECT.replace('{s}', 'abcd'[(x + y) % 4]).replace(/dark_all$/, layer);
  return `${host}/${z}/${x}/${y}@2x.png?key=${encodeURIComponent(cartoKey)}`;
}

// ---- CARTO's new style, tinted back to Dark Matter --------------------------
//
// On 2026-10-14 CARTO replaced dark_all's classic Dark Matter (near-black land,
// buildings blacker still, dark roads with a grey casing, dim grey labels) with
// a blue-grey style: lavender roads, grey buildings lighter than the land, and
// label text lighter than before. The maps are tinted back to Dark Matter's own
// colours (CartoCSS in CartoDB/basemap-styles,
// cartocss/web-styles/dark-matter.tm2/style.mss).
//
// The new colours were measured from CARTO's tiles of Philadelphia at z11–18
// (2026-10-15). The tiles are palette PNGs: a few flat colours, plus blends of
// two of them where an edge is antialiased. So each pixel is split into the two
// new-style colours it lies between, and the same blend is made of their old
// colours: edges stay smooth. Greys (land, buildings, motorways, rail and path
// lines) differ only in lightness, which says nothing about what they are, so a
// grey is read by what it is near: a building's edge is a blend of building
// and land, while a thin grey line by itself stays a line.
//
// Labels are fetched as their own layer (dark_only_labels, over dark_nolabels)
// and tinted on their own. In dark_all the road names are dark on a light halo;
// in the labels-only layer they are light on a dark one, as in Dark Matter.

const LAND = 0x0e; // the new land, #0e0e0e
const MOTORWAY = 0x49; // #494949
// Buildings change grey with zoom; below z14 there are none.
const buildingGrey = (z) => (z >= 16 ? 0x39 : z === 15 ? 0x2b : z === 14 ? 0x1c : null);
// The coloured ones, and what each was in Dark Matter. `road` is drawn with a
// casing (below) rather than as one colour.
const HUES = [
  { name: 'land', rgb: [0x0e, 0x0e, 0x0e], old: 0x09 }, // @landmass_fill
  { name: 'water', rgb: [0x2c, 0x35, 0x3c], old: 0x26 }, // @water
  { name: 'street', rgb: [0x41, 0x47, 0x58], old: 0x19 }, // @street
  { name: 'road', rgb: [0x53, 0x56, 0x66], old: null }, // @main, with @main_case
  { name: 'road', rgb: [MOTORWAY, MOTORWAY, MOTORWAY], old: null }, // @motorway
];
const BUILDING_OLD = 0x00; // @buildings
const BUILDING_LINE = 0x11; // @building_outline
const ROAD_OLD = 0x03; // @main, @motorway
const ROAD_CASE = 0x2a; // @main_case, @motorway_case
// A grey line on its own (rail, paths) keeps its contrast with the land.
const GREY_SHIFT = LAND - 0x09;

// Labels. The new halo is 80% opaque: road names #2d2d2d around text near
// #717171, place names #3c3c3c around #a1a1a1. Dark Matter's: road names #333
// on a #030303 halo, place names #444 on #191919. Greys between are scaled.
const HALO_OPACITY = 0.8;
const HALO = { from: [0x2d, 0x3c], to: [0x03, 0x19] };
const TEXT = { from: [0x71, 0xa1], to: [0x33, 0x44] };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const scaleGrey = ({ from, to }, v) =>
  clampByte(to[0] + ((v - from[0]) * (to[1] - to[0])) / (from[1] - from[0]));

// Split a colour into the blend of two of `ends` it is closest to:
// { a, b, t } meaning (1 − t)·ends[a] + t·ends[b].
function unmix(r, g, b, ends) {
  let best = { a: 0, b: 0, t: 0, err: Number.POSITIVE_INFINITY };
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const [ar, ag, ab] = ends[i].rgb;
      const dr = ends[j].rgb[0] - ar;
      const dg = ends[j].rgb[1] - ag;
      const db = ends[j].rgb[2] - ab;
      const t = clamp01(
        ((r - ar) * dr + (g - ag) * dg + (b - ab) * db) / (dr * dr + dg * dg + db * db),
      );
      const er = r - ar - t * dr;
      const eg = g - ag - t * dg;
      const eb = b - ab - t * db;
      const err = er * er + eg * eg + eb * eb;
      if (err < best.err) best = { a: i, b: j, t, err };
    }
  }
  return best;
}

// The smallest (or, with `max`, the largest) value within `r` pixels, over a
// square, edges extended: erosion (dilation) of a 0..1 map.
function squareFilter(src, w, h, r, max = false) {
  const out = new Float32Array(src.length);
  if (!src.some((v) => v > 0)) return out; // nothing to erode or grow
  const tmp = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = src[row + x];
      const to = Math.min(w - 1, x + r);
      for (let k = Math.max(0, x - r); k <= to; k++) {
        const v = src[row + k];
        if (max ? v > m : v < m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const from = Math.max(0, y - r);
    const to = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = tmp[y * w + x];
      for (let k = from; k <= to; k++) {
        const v = tmp[k * w + x];
        if (max ? v > m : v < m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}
const minFilter = (src, w, h, r) => squareFilter(src, w, h, r);
const maxFilter = (src, w, h, r) => squareFilter(src, w, h, r, true);

// The light grey areas of a dark_nolabels tile, as building or motorway (1 in
// the array). Light: at least the building grey less one, or (with no
// buildings at this zoom) near the motorways' grey.
function greyAreas(px, width, height, channels, bGrey) {
  const n = width * height;
  const grey = (i) => {
    const r = px[i * channels];
    const g = px[i * channels + 1];
    const b = px[i * channels + 2];
    return Math.max(r, g, b) - Math.min(r, g, b) <= 2 ? g : -1;
  };
  // From z15 buildings (#2b2b2b, then #393939) are lighter than any line
  // (below #2a2a2a), and so are their roofs (#343434 on #393939): any area
  // that light and not motorway is building, small ones with no core too.
  const lightBuildings = bGrey != null && bGrey > 0x2a;
  const floor = lightBuildings ? 0x2a : bGrey == null ? MOTORWAY - 2 : bGrey - 1;
  const light = new Uint8Array(n);
  const solid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = grey(i);
    if (v >= floor) light[i] = 1;
    if (bGrey != null && Math.abs(v - bGrey) <= 1) solid[i] = 1;
  }
  // Building grey with building grey all round it: not a line.
  const core = minFilter(solid, width, height, 1);

  const building = new Float32Array(n);
  const motorway = new Float32Array(n);
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (!light[start] || seen[start]) continue;
    // One area, 4-connected.
    const members = [];
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    let cores = 0;
    let motorwayGrey = 0;
    while (top) {
      const i = stack[--top];
      members.push(i);
      if (core[i]) cores++;
      if (Math.abs(grey(i) - MOTORWAY) <= 2) motorwayGrey++;
      const x = i % width;
      for (const j of [i - width, i + width, x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1]) {
        if (j >= 0 && j < n && light[j] && !seen[j]) {
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }
    const isMotorway = motorwayGrey > members.length / 2;
    const into =
      cores > 0 || (lightBuildings && !isMotorway) ? building : isMotorway ? motorway : null;
    if (into) for (const i of members) into[i] = 1;
  }
  return { building, motorway };
}

/**
 * Tint a dark_nolabels tile back to Dark Matter.
 * @param {Uint8Array|Buffer} px raw pixels, `channels` per pixel (RGB first)
 * @returns {Buffer} raw RGB
 */
export function retintBase(px, width, height, channels, z) {
  const n = width * height;
  const bGrey = buildingGrey(z);
  const ends =
    bGrey == null ? HUES : [...HUES, { name: 'building', rgb: [bGrey, bGrey, bGrey], old: null }];
  const memo = new Map();

  // Where buildings and motorways are. Both are flat greys, and so are the
  // lighter parts of some roofs and thin rail and path lines. So the light
  // greys are taken as connected areas: an area mostly of the motorways' grey
  // is motorway; one with solid building grey in it (more than a line's width)
  // is building, roofs and all, and from z15 so is any other. Each reaches two
  // pixels further, for its antialiased edge.
  const kind = greyAreas(px, width, height, channels, bGrey);
  const nearBuilding = maxFilter(kind.building, width, height, 2);
  const nearMotorway = maxFilter(kind.motorway, width, height, 2);

  // Each pixel as: a colour from land/water/streets (already old), plus how
  // much of it is road and how much building, which get their casing below.
  const flat = new Float32Array(n);
  const road = new Float32Array(n);
  const building = new Float32Array(n);
  const addShare = (end, weight, i) => {
    if (end.name === 'road') road[i] += weight;
    else if (end.name === 'building') building[i] += weight;
    else flat[i] += weight * end.old;
  };
  for (let i = 0; i < n; i++) {
    const r = px[i * channels];
    const g = px[i * channels + 1];
    const b = px[i * channels + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) <= 2) {
      const v = (r + g + b) / 3;
      if (kind.building[i]) {
        building[i] = 1;
      } else if (kind.motorway[i]) {
        road[i] = 1;
      } else if (bGrey != null && nearBuilding[i] && v > LAND) {
        const t = clamp01((v - LAND) / (bGrey - LAND));
        building[i] = t;
        flat[i] = (1 - t) * HUES[0].old;
      } else if (nearMotorway[i] && v > LAND) {
        const t = clamp01((v - LAND) / (MOTORWAY - LAND));
        road[i] = t;
        flat[i] = (1 - t) * HUES[0].old;
      } else {
        flat[i] = Math.max(0, v - GREY_SHIFT);
      }
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    let m = memo.get(key);
    if (!m) {
      m = unmix(r, g, b, ends);
      memo.set(key, m);
    }
    addShare(ends[m.a], 1 - m.t, i);
    addShare(ends[m.b], m.t, i);
  }

  // Roads get Dark Matter's casing, buildings its outline: the rim of each
  // shape (what erosion takes off) is drawn in the lighter colour.
  const caseWidth = z >= 14 ? 2 : 1;
  const roadInside = minFilter(road, width, height, caseWidth);
  const buildingInside = minFilter(building, width, height, 1);
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const v =
      flat[i] +
      roadInside[i] * ROAD_OLD +
      (road[i] - roadInside[i]) * ROAD_CASE +
      buildingInside[i] * BUILDING_OLD +
      (building[i] - buildingInside[i]) * BUILDING_LINE;
    out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = Math.round(clampByte(v));
  }
  return out;
}

/**
 * Tint a dark_only_labels tile back to Dark Matter, and lay it over `base`
 * (raw RGB, changed in place).
 *
 * A label pixel is text over halo: alpha from the halo's 80% up to 100% says
 * how much is text. A pure halo pixel shows the halo's grey, which tells a
 * road name from a place name; a text pixel takes the halo of the nearest one.
 * @param {Uint8Array|Buffer} px raw RGBA
 * @param {Buffer} base raw RGB
 */
export function overlayLabels(px, base, width, height) {
  const n = width * height;
  const halo = new Float32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = px[i * 4 + 3];
    if (a > 0 && a <= 206) halo[i] = px[i * 4 + 1];
  }
  // Text strokes are a few pixels thick: hand each text pixel the halo grey of
  // a neighbour, a few rounds outward.
  for (let round = 0; round < 4; round++) {
    const next = halo.slice();
    let missing = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (halo[i] >= 0 || px[i * 4 + 3] === 0) continue;
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
            const v = halo[yy * width + xx];
            if (v >= 0) {
              sum += v;
              count++;
            }
          }
        }
        if (count) next[i] = sum / count;
        else missing++;
      }
    }
    halo.set(next);
    if (!missing) break;
  }

  for (let i = 0; i < n; i++) {
    const alpha = px[i * 4 + 3] / 255;
    if (alpha === 0) continue;
    const haloNew = halo[i] >= 0 ? halo[i] : HALO.from[0];
    const textShare = clamp01((alpha - HALO_OPACITY) / (1 - HALO_OPACITY));
    let colour = scaleGrey(HALO, haloNew);
    if (textShare > 0) {
      const haloPart = (1 - textShare) * HALO_OPACITY;
      const textNew = (px[i * 4 + 1] * alpha - haloPart * haloNew) / textShare;
      colour = (textShare * scaleGrey(TEXT, textNew) + haloPart * colour) / alpha;
    }
    for (let c = 0; c < 3; c++) {
      base[i * 3 + c] = Math.round(base[i * 3 + c] * (1 - alpha) + colour * alpha);
    }
  }
  return base;
}

/** Lay a labels tile (raw RGBA) over `base` (raw RGB) as CARTO drew it. */
function layOver(px, base, width, height) {
  for (let i = 0; i < width * height; i++) {
    const alpha = px[i * 4 + 3] / 255;
    if (alpha === 0) continue;
    for (let c = 0; c < 3; c++) {
      base[i * 3 + c] = Math.round(base[i * 3 + c] * (1 - alpha) + px[i * 4 + c] * alpha);
    }
  }
  return base;
}

// ---- is it still the style the tint was made for? --------------------------
//
// The tint is made for the colours above. If CARTO restyles again it would
// turn the new colours into nonsense, so each map is checked first: on
// today's tiles 63–90% of a map tile's pixels are one of its flat colours
// (land, water, streets, roads, buildings), and about 90% of the label halos
// one of the two halo greys. A restyle that changes any of them brings that
// near nothing, and the map is then drawn as CARTO draws it.
const BASE_KNOWN = 0.4;
const HALO_KNOWN = 0.5;
const HALOS_TO_JUDGE = 200; // fewer label pixels than this say nothing

/** How many of a dark_nolabels tile's pixels are a flat colour of the style. */
export function styleFit(px, width, height, channels, z) {
  const bGrey = buildingGrey(z);
  const flat = HUES.map((h) => h.rgb);
  if (bGrey != null) flat.push([bGrey, bGrey, bGrey]);
  let known = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    const r = px[i * channels];
    const g = px[i * channels + 1];
    const b = px[i * channels + 2];
    for (const [fr, fg, fb] of flat) {
      if (Math.abs(r - fr) <= 1 && Math.abs(g - fg) <= 1 && Math.abs(b - fb) <= 1) {
        known++;
        break;
      }
    }
  }
  return { known, total: n };
}

/** How many of a dark_only_labels tile's pure halo pixels are a known halo grey. */
export function labelFit(px, width, height) {
  let known = 0;
  let total = 0;
  for (let i = 0; i < width * height; i++) {
    const a = px[i * 4 + 3];
    if (a < 200 || a > 206) continue;
    total++;
    const [r, g, b] = [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 2) continue;
    if (HALO.from.some((h) => Math.abs(g - h) <= 2)) known++;
  }
  return { known, total };
}

/**
 * Whether to tint a map's tiles, from their fits added up: the map and its
 * labels each on their own. Labels too few to judge go with the map.
 */
export function judgeStyle(fits) {
  const sum = (key) =>
    fits.reduce(
      (acc, f) => ({ known: acc.known + f[key].known, total: acc.total + f[key].total }),
      {
        known: 0,
        total: 0,
      },
    );
  const base = sum('base');
  const labels = sum('labels');
  const baseShare = base.total ? base.known / base.total : 1;
  const labelShare = labels.total >= HALOS_TO_JUDGE ? labels.known / labels.total : null;
  const tintBase = baseShare >= BASE_KNOWN;
  return {
    base: tintBase,
    labels: labelShare == null ? tintBase : labelShare >= HALO_KNOWN,
    baseShare,
    labelShare,
  };
}

const percent = (v) => `${Math.round(v * 100)}%`;
function describeStyle(style) {
  if (style.base && style.labels) return 'tinted to Dark Matter';
  const parts = [`map ${percent(style.baseShare)} known`];
  if (style.labelShare != null) parts.push(`labels ${percent(style.labelShare)}`);
  const which = !style.base && !style.labels ? 'map and labels' : !style.base ? 'map' : 'labels';
  return `CARTO's style has changed (${parts.join(', ')}): ${which} drawn as CARTO draws them`;
}

// Run `fn` over `items`, at most `limit` at a time, keeping their order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * A function that gets one CARTO tile (of a layer) as an image buffer: tried
 * three times, remembered (a map and the timelapse after it share most of
 * theirs).
 */
function tileFetcher({ tilesUrl, cartoKey, referer, fetchFn, retryDelayMs }) {
  const cache = new Map();
  const headers = { 'user-agent': USER_AGENT };
  if (!tilesUrl && referer) headers.referer = referer;
  return async function getTile(z, x, y, layer = 'dark_all') {
    const url = cartoTileUrl({ tilesUrl, cartoKey }, z, x, y, layer);
    if (cache.has(url)) return cache.get(url);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers?.get?.('content-type') ?? 'image/png';
        if (!/^image\//.test(type)) throw new Error(`not an image (${type})`);
        const buf = Buffer.from(await res.arrayBuffer());
        cache.set(url, buf);
        if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
        return buf;
      } catch (err) {
        // The error is reported without the address, which carries the key.
        lastErr = new Error(`tile ${z}/${x}/${y}: ${err.message}`);
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
    throw lastErr;
  };
}

/**
 * A function that loads one tile of the map. Untinted (`retint` off) it is
 * dark_all as CARTO draws it, one request. Otherwise it is the map and its
 * labels, two requests, with how well each fits the style the tint was made
 * for; `drawTile` then draws it, tinted or not as the map's tiles together say.
 */
function tileLoader({ retint = true, ...opts }) {
  const getTile = tileFetcher(opts);
  if (!retint) return async (z, x, y) => ({ image: await getTile(z, x, y) });
  return async (z, x, y) => {
    const [base, labels] = await Promise.all([
      getTile(z, x, y, 'dark_nolabels'),
      getTile(z, x, y, 'dark_only_labels'),
    ]);
    const b = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const l = await sharp(labels).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = b.info;
    if (l.info.width !== width || l.info.height !== height) {
      throw new Error(`tile ${z}/${x}/${y}: labels ${l.info.width} px, map ${width} px`);
    }
    return {
      z,
      width,
      height,
      base: b.data,
      labels: l.data,
      fit: {
        base: styleFit(b.data, width, height, 3, z),
        labels: labelFit(l.data, width, height),
      },
    };
  };
}

/** A loaded tile as a sharp image, its map and labels tinted as `style` says. */
function drawTile(tile, style) {
  if (tile.image) return sharp(tile.image);
  const { z, width, height } = tile;
  const rgb = style.base ? retintBase(tile.base, width, height, 3, z) : Buffer.from(tile.base);
  if (style.labels) overlayLabels(tile.labels, rgb, width, height);
  else layOver(tile.labels, rgb, width, height);
  return sharp(rgb, { raw: { width, height, channels: 3 } });
}

// The credit, small in the image's bottom-right corner.
function creditLayer(view) {
  const size = 19;
  const w = Math.ceil(textWidth(CARTO_CREDIT, size) + 20);
  const h = size + 14;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect width="${w}" height="${h}" rx="6" fill="#000" fill-opacity="0.55"/>` +
    `<text x="10" y="${(7 + size * 0.82).toFixed(1)}" font-family="${FONT}" font-size="${size}" fill="#d5d9de">${escapeXml(CARTO_CREDIT)}</text>` +
    `</svg>`;
  return { input: Buffer.from(svg), left: Math.max(0, view.width - w), top: view.height - h };
}

/** Stitch a view's CARTO tiles into one image of the view's size. */
async function stitch(view, loadTile, onStyle = () => {}) {
  const plan = tilePlan(view);
  const loaded = await mapLimit(plan.tiles, FETCH_AT_ONCE, (t) => loadTile(plan.z, t.x, t.y));
  const fits = loaded.filter((t) => t.fit).map((t) => t.fit);
  const style = fits.length ? judgeStyle(fits) : null;
  if (style) onStyle(style);
  const layers = (
    await mapLimit(plan.tiles, FETCH_AT_ONCE, async (t, k) => {
      const w = t.right - t.left;
      const h = t.bottom - t.top;
      // The part of the tile inside the image (the edge tiles hang over it).
      const cropL = Math.max(0, -t.left);
      const cropT = Math.max(0, -t.top);
      const cropW = Math.min(w, view.width - t.left) - cropL;
      const cropH = Math.min(h, view.height - t.top) - cropT;
      if (cropW <= 0 || cropH <= 0) return null;
      const input = await drawTile(loaded[k], style)
        .resize(w, h, { fit: 'fill' })
        .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
        .png()
        .toBuffer();
      return { input, left: t.left + cropL, top: t.top + cropT };
    })
  ).filter(Boolean);
  return sharp({
    create: { width: view.width, height: view.height, channels: 3, background: PLACEHOLDER_BG },
  })
    .composite([...layers, creditLayer(view)])
    .png()
    .toBuffer();
}

/**
 * Fetch one tile the way the maps do, to say whether CARTO is reachable and the
 * key (or the relay) is accepted — what `septa-bots check` reports.
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
export async function checkCarto({
  tilesUrl = null,
  cartoKey = null,
  cartoReferer = null,
  retint = true,
  fetchFn = fetch,
} = {}) {
  const loadTile = tileLoader({
    tilesUrl,
    cartoKey,
    referer: cartoReferer,
    retint,
    fetchFn,
    retryDelayMs: 0,
  });
  try {
    // Philadelphia's City Hall at zoom 12.
    const tile = await loadTile(12, 1192, 1551);
    if (tile.image) {
      const { width } = await sharp(tile.image).metadata();
      return { ok: true, detail: `${width}-px tile, as CARTO draws it (CARTO_RETINT off)` };
    }
    return { ok: true, detail: `${tile.width}-px tiles, ${describeStyle(judgeStyle([tile.fit]))}` };
  } catch (err) {
    return { ok: false, detail: err.message.replace(/^tile [\d/]+: /, '') };
  }
}

/**
 * @param {{ token?: string | null, tilesUrl?: string | null, cartoKey?: string | null,
 *   cartoReferer?: string | null, retint?: boolean, fetchFn?: typeof fetch,
 *   log?: (m: string) => void, retryDelayMs?: number }} opts
 *   `token` is a Mapbox token; `tilesUrl` / `cartoKey` are CARTO's (see above);
 *   `retint` false draws CARTO's dark_all as it comes (CARTO_RETINT=off).
 * @returns {(view: {lat:number, lon:number, zoom:number, width:number, height:number}) => Promise<Buffer>}
 *   PNG/JPEG at the view's logical size
 */
export function createBasemap({
  token = null,
  tilesUrl = null,
  cartoKey = null,
  cartoReferer = null,
  retint = true,
  fetchFn = fetch,
  log = () => {},
  retryDelayMs = 750,
} = {}) {
  const sources = [];
  // Say when the maps stop (or start again) being tinted, not on every map.
  let lastStyle = 'tinted/tinted';
  const onStyle = (style) => {
    const now = `${style.base ? 'tinted' : 'as is'}/${style.labels ? 'tinted' : 'as is'}`;
    if (now !== lastStyle) log(`basemap: ${describeStyle(style)}`);
    lastStyle = now;
  };
  if (tilesUrl || cartoKey) {
    const loadTile = tileLoader({
      tilesUrl,
      cartoKey,
      referer: cartoReferer,
      retint,
      fetchFn,
      retryDelayMs,
    });
    sources.push({ name: 'CARTO', render: (view) => stitch(view, loadTile, onStyle) });
  }
  if (token) {
    sources.push({ name: 'Mapbox', render: (view) => mapboxImage(view, token, fetchFn, log) });
  }

  return async function basemap(view) {
    if (sources.length === 0) {
      return sharp({
        create: { width: view.width, height: view.height, channels: 3, background: PLACEHOLDER_BG },
      })
        .png()
        .toBuffer();
    }
    let lastErr;
    for (let i = 0; i < sources.length; i++) {
      try {
        return await sources[i].render(view);
      } catch (err) {
        lastErr = err;
        const next = sources[i + 1];
        log(`basemap: ${sources[i].name}: ${err.message}${next ? ` — trying ${next.name}` : ''}`);
      }
    }
    throw lastErr;
  };
}

// Mapbox's static dark map for a view, tried twice.
async function mapboxImage(view, token, fetchFn, log) {
  const url = staticMapUrl(view, token);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Mapbox HTTP ${res.status}`);
      const raw = Buffer.from(await res.arrayBuffer());
      // @2x tiles come back at double size; draw in logical pixels.
      return await sharp(raw).resize(view.width, view.height).png().toBuffer();
    } catch (err) {
      lastErr = err;
      log(`basemap: ${err.message}${attempt === 0 ? ' — retrying' : ''}`);
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  throw lastErr;
}
