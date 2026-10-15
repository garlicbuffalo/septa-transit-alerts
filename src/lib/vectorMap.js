// CARTO's vector map in the site's own style (public/maps/dark-matter.json,
// see darkMatterStyle.js), drawn by MapLibre GL. Two uses:
//
//   - under an interactive Leaflet map, as its base layer (InteractiveMap.jsx,
//     through @maplibre/maplibre-gl-leaflet);
//   - behind a line map's SVG, as one picture of the area (Basemap.jsx):
//     `staticMap` draws it on a hidden map, one at a time, and hands back an
//     object URL, so a page with many line maps uses one WebGL context, not one
//     each.
//
// MapLibre (about 220 KB gzipped) loads only when a map needs it. The key goes
// on every CARTO address the style leads to (tiles, fonts, icons) as it is
// requested, not into the style file.

const STYLE_URL = '/maps/dark-matter.json';
const KEEP = 60; // pictures kept, as object URLs, before the oldest is let go
// A picture's tiles that fail before any has drawn, before the map is given up.
const FAILURES = 2;

/** Whether this browser can draw the vector map (WebGL). */
export function canDrawVector() {
  if (typeof document === 'undefined' || typeof WebGLRenderingContext === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

let maplibre = null;
/** MapLibre GL JS, loaded once. */
export function loadMapLibre() {
  maplibre ??= Promise.all([
    import('maplibre-gl'),
    import('maplibre-gl/dist/maplibre-gl.css'),
  ]).then(([m]) => m.default ?? m);
  return maplibre;
}

/** The options a MapLibre map of the site's style takes: the style, the key. */
export function mapOptions(key) {
  return {
    style: STYLE_URL,
    transformRequest: (url) => ({ url: withKey(url, key) }),
  };
}

/** A CARTO address with the key on it (anything else as it is). */
export function withKey(url, key) {
  if (!key || !/^https:\/\/[^/]*\.?basemaps\.cartocdn\.com\//.test(url)) return url;
  const u = new URL(url);
  u.searchParams.set('key', key);
  return u.toString();
}

/**
 * Watch a MapLibre map for the tiles it can't have: `onFail` once, if
 * `FAILURES` tiles or the style fail before any tile has drawn (a refused key,
 * CARTO down). A stray missing tile later on is just a missing tile.
 */
export function watchFailures(map, onFail) {
  let drawn = false;
  let failed = 0;
  let given = false;
  const fail = (err) => {
    if (given || drawn) return;
    failed++;
    if (failed >= FAILURES || err?.style) {
      given = true;
      onFail(err);
    }
  };
  map.on('data', (e) => {
    if (e.dataType === 'source' && e.tile && e.tile.state === 'loaded') drawn = true;
  });
  map.on('error', (e) => {
    const status = e.error?.status;
    // The style itself (our own file) failing is the end of it at once.
    fail({ style: !e.sourceId && !e.tile, status, message: e.error?.message });
  });
}

/**
 * A Leaflet layer of the vector map, for under an interactive map's lines
 * (in Leaflet's tile pane, as tiles would be). `onFail` is told once if its
 * tiles or style can't be had.
 */
export async function leafletLayer(key, onFail) {
  const [{ maplibreGL }] = await Promise.all([
    import('@maplibre/maplibre-gl-leaflet'),
    loadMapLibre(),
  ]);
  const layer = maplibreGL({ ...mapOptions(key), interactive: false, attributionControl: false });
  layer.once('add', () => {
    const map = layer.getMaplibreMap();
    if (map) watchFailures(map, onFail);
  });
  return layer;
}

// ---- pictures for the line maps ---------------------------------------------

let painter = null; // { map, el, queue }
const pictures = new Map(); // key -> Promise<object URL>, oldest first

// Resolve once the map has drawn everything it has asked for. ('idle' alone
// won't do: a view the map already shows draws without firing it again.)
function whenDrawn(map) {
  return new Promise((resolve) => {
    const done = () => {
      if (!map.loaded() || !map.areTilesLoaded() || map.isMoving()) return;
      map.off('render', done);
      map.off('idle', done);
      resolve();
    };
    map.on('render', done);
    map.on('idle', done);
    map.triggerRepaint();
  });
}

let painterStarting = null;
function getPainter(key, first) {
  painterStarting ??= startPainter(key, first);
  return painterStarting;
}

async function startPainter(key, first) {
  const maplibregl = await loadMapLibre();
  const el = document.createElement('div');
  el.setAttribute('aria-hidden', 'true');
  // Laid out (MapLibre needs a size) but off screen.
  el.style.cssText = `position:fixed;left:-10000px;top:0;width:${first.width}px;height:${first.height}px;pointer-events:none;`;
  document.body.appendChild(el);
  const map = new maplibregl.Map({
    container: el,
    ...mapOptions(key),
    // Start where the first picture is, not on the whole world.
    center: [first.lon, first.lat],
    zoom: first.zoom,
    pixelRatio: first.pixelRatio,
    interactive: false,
    attributionControl: false,
    fadeDuration: 0,
    preserveDrawingBuffer: true, // so the canvas can be read once drawn
  });
  const ready = new Promise((resolve, reject) => {
    map.once('load', resolve);
    watchFailures(map, (err) =>
      reject(Object.assign(new Error(err?.message ?? 'the map failed'), { kind: 'fetch' })),
    );
  });
  painter = { map, el, ready, queue: Promise.resolve() };
  return painter;
}

/**
 * The map of an area, as a picture: a promise of an object URL for an <img>.
 * `width` x `height` CSS pixels at `pixelRatio`, centred on lat/lon, at a
 * MapLibre zoom (512-px tiles). Rejects (kind 'fetch') if the map can't be had.
 */
export function staticMap({ lat, lon, zoom, width, height, pixelRatio = 2 }, key) {
  const id = [lat.toFixed(6), lon.toFixed(6), zoom.toFixed(4), width, height, pixelRatio].join('/');
  const known = pictures.get(id);
  if (known) {
    pictures.delete(id);
    pictures.set(id, known);
    return known;
  }
  const view = { lat, lon, zoom, width, height, pixelRatio };
  const job = (async () => {
    const p = await getPainter(key, view);
    await p.ready;
    // One picture at a time on the one map.
    const turn = p.queue.then(async () => {
      p.el.style.width = `${width}px`;
      p.el.style.height = `${height}px`;
      p.map.setPixelRatio(pixelRatio);
      p.map.resize();
      p.map.jumpTo({ center: [lon, lat], zoom });
      await whenDrawn(p.map);
      const blob = await new Promise((resolve) => p.map.getCanvas().toBlob(resolve, 'image/png'));
      if (!blob) throw Object.assign(new Error('the map could not be read'), { kind: 'tint' });
      return URL.createObjectURL(blob);
    });
    p.queue = turn.catch(() => {});
    return turn;
  })();
  pictures.set(id, job);
  job.catch(() => pictures.get(id) === job && pictures.delete(id));
  while (pictures.size > KEEP) {
    const [oldest, url] = pictures.entries().next().value;
    pictures.delete(oldest);
    url.then(
      (u) => URL.revokeObjectURL(u),
      () => {},
    );
  }
  return job;
}

// For tests: start over.
export function resetVectorMap() {
  painter?.map.remove();
  painter?.el.remove();
  painter = null;
  painterStarting = null;
  pictures.clear();
}
