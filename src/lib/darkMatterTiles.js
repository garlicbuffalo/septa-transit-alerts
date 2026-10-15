// CARTO's dark map tiles for the page, tinted back to the classic Dark Matter
// look (CARTO restyled it on 2026-10-14; see darkMatter.js). Each tile is its
// map and its labels, two layers fetched, tinted and drawn as one PNG by a Web
// Worker (darkMatter.worker.js), so the page itself never stalls on it; the
// map shows the PNG through an object URL.
//
// A browser without module workers, OffscreenCanvas or createImageBitmap
// can't tint, and gets CARTO's dark_all as it comes (basemap.js decides).

import { styleTally } from './darkMatter.js';

const MAX_WORKERS = 4;
const KEEP = 400; // tiles kept, as object URLs, before the oldest is let go

/** Whether this browser can tint tiles at all. */
export function canTint() {
  return (
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof createImageBitmap === 'function' &&
    typeof URL?.createObjectURL === 'function'
  );
}

let workers = null;
let nextWorker = 0;
let nextId = 0;
const pending = new Map(); // id -> { resolve, reject }
const tiles = new Map(); // address -> Promise<object URL>, oldest first
let listener = null;
// The page's judgement of CARTO's style, over every tile it has tinted.
let tally = styleTally();

// Told when that judgement changes (`said` from styleTally).
export function onStyleNote(fn) {
  listener = fn;
}

function settle({ data }) {
  const job = pending.get(data.id);
  if (!job) return;
  pending.delete(data.id);
  if (data.fit) {
    const { said } = tally.add(data.fit);
    if (said) listener?.(said);
  }
  if (data.blob) job.resolve(URL.createObjectURL(data.blob));
  else job.reject(Object.assign(new Error(data.error), { kind: data.kind }));
}

// A worker that cannot start (no module workers) fails every tile it holds as
// the tint's fault, so the page goes back to tiles as CARTO draws them.
function broken() {
  for (const job of pending.values()) {
    job.reject(Object.assign(new Error('the tile worker failed'), { kind: 'tint' }));
  }
  pending.clear();
}

function pool() {
  if (!workers) {
    const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency ?? 2) - 1));
    workers = Array.from({ length: count }, () => {
      const w = new Worker(new URL('./darkMatter.worker.js', import.meta.url), { type: 'module' });
      w.onmessage = settle;
      w.onerror = broken;
      return w;
    });
  }
  return workers;
}

/**
 * A tile, tinted: a promise of an object URL for an <img>. `layers` are the
 * map's and the labels' addresses. Rejects with `kind` 'fetch' when the tile
 * can't be had, 'tint' when this browser can't tint it.
 */
export function tintedTile({ base, labels }, z) {
  const key = `${base} ${labels}`;
  const known = tiles.get(key);
  if (known) {
    // Most recently used goes last.
    tiles.delete(key);
    tiles.set(key, known);
    return known;
  }
  const job = new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const all = pool();
    all[nextWorker++ % all.length].postMessage({ id, base, labels, z, sum: tally.sum() });
  });
  tiles.set(key, job);
  // A failed tile is not kept: asked again, it is tried again.
  job.catch(() => tiles.get(key) === job && tiles.delete(key));
  while (tiles.size > KEEP) {
    const [oldest, url] = tiles.entries().next().value;
    tiles.delete(oldest);
    url.then(
      (u) => URL.revokeObjectURL(u),
      () => {},
    );
  }
  return job;
}

// For tests: start over.
export function resetTintedTiles() {
  for (const w of workers ?? []) w.terminate();
  workers = null;
  pending.clear();
  tiles.clear();
  listener = null;
  tally = styleTally();
}
