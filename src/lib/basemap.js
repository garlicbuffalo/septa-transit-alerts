// Street basemaps under the SVG line maps: the same CARTO dark tiles the
// septa-tracker board uses.
//
// The line maps are SVG drawn in their own coordinate space (lineMap.js). With
// a basemap that space is Web Mercator, so a station lands on the street it
// stands on: `fitMercator` fits the geometry into a canvas and works out which
// tiles cover it, and <BasemapTiles> lays those tiles behind the SVG.
//
// Where the tiles come from. CARTO has wanted an API key since August 2026
// (without one every tile is stamped "API KEY REQUIRED"). Two ways to give the
// page one, set at build time from repository variables in deploy.yml:
//
//   VITE_CARTO_KEY=<a CARTO key limited to the site's domain>
//       The browser asks CARTO directly, with the key in the tile address. A
//       static site has nowhere to hide a key, so it is visible in the page;
//       what makes that acceptable is the limit to the site's domain, which
//       CARTO checks against the Referer the browser sends (index.html's
//       referrer policy sends the site's origin). Keep it a key of its own.
//
//   VITE_TILES_URL=https://<the tracker's domain>/api/tiles
//       The tracker's relay (septa-tracker/worker/index.js) serves
//       /{z}/{x}/{y}[@2x].png, adding its own key from a Cloudflare secret, so
//       none is in the page. Wins over a key if both are set.
//
// Either way CARTO's map is tinted back to its classic Dark Matter look, which
// CARTO replaced on 2026-10-14 (darkMatter.js, the same tint as the bots'
// maps): each tile is fetched as its map and its labels, two layers, and
// tinted in a Web Worker (darkMatterTiles.js). VITE_CARTO_RETINT=off, or a
// browser that can't run the worker, gets dark_all as CARTO draws it.
//
// Without either, or if the tiles can't be had (a bad address, the relay down),
// the maps use OpenStreetMap's own tiles, darkened by a CSS filter, the way the
// tracker does. CARTO answers a missing or unaccepted key with an ordinary
// image carrying a watermark, which can't be told from a good tile in code:
// look at a map after setting a key.

import { canTint, onStyleNote } from './darkMatterTiles.js';

const TILE_TARGET = 300; // SVG units a tile should span; the zoom is chosen near it
const MIN_ZOOM = 1;
const MAX_ZOOM = 19; // the relay serves up to 20
const SEAM = 0.5; // SVG units of overlap between neighbouring tiles, so no hairline shows

const rad = (deg) => (deg * Math.PI) / 180;

/** Web Mercator, as 0..1 across the whole world (x east, y south). */
export function mercator(lat, lon) {
  const s = Math.sin(rad(Math.max(-85.0511, Math.min(85.0511, lat))));
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
}

/** Which tile of zoom `z` holds a point. */
export function tileOf(lat, lon, z) {
  const n = 2 ** z;
  const m = mercator(lat, lon);
  return { x: Math.floor(m.x * n), y: Math.floor(m.y * n) };
}

/**
 * Fit [lat, lon] points into a canvas of Web Mercator. Unlike the flat fit in
 * lineMap.js there is no rotation (a tile's street names would turn sideways)
 * and the canvas keeps its size rather than shrinking to the geometry's
 * shape, so the tiles fill it and a tall or narrow line has map around it.
 *
 * @returns {{
 *   width: number, height: number,
 *   project: (lat: number, lon: number) => { x: number, y: number },
 *   basemap: { z: number, tiles: Array<{ x: number, y: number, left: number, top: number, w: number, h: number }> },
 * } | null}
 */
export function fitMercator(points, { maxWidth, maxHeight, margin, minHeight = 200 }) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [lat, lon] of points) {
    const m = mercator(lat, lon);
    if (m.x < minX) minX = m.x;
    if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.y > maxY) maxY = m.y;
  }
  if (!Number.isFinite(minX)) return null;
  const dx = Math.max(maxX - minX, 1e-9);
  const dy = Math.max(maxY - minY, 1e-9);

  const width = maxWidth;
  const aspect = dx / dy;
  const height =
    aspect >= 1
      ? Math.max(Math.min(minHeight, maxHeight), Math.min(maxHeight, Math.round(maxWidth / aspect)))
      : maxHeight;

  // SVG units per world unit: the geometry fits inside the margins, centred.
  const k = Math.min((width - 2 * margin) / dx, (height - 2 * margin) / dy);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const project = (lat, lon) => {
    const m = mercator(lat, lon);
    return { x: width / 2 + (m.x - cx) * k, y: height / 2 + (m.y - cy) * k };
  };

  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(Math.log2(k / TILE_TARGET))));
  const n = 2 ** z;
  const size = k / n;
  const x0 = Math.max(0, Math.floor((cx - width / (2 * k)) * n));
  const x1 = Math.min(n - 1, Math.floor((cx + width / (2 * k)) * n));
  const y0 = Math.max(0, Math.floor((cy - height / (2 * k)) * n));
  const y1 = Math.min(n - 1, Math.floor((cy + height / (2 * k)) * n));
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      // Position and size as % of the canvas, so the layer scales with the SVG.
      tiles.push({
        x: tx,
        y: ty,
        left: ((width / 2 + (tx / n - cx) * k) / width) * 100,
        top: ((height / 2 + (ty / n - cy) * k) / height) * 100,
        w: ((size + SEAM) / width) * 100,
        h: ((size + SEAM) / height) * 100,
      });
    }
  }
  return { width, height, project, basemap: { z, tiles } };
}

// ---- where tiles come from -------------------------------------------------

// OpenStreetMap's standard tiles are light; this turns them dark enough to sit
// in the page (the tracker's .tiles-dark).
const OSM_DARK = 'invert(1) hue-rotate(180deg) brightness(.82) contrast(.92) saturate(.35)';
const OSM_CREDIT = {
  label: '© OpenStreetMap contributors',
  href: 'https://www.openstreetmap.org/copyright',
};

const CARTO_CREDIT = { label: '© CARTO', href: 'https://carto.com/attributions' };
const CARTO_DIRECT = 'https://{s}.basemaps.cartocdn.com/dark_all';

// A CARTO source's other two layers, for the tint: always @2x (the tint is made
// for them; a page without a retina screen shows them scaled down).
function cartoLayers(layerUrl) {
  return {
    base: layerUrl('dark_nolabels'),
    labels: layerUrl('dark_only_labels'),
  };
}

/**
 * The tile sources, in order of preference: CARTO through the tracker's relay
 * when `tilesUrl` is set, else CARTO directly when `cartoKey` is, then
 * OpenStreetMap (the only one with no fallback).
 * A CARTO source carries `layers`, the addresses of its map and labels for the
 * tint, unless `tint` is false.
 * @param {string} [tilesUrl] the relay's /api/tiles address
 * @param {string} [cartoKey] a CARTO key limited to this site's domain
 * @param {boolean} [tint] tint CARTO's map back to Dark Matter
 */
export function tileSources(tilesUrl, cartoKey, tint = false) {
  const base = String(tilesUrl || '').replace(/\/+$/, '');
  const key = String(cartoKey || '').trim();
  const osm = {
    id: 'osm',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    filter: OSM_DARK,
    credits: [OSM_CREDIT],
  };
  if (base) {
    return {
      primary: {
        id: tint ? 'carto-dm' : 'carto',
        url: `${base}/{z}/{x}/{y}{r}.png`,
        layers: tint ? cartoLayers((layer) => `${base}/${layer}/{z}/{x}/{y}@2x.png`) : null,
        filter: null,
        credits: [OSM_CREDIT, CARTO_CREDIT],
      },
      fallback: osm,
    };
  }
  if (key) {
    const direct = (layer) =>
      `${CARTO_DIRECT.replace(/dark_all$/, layer)}/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(key)}`;
    return {
      primary: {
        id: tint ? 'carto-dm' : 'carto',
        url: direct('dark_all'),
        layers: tint ? cartoLayers((layer) => direct(layer).replace('{r}', '@2x')) : null,
        filter: null,
        credits: [OSM_CREDIT, CARTO_CREDIT],
      },
      fallback: osm,
    };
  }
  return { primary: osm, fallback: null };
}

/** A tile's address; `retina` asks for the @2x image where the source has one. */
export function tileUrl(source, tile, z, retina) {
  return fillUrl(source.url, tile, z, retina);
}

/** A tinted source's tile: the addresses of its map and labels layers. */
export function layerUrls(source, tile, z) {
  return {
    base: fillUrl(source.layers.base, tile, z, true),
    labels: fillUrl(source.layers.labels, tile, z, true),
  };
}

function fillUrl(template, tile, z, retina) {
  return template
    .replace('{z}', z)
    .replace('{x}', tile.x)
    .replace('{y}', tile.y)
    .replace('{s}', 'abcd'[(tile.x + tile.y) % 4])
    .replace('{r}', retina ? '@2x' : '');
}

// One source for the whole page: the first time the primary shows it can't
// serve (two tiles fail before any has loaded), every map moves to the
// fallback together instead of each discovering it separately.
const tintWanted = () => !/^(off|0|no|false)$/i.test(import.meta.env?.VITE_CARTO_RETINT ?? '');
const sources = tileSources(
  import.meta.env?.VITE_TILES_URL,
  import.meta.env?.VITE_CARTO_KEY,
  tintWanted() && canTint(),
);
let active = sources.primary;
// What the tint's check of CARTO's style finds, should CARTO restyle again.
onStyleNote((said) => console.info(`maps: ${said}`));
let loaded = 0;
let failed = 0;
const listeners = new Set();

export const activeSource = () => active;
export function subscribeSource(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function noteTileLoaded() {
  loaded++;
}

/**
 * The tint can't run in this browser after all (its worker failed): every map
 * goes back to CARTO's dark_all as CARTO draws it.
 */
export function noteTintFailed() {
  const plain = (source) => (source?.layers ? { ...source, id: 'carto', layers: null } : source);
  if (!active.layers) return;
  sources.primary = plain(sources.primary);
  active = plain(active);
  for (const l of listeners) l();
}

export function noteTileFailed(source) {
  if (source !== active || !sources.fallback || loaded > 0) return;
  if (++failed < 2) return;
  active = sources.fallback;
  for (const l of listeners) l();
}

// For tests: start over.
export function resetSource(tilesUrl, cartoKey, tint = false) {
  const next = tileSources(
    tilesUrl ?? import.meta.env?.VITE_TILES_URL,
    cartoKey ?? import.meta.env?.VITE_CARTO_KEY,
    tint,
  );
  sources.primary = next.primary;
  sources.fallback = next.fallback;
  active = next.primary;
  loaded = 0;
  failed = 0;
  for (const l of listeners) l();
}
