import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../lib/config.js';
import {
  CARTO_CREDIT,
  cartoTileUrl,
  checkCarto,
  createBasemap,
  PLACEHOLDER_BG,
  tilePlan,
} from '../map/basemap.js';
import { fitView, project } from '../map/projection.js';

// The slippy-map tile holding a point, and where in it the point sits (0..1) —
// the standard OpenStreetMap formulas, written out here rather than reused.
function slippy(lat, lon, z) {
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const fy = ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
  return { x: Math.floor(fx), y: Math.floor(fy), u: fx - Math.floor(fx), v: fy - Math.floor(fy) };
}

// The latitude/longitude under an image pixel of a view (the inverse of the
// 512-px Mercator the bots draw in), for checking pixels rather than points.
function underPixel(view, px, py) {
  const scale = 2 ** view.zoom;
  const sin = Math.sin((view.lat * Math.PI) / 180);
  const cx = ((view.lon + 180) / 360) * 512;
  const cy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 512;
  const wx = cx + (px - view.width / 2) / scale;
  const wy = cy + (py - view.height / 2) / scale;
  return {
    lon: (wx / 512) * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI - (2 * Math.PI * wy) / 512)) * 180) / Math.PI,
  };
}

// A view like the bots' own: a 1200-px square fitted around some Center City.
const BBOX = { minLat: 39.94, maxLat: 39.97, minLon: -75.2, maxLon: -75.14 };
const view = fitView(BBOX, 1200, 1200, { pad: 120, minZoom: 11, maxZoom: 17 });

// A tile that is one flat colour saying which tile it is.
const tileColor = (z, x, y) => ({ r: x % 256, g: y % 256, b: z * 10 });
async function fakeTile(z, x, y) {
  return sharp({ create: { width: 512, height: 512, channels: 3, background: tileColor(z, x, y) } })
    .png()
    .toBuffer();
}

function fakeTiles({ fail = false, status = 404 } = {}) {
  const calls = [];
  const fetchFn = vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    if (fail) return new Response('no key', { status });
    const m = String(url).match(/\/(\d+)\/(\d+)\/(\d+)@2x\.png/);
    return new Response(await fakeTile(+m[1], +m[2], +m[3]), {
      headers: { 'content-type': 'image/png' },
    });
  });
  return { fetchFn, calls };
}

describe('tilePlan', () => {
  it('picks the smallest zoom that stretches a @2x tile by at most 15%', () => {
    const whole = tilePlan({ ...view, zoom: 13 });
    expect(whole.z).toBe(13);
    expect(whole.size).toBeCloseTo(512, 6);
    const between = tilePlan({ ...view, zoom: 12.5 });
    expect(between.z).toBe(13);
    expect(between.size).toBeCloseTo(362.04, 1);
    // A hair past a whole zoom keeps that zoom's tiles (2% bigger) rather than
    // halving them for the next.
    const hair = tilePlan({ ...view, zoom: 15.02 });
    expect(hair.z).toBe(15);
    expect(hair.size).toBeCloseTo(519.2, 0);
    // Past 15% it moves on.
    const past = tilePlan({ ...view, zoom: 15.3 });
    expect(past.z).toBe(16);
    expect(past.size).toBeCloseTo(315.2, 0);
    for (const zoom of [11, 11.5, 12.2, 13.9, 14.15, 16.99]) {
      const { size } = tilePlan({ ...view, zoom });
      expect(size).toBeGreaterThan(290);
      expect(size).toBeLessThanOrEqual(512 * 2 ** 0.2 + 0.01);
    }
  });

  it('covers the whole image with tiles that share whole-pixel edges', () => {
    const { tiles } = tilePlan(view);
    const lefts = [...new Set(tiles.map((t) => t.left))].sort((a, b) => a - b);
    const tops = [...new Set(tiles.map((t) => t.top))].sort((a, b) => a - b);
    expect(lefts[0]).toBeLessThanOrEqual(0);
    expect(tops[0]).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.right))).toBeGreaterThanOrEqual(1200);
    expect(Math.max(...tiles.map((t) => t.bottom))).toBeGreaterThanOrEqual(1200);
    for (const t of tiles) {
      expect(Number.isInteger(t.left) && Number.isInteger(t.top)).toBe(true);
      const right = tiles.find((o) => o.y === t.y && o.x === t.x + 1);
      if (right) expect(right.left).toBe(t.right);
      const below = tiles.find((o) => o.x === t.x && o.y === t.y + 1);
      if (below) expect(below.top).toBe(t.bottom);
    }
  });

  it('puts every point where the drawing projection puts it', () => {
    const plan = tilePlan(view);
    for (const [lat, lon] of [
      [39.9526, -75.1652],
      [39.945, -75.19],
      [39.965, -75.15],
      [39.95, -75.17],
    ]) {
      const p = project(view, lat, lon);
      const s = slippy(lat, lon, plan.z);
      const tile = plan.tiles.find((t) => t.x === s.x && t.y === s.y);
      expect(tile).toBeDefined();
      expect(tile.left + s.u * (tile.right - tile.left)).toBeCloseTo(p.x, 0);
      expect(tile.top + s.v * (tile.bottom - tile.top)).toBeCloseTo(p.y, 0);
    }
  });

  it('stays inside the world', () => {
    const plan = tilePlan({ lat: 85, lon: -179.9, zoom: 4, width: 1200, height: 1200 });
    for (const t of plan.tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(2 ** plan.z);
      expect(t.y).toBeLessThan(2 ** plan.z);
    }
  });
});

describe('cartoTileUrl', () => {
  it('goes through the relay when there is one', () => {
    expect(cartoTileUrl({ tilesUrl: 'https://tracker.example/api/tiles/' }, 13, 2385, 3101)).toBe(
      'https://tracker.example/api/tiles/13/2385/3101@2x.png',
    );
  });

  it('asks CARTO directly, with the key, otherwise', () => {
    const url = cartoTileUrl({ cartoKey: 'k e/y' }, 13, 2385, 3101);
    expect(url).toMatch(
      /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_all\/13\/2385\/3101@2x\.png\?key=k%20e%2Fy$/,
    );
  });
});

describe('the CARTO basemap', () => {
  it('stitches tiles that line up with the drawing projection', async () => {
    const { fetchFn } = fakeTiles();
    const basemap = createBasemap({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn });
    const png = await basemap(view);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1200, 1200]);

    const plan = tilePlan(view);
    let checked = 0;
    // A dense grid of points across the image (not the credit's corner), each
    // checked against the tile that really holds it.
    for (let i = 0; i < 24; i++) {
      for (let k = 0; k < 24; k++) {
        const lat = BBOX.minLat + ((i + 0.37) / 24) * (BBOX.maxLat - BBOX.minLat);
        const lon = BBOX.minLon + ((k + 0.61) / 24) * (BBOX.maxLon - BBOX.minLon);
        const p = project(view, lat, lon);
        if (p.x < 5 || p.x > 1195 || p.y < 5 || p.y > 1150) continue;
        const s = slippy(lat, lon, plan.z);
        const tile = plan.tiles.find((t) => t.x === s.x && t.y === s.y);
        const w = tile.right - tile.left;
        const h = tile.bottom - tile.top;
        // Skip points within 1.5 px of a tile edge, where rounding may tip either way.
        if (s.u * w < 1.5 || (1 - s.u) * w < 1.5 || s.v * h < 1.5 || (1 - s.v) * h < 1.5) continue;
        const at = (Math.floor(p.y) * 1200 + Math.floor(p.x)) * info.channels;
        const want = tileColor(plan.z, s.x, s.y);
        expect([data[at], data[at + 1], data[at + 2]]).toEqual([want.r, want.g, want.b]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('puts every tile edge on the right pixel', async () => {
    const { fetchFn } = fakeTiles();
    const png = await createBasemap({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn })(
      view,
    );
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const plan = tilePlan(view);
    const scale = 2 ** view.zoom;
    const L = plan.size;
    let checked = 0;
    const check = (px, py) => {
      if (px < 0 || py < 0 || px >= 1200 || py >= 1150) return; // not the credit's corner
      const { lat, lon } = underPixel(view, px + 0.5, py + 0.5);
      const s = slippy(lat, lon, plan.z);
      // Edges are rounded to whole pixels, so skip a pixel whose centre is
      // within 0.75 px of a true edge.
      if (s.u * L < 0.75 || (1 - s.u) * L < 0.75 || s.v * L < 0.75 || (1 - s.v) * L < 0.75) return;
      const at = (py * 1200 + px) * info.channels;
      const want = tileColor(plan.z, s.x, s.y);
      expect([data[at], data[at + 1], data[at + 2]], `pixel ${px},${py}`).toEqual([
        want.r,
        want.g,
        want.b,
      ]);
      checked++;
    };
    expect(scale).toBeGreaterThan(1);
    for (const e of new Set(plan.tiles.map((t) => t.left))) {
      for (let dx = -4; dx < 4; dx++) for (let py = 7; py < 1150; py += 53) check(e + dx, py);
    }
    for (const e of new Set(plan.tiles.map((t) => t.top))) {
      for (let dy = -4; dy < 4; dy++) for (let px = 7; px < 1200; px += 53) check(px, e + dy);
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('credits CARTO and OpenStreetMap in the corner', async () => {
    const { fetchFn } = fakeTiles();
    const png = await createBasemap({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn })(
      view,
    );
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => (y * 1200 + x) * info.channels;
    expect(CARTO_CREDIT).toContain('CARTO');
    expect(CARTO_CREDIT).toContain('OpenStreetMap');

    // The credit's backing darkens the tile under it (black at 55%) ...
    const plan = tilePlan(view);
    const under = plan.tiles.find(
      (t) => t.left <= 1197 && 1197 < t.right && t.top <= 1197 && 1197 < t.bottom,
    );
    const want = tileColor(plan.z, under.x, under.y);
    const got = data.slice(at(1197, 1197), at(1197, 1197) + 3);
    for (const [i, c] of [want.r, want.g, want.b].entries()) {
      expect(Math.abs(got[i] - Math.round(c * 0.45))).toBeLessThanOrEqual(3);
    }
    // ... and its text is drawn over that: the strip is not one flat colour.
    const seen = new Set();
    for (let y = 1178; y < 1192; y++) {
      for (let x = 840; x < 1190; x++) seen.add(data[at(x, y)]);
    }
    expect(seen.size).toBeGreaterThan(2);

    // The opposite corner is plain tile.
    const first = plan.tiles.find((t) => t.left <= 5 && 5 < t.right && t.top <= 5 && 5 < t.bottom);
    const plain = tileColor(plan.z, first.x, first.y);
    expect([...data.slice(at(5, 5), at(5, 5) + 3)]).toEqual([plain.r, plain.g, plain.b]);
  });

  it('asks the relay without a key or a Referer', async () => {
    const { fetchFn, calls } = fakeTiles();
    await createBasemap({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn })(view);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.url).toMatch(/^https:\/\/tracker\.example\/api\/tiles\/\d+\/\d+\/\d+@2x\.png$/);
      expect(c.headers.referer).toBeUndefined();
      expect(c.headers['user-agent']).toContain('septa-transit-alerts-bots');
    }
  });

  it('asks CARTO directly with the key and the Referer', async () => {
    const { fetchFn, calls } = fakeTiles();
    await createBasemap({
      cartoKey: 'SECRET',
      cartoReferer: 'https://site.example/',
      fetchFn,
    })(view);
    for (const c of calls) {
      expect(c.url).toContain('basemaps.cartocdn.com/dark_all/');
      expect(c.url).toContain('key=SECRET');
      expect(c.headers.referer).toBe('https://site.example/');
    }
  });

  it('reuses tiles it already has', async () => {
    const { fetchFn } = fakeTiles();
    const basemap = createBasemap({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn });
    await basemap(view);
    const first = fetchFn.mock.calls.length;
    await basemap(view);
    expect(fetchFn.mock.calls.length).toBe(first);
  });

  it('retries a tile, and gives up with an error that does not carry the key', async () => {
    const { fetchFn } = fakeTiles({ fail: true });
    const logs = [];
    const basemap = createBasemap({
      cartoKey: 'SECRET',
      fetchFn,
      retryDelayMs: 0,
      log: (m) => logs.push(m),
    });
    const err = await basemap(view).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/tile \d+\/\d+\/\d+: HTTP 404/);
    expect(err.message).not.toContain('SECRET');
    expect(logs.join('\n')).not.toContain('SECRET');
    // Three tries for the tile that failed first.
    const urls = fetchFn.mock.calls.map(([u]) => u);
    expect(urls.filter((u) => u === urls[0]).length).toBe(3);
  });

  it('rejects a reply that is not an image', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }),
    );
    const err = await createBasemap({
      tilesUrl: 'https://t.example/api/tiles',
      fetchFn,
      retryDelayMs: 0,
    })(view).catch((e) => e);
    expect(err.message).toMatch(/not an image/);
  });

  it('falls back to Mapbox when CARTO fails, if there is a token', async () => {
    const mapboxPng = await sharp({
      create: { width: 2400, height: 2400, channels: 3, background: '#123456' },
    })
      .png()
      .toBuffer();
    const fetchFn = vi.fn(async (url) =>
      String(url).includes('api.mapbox.com')
        ? new Response(mapboxPng, { headers: { 'content-type': 'image/png' } })
        : new Response('no', { status: 502 }),
    );
    const logs = [];
    const png = await createBasemap({
      tilesUrl: 'https://tracker.example/api/tiles',
      token: 'pk.x',
      fetchFn,
      retryDelayMs: 0,
      log: (m) => logs.push(m),
    })(view);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([1200, 1200]);
    expect([data[0], data[1], data[2]]).toEqual([0x12, 0x34, 0x56]);
    expect(logs.some((m) => /CARTO.*trying Mapbox/.test(m))).toBe(true);
  });

  it('uses Mapbox alone when only a token is set', async () => {
    const mapboxPng = await sharp({
      create: { width: 2400, height: 2400, channels: 3, background: '#654321' },
    })
      .png()
      .toBuffer();
    const fetchFn = vi.fn(
      async () => new Response(mapboxPng, { headers: { 'content-type': 'image/png' } }),
    );
    await createBasemap({ token: 'pk.x', fetchFn })(view);
    expect(String(fetchFn.mock.calls[0][0])).toContain('api.mapbox.com');
    expect(fetchFn.mock.calls.length).toBe(1);
  });

  it('draws a plain background with nothing configured', async () => {
    const fetchFn = vi.fn();
    const png = await createBasemap({ fetchFn })(view);
    const { data } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const bg = PLACEHOLDER_BG.match(/\w\w/g).map((h) => Number.parseInt(h, 16));
    expect([data[0], data[1], data[2]]).toEqual(bg);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('checkCarto', () => {
  it('reports a working relay', async () => {
    const { fetchFn } = fakeTiles();
    const res = await checkCarto({ tilesUrl: 'https://tracker.example/api/tiles', fetchFn });
    expect(res).toEqual({ ok: true, detail: '512-px tile' });
  });

  it('reports what went wrong without the key', async () => {
    const { fetchFn } = fakeTiles({ fail: true, status: 403 });
    const res = await checkCarto({ cartoKey: 'SECRET', fetchFn });
    expect(res.ok).toBe(false);
    expect(res.detail).toBe('HTTP 403');
  });
});

describe('config', () => {
  it('reads the tile settings', () => {
    const c = loadConfig({
      TILES_URL: ' https://tracker.example/api/tiles ',
      CARTO_KEY: 'k',
      CARTO_REFERER: 'https://site.example/',
      MAPBOX_TOKEN: 'pk.x',
    });
    expect(c.tilesUrl).toBe('https://tracker.example/api/tiles');
    expect(c.cartoKey).toBe('k');
    expect(c.cartoReferer).toBe('https://site.example/');
    expect(c.mapboxToken).toBe('pk.x');
  });

  it('sends the site as the Referer for a key, unless told otherwise', () => {
    const base = { CARTO_KEY: 'k', SITE_URL: 'https://site.example/' };
    expect(loadConfig(base).cartoReferer).toBe('https://site.example/');
    expect(loadConfig({ ...base, SITE_URL: 'https://site.example' }).cartoReferer).toBe(
      'https://site.example/',
    );
    expect(loadConfig({ ...base, CARTO_REFERER: 'https://other.example/' }).cartoReferer).toBe(
      'https://other.example/',
    );
    // No key, or no site: nothing to send.
    expect(loadConfig({ SITE_URL: 'https://site.example/' }).cartoReferer).toBeNull();
    expect(loadConfig({ CARTO_KEY: 'k' }).cartoReferer).toBeNull();
  });

  it('has none of them by default', () => {
    const c = loadConfig({});
    expect([c.tilesUrl, c.cartoKey, c.cartoReferer, c.mapboxToken]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});
