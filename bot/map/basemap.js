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
import {
  describeStyle,
  judgeStyle,
  labelFit,
  layOver,
  overlayLabels,
  retintBase,
  styleFit,
} from '../../src/lib/darkMatter.js';
import { escapeXml, FONT, textWidth } from './draw.js';
import { TILE_SIZE, worldPx } from './projection.js';

// The tint itself is in src/lib/darkMatter.js (plain JavaScript); these are
// here too for the bots' tests.
export { judgeStyle, labelFit, overlayLabels, retintBase, styleFit };

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
//
// CARTO's list of raster styles names dark_nolabels but not dark_only_labels
// (dashboard.basemaps.carto.com/v1/plans, 2026-10-15), so the labels layer
// could go without notice. A tile whose labels can't be had is drawn without
// them, and the labels layer is not asked for again for LABELS_RETRY_MS.
const LABELS_RETRY_MS = 60 * 60 * 1000;
function tileLoader({ retint = true, now = Date.now, ...opts }) {
  const getTile = tileFetcher(opts);
  if (!retint) return async (z, x, y) => ({ image: await getTile(z, x, y) });
  let labelsGoneUntil = 0;
  const getLabels = async (z, x, y) => {
    if (now() < labelsGoneUntil) return { missing: 'not asked again yet' };
    try {
      return await getTile(z, x, y, 'dark_only_labels');
    } catch (err) {
      labelsGoneUntil = now() + LABELS_RETRY_MS;
      return { missing: err.message.replace(/^tile [\d/]+: /, '') };
    }
  };
  return async (z, x, y) => {
    const [base, labels] = await Promise.all([
      getTile(z, x, y, 'dark_nolabels'),
      getLabels(z, x, y),
    ]);
    const b = await sharp(base).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = b.info;
    const tile = {
      z,
      width,
      height,
      base: b.data,
      labels: null,
      fit: {
        base: styleFit(b.data, width, height, 3, z),
        labels: { known: 0, total: 0 },
      },
    };
    if (labels.missing) return { ...tile, labelsMissing: labels.missing };
    const l = await sharp(labels).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (l.info.width !== width || l.info.height !== height) {
      throw new Error(`tile ${z}/${x}/${y}: labels ${l.info.width} px, map ${width} px`);
    }
    tile.labels = l.data;
    tile.fit.labels = labelFit(l.data, width, height);
    return tile;
  };
}

/** A loaded tile as a sharp image, its map and labels tinted as `style` says. */
function drawTile(tile, style) {
  if (tile.image) return sharp(tile.image);
  const { z, width, height } = tile;
  const rgb = style.base ? retintBase(tile.base, width, height, 3, z) : Buffer.from(tile.base);
  if (style.noLabels || !tile.labels) {
    // Without CARTO's labels layer: the map alone.
  } else if (style.labels) overlayLabels(tile.labels, rgb, width, height);
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
  // One tile without labels and the map goes without, rather than half of it.
  const missing = loaded.find((t) => t.labelsMissing)?.labelsMissing;
  if (style) {
    style.noLabels = Boolean(missing);
    onStyle(style, missing);
  }
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
    const said = describeStyle(judgeStyle([tile.fit]));
    if (tile.labelsMissing) {
      return {
        ok: true,
        detail: `${tile.width}-px tiles, ${said}; no labels layer (${tile.labelsMissing}): maps drawn without street and place names`,
      };
    }
    return { ok: true, detail: `${tile.width}-px tiles, ${said}` };
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
  now = Date.now,
} = {}) {
  const sources = [];
  // Say when the maps stop (or start again) being tinted, not on every map.
  let lastStyle = 'tinted/tinted';
  let lastMissing = null;
  const onStyle = (style, missing) => {
    const now = `${style.base ? 'tinted' : 'as is'}/${style.labels ? 'tinted' : 'as is'}`;
    if (now !== lastStyle) log(`basemap: ${describeStyle(style)}`);
    lastStyle = now;
    if (Boolean(missing) !== Boolean(lastMissing)) {
      log(
        missing
          ? `basemap: CARTO's labels layer (dark_only_labels) failed (${missing}): maps drawn without street and place names`
          : "basemap: CARTO's labels layer is back",
      );
    }
    lastMissing = missing ?? null;
  };
  if (tilesUrl || cartoKey) {
    const loadTile = tileLoader({
      tilesUrl,
      cartoKey,
      referer: cartoReferer,
      retint,
      fetchFn,
      retryDelayMs,
      now,
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
