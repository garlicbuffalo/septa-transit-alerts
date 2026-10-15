import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../lib/config.js';
import {
  CARTO_CREDIT,
  cartoTileUrl,
  checkCarto,
  createBasemap,
  judgeStyle,
  labelFit,
  overlayLabels,
  PLACEHOLDER_BG,
  retintBase,
  styleFit,
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

  it('names the layer it wants, to CARTO and to the relay', () => {
    expect(cartoTileUrl({ cartoKey: 'k' }, 13, 2385, 3101, 'dark_only_labels')).toMatch(
      /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_only_labels\/13\/2385\/3101@2x\.png\?key=k$/,
    );
    expect(
      cartoTileUrl({ tilesUrl: 'https://t.example/api/tiles' }, 13, 1, 2, 'dark_nolabels'),
    ).toBe('https://t.example/api/tiles/dark_nolabels/13/1/2@2x.png');
  });
});

// A tile in CARTO's new style, drawn by hand: `paint(x, y)` gives each pixel's
// colour as [r, g, b] (or [r, g, b, a] for labels).
function tile(size, channels, paint) {
  const px = Buffer.alloc(size * size * channels);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) px.set(paint(x, y), (y * size + x) * channels);
  }
  return px;
}
const grey = (v) => [v, v, v];
const NEW = {
  land: grey(0x0e),
  water: [0x2c, 0x35, 0x3c],
  street: [0x41, 0x47, 0x58],
  main: [0x53, 0x56, 0x66],
  motorway: grey(0x49),
  building16: grey(0x39),
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));

describe("re-tinting CARTO's new dark map to Dark Matter", () => {
  const S = 64;
  const at = (px, x, y) => px[(y * S + x) * 3];

  it('gives land, water and streets their old colours, edges blended alike', () => {
    // Water on the left, land in the middle, a street on the right, with a
    // half-and-half pixel column between land and street.
    const px = tile(S, 3, (x) =>
      x < 20
        ? NEW.water
        : x < 40
          ? NEW.land
          : x === 40
            ? mix(NEW.land, NEW.street, 0.5)
            : NEW.street,
    );
    const out = retintBase(px, S, S, 3, 16);
    expect(at(out, 5, 30)).toBe(0x26); // @water
    expect(at(out, 30, 30)).toBe(0x09); // @landmass_fill
    expect(at(out, 55, 30)).toBe(0x19); // @street
    expect(Math.abs(at(out, 40, 30) - (0x09 + 0x19) / 2)).toBeLessThanOrEqual(1);
    // Grey throughout: no blue left.
    for (let i = 0; i < out.length; i += 3) expect(out[i + 2]).toBe(out[i]);
  });

  it('draws main roads and motorways dark with a lighter casing', () => {
    for (const road of [NEW.main, NEW.motorway]) {
      // A 12-px road across the middle of the land.
      const px = tile(S, 3, (_, y) => (y >= 26 && y < 38 ? road : NEW.land));
      const out = retintBase(px, S, S, 3, 15);
      expect(at(out, 30, 31)).toBe(0x03); // @main / @motorway
      expect(at(out, 30, 26)).toBe(0x2a); // @main_case
      expect(at(out, 30, 37)).toBe(0x2a);
      expect(at(out, 30, 10)).toBe(0x09);
      // Not at the tile's own edge, where the road carries on into the next.
      expect(at(out, 0, 31)).toBe(0x03);
    }
  });

  it('turns buildings black with a #111 outline, light roofs and all', () => {
    // A building with a lighter roof section, and a thin line of the same grey
    // as a building (a path) that is not one.
    const px = tile(S, 3, (x, y) => {
      if (x >= 10 && x < 40 && y >= 10 && y < 40) {
        // The roof as CARTO draws one: its own grey, a darker line round it.
        if (x >= 19 && x < 31 && y >= 19 && y < 31) {
          return x === 19 || x === 30 || y === 19 || y === 30 ? grey(0x2a) : grey(0x34);
        }
        return NEW.building16;
      }
      if (y === 50) return grey(0x26);
      return NEW.land;
    });
    const out = retintBase(px, S, S, 3, 16);
    expect(at(out, 15, 15)).toBe(0x00); // @buildings
    expect(at(out, 25, 25)).toBe(0x00); // the roof: building, not a lighter grey
    expect(at(out, 10, 25)).toBe(0x11); // @building_outline
    expect(at(out, 39, 25)).toBe(0x11);
    expect(at(out, 25, 5)).toBe(0x09);
    // The line stays a line a little lighter than the land, as in Dark Matter.
    expect(at(out, 30, 50)).toBeGreaterThan(0x09);
  });

  it('reads the zoom: below z14 a light grey area is no building', () => {
    const px = tile(S, 3, (x, y) =>
      x >= 10 && x < 40 && y >= 10 && y < 40 ? NEW.building16 : NEW.land,
    );
    expect(at(retintBase(px, S, S, 3, 13), 25, 25)).toBeGreaterThan(0x20);
    expect(at(retintBase(px, S, S, 3, 17), 25, 25)).toBe(0x00);
  });

  it('takes RGBA tiles as they come', () => {
    const px = tile(S, 4, () => [...NEW.street, 255]);
    expect(at(retintBase(px, S, S, 4, 15), 30, 30)).toBe(0x19);
  });

  it('tints labels to Dark Matter: road names #333 on #030303, places #444 on #191919', () => {
    // Left half a road name, right half a place name: halo all round (80%
    // opaque), text (opaque) in a 4-px stroke in the middle.
    const px = tile(S, 4, (x, y) => {
      const road = x < 32;
      const halo = road ? 0x2d : 0x3c;
      const text = road ? 0x71 : 0xa1;
      if (y < 20 || y >= 30 || x % 32 < 2 || x % 32 >= 30) return [0, 0, 0, 0];
      if (y >= 23 && y < 27 && x % 32 >= 6 && x % 32 < 26) return [...grey(text), 255];
      return [...grey(halo), 204];
    });
    const base = Buffer.alloc(S * S * 3, 0x09);
    overlayLabels(px, base, S, S);
    const over = (c) => Math.round(0x09 * 0.2 + c * 0.8); // the halo is 80% opaque
    expect(at(base, 16, 21)).toBe(over(0x03));
    expect(at(base, 16, 25)).toBe(0x33);
    expect(at(base, 48, 21)).toBe(over(0x19));
    expect(at(base, 48, 25)).toBe(0x44);
    expect(at(base, 16, 5)).toBe(0x09); // no label: the map shows through
  });

  it('splits antialiased text between the old text and halo', () => {
    // Half text over the halo: alpha 0.9, colour (0.5·T + 0.4·H) / 0.9.
    const a = 0.9;
    const c = Math.round((0.5 * 0xa1 + 0.4 * 0x3c) / a);
    const px = tile(S, 4, (x) =>
      x === 30 ? [...grey(c), Math.round(a * 255)] : [...grey(0x3c), 204],
    );
    const base = Buffer.alloc(S * S * 3, 0);
    overlayLabels(px, base, S, S);
    expect(Math.abs(at(base, 30, 30) - (0.5 * 0x44 + 0.4 * 0x19))).toBeLessThanOrEqual(1);
  });
});

// Tiles in today's style (land with a street across it, a road name's halo)
// or in one the tint was not made for (light land, blue halos), served for
// either layer. The street's width goes with the tile's x, so maps differ.
function styledTiles(style) {
  const today = style === 'today';
  return vi.fn(async (url) => {
    const labels = /only_labels/.test(url);
    const street = 330 + (Number(String(url).match(/\/(\d+)\/\d+@2x/)[1]) % 5) * 30;
    const px = labels
      ? tile(512, 4, (_, y) =>
          y >= 100 && y < 140 ? [...(today ? grey(0x2d) : [0x20, 0x40, 0x90]), 204] : [0, 0, 0, 0],
        )
      : tile(512, 3, (_, y) =>
          y >= 300 && y < street ? NEW.street : today ? NEW.land : grey(0xf0),
        );
    const raw = { width: 512, height: 512, channels: labels ? 4 : 3 };
    const png = await sharp(px, { raw }).png().toBuffer();
    return new Response(png, { headers: { 'content-type': 'image/png' } });
  });
}

describe('the safety valve for another CARTO restyle', () => {
  // A small map at a whole zoom; its value at a spot that is plain land (not
  // the label, rows 100–139 of a tile, nor the street, from row 300).
  const small = { ...view, zoom: 15, width: 600, height: 300 };
  const land = async (png) => {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const { tiles } = tilePlan(small);
    for (let y = 0; y < 300; y++) {
      const t = tiles.find((t) => t.left <= 300 && 300 < t.right && t.top <= y && y < t.bottom);
      const v = ((y - t.top) / (t.bottom - t.top)) * 512;
      const plain = (v > 10 && v < 90) || (v > 150 && v < 290);
      if (plain) return data[(y * 600 + 300) * info.channels];
    }
    throw new Error('no plain land in view');
  };

  it('tints a map whose tiles are in the style it was made for', async () => {
    const logs = [];
    const png = await createBasemap({
      cartoKey: 'k',
      fetchFn: styledTiles('today'),
      log: (m) => logs.push(m),
    })(small);
    expect(await land(png)).toBe(0x09);
    expect(logs).toEqual([]);
  });

  it("draws a map as CARTO does once CARTO's style changes, and says so once", async () => {
    const logs = [];
    const basemap = createBasemap({
      cartoKey: 'k',
      fetchFn: styledTiles('restyled'),
      log: (m) => logs.push(m),
    });
    expect(await land(await basemap(small))).toBe(0xf0);
    // Another map, with other shares known: still said only once.
    await basemap({ ...small, lat: small.lat + 0.05, width: 900 });
    expect(logs).toEqual([
      expect.stringMatching(
        /^basemap: CARTO's style has changed \(map \d+% known, labels 0%\): map and labels drawn as CARTO draws them$/,
      ),
    ]);
  });

  it('says when the tint is back', async () => {
    let fetchFn = styledTiles('restyled');
    const logs = [];
    const basemap = createBasemap({
      cartoKey: 'k',
      fetchFn: (url, init) => fetchFn(url, init),
      log: (m) => logs.push(m),
    });
    await basemap(small);
    fetchFn = styledTiles('today');
    await basemap({ ...small, lat: small.lat + 0.05 }); // other tiles, not remembered
    expect(logs.length).toBe(2);
    expect(logs[1]).toBe('basemap: tinted to Dark Matter');
  });

  it('judges a whole map, the labels on their own unless too few', () => {
    const fit = (bk, bt, lk, lt) => ({
      base: { known: bk, total: bt },
      labels: { known: lk, total: lt },
    });
    expect(judgeStyle([fit(80, 100, 900, 1000)])).toMatchObject({ base: true, labels: true });
    expect(judgeStyle([fit(80, 100, 10, 1000)])).toMatchObject({ base: true, labels: false });
    expect(judgeStyle([fit(5, 100, 900, 1000)])).toMatchObject({ base: false, labels: true });
    expect(judgeStyle([fit(5, 100, 0, 50)])).toMatchObject({ base: false, labels: false });
    expect(judgeStyle([fit(80, 100, 0, 50)])).toMatchObject({ base: true, labels: true });
    expect(judgeStyle([fit(10, 100, 0, 0), fit(90, 100, 0, 0)]).base).toBe(true);
  });

  it('counts the pixels that are a colour of the style', () => {
    const base = tile(64, 3, (x) => (x < 48 ? NEW.land : NEW.street));
    expect(styleFit(base, 64, 64, 3, 15)).toEqual({ known: 64 * 64, total: 64 * 64 });
    expect(
      styleFit(
        tile(64, 3, () => grey(0x80)),
        64,
        64,
        3,
        15,
      ).known,
    ).toBe(0);
    const labels = tile(64, 4, (x) => [...grey(x < 32 ? 0x3c : 0x99), 204]);
    expect(labelFit(labels, 64, 64)).toEqual({ known: 32 * 64, total: 64 * 64 });
  });

  it('with CARTO_RETINT=off takes dark_all as it comes, one request a tile', async () => {
    const direct = fakeTiles();
    await createBasemap({ cartoKey: 'k', retint: false, fetchFn: direct.fetchFn })(view);
    expect(direct.calls.length).toBe(tilePlan(view).tiles.length);
    for (const c of direct.calls) expect(c.url).toContain('.basemaps.cartocdn.com/dark_all/');
    const relay = fakeTiles();
    await createBasemap({
      tilesUrl: 'https://t.example/api/tiles',
      retint: false,
      fetchFn: relay.fetchFn,
    })(view);
    for (const c of relay.calls) expect(c.url).toMatch(/\/api\/tiles\/\d+\/\d+\/\d+@2x\.png$/);
    const res = await checkCarto({ cartoKey: 'k', retint: false, fetchFn: fakeTiles().fetchFn });
    expect(res.detail).toBe('512-px tile, as CARTO draws it (CARTO_RETINT off)');
    expect(loadConfig({ CARTO_RETINT: 'off' }).retint).toBe(false);
    expect(loadConfig({ CARTO_RETINT: ' 0 ' }).retint).toBe(false);
    expect(loadConfig({}).retint).toBe(true);
  });

  it("reports in `check` whether CARTO's style is still the one it tints", async () => {
    const ok = await checkCarto({ cartoKey: 'k', fetchFn: styledTiles('today') });
    expect(ok).toEqual({ ok: true, detail: '512-px tiles, tinted to Dark Matter' });
    const changed = await checkCarto({ cartoKey: 'k', fetchFn: styledTiles('restyled') });
    expect(changed.ok).toBe(true);
    expect(changed.detail).toMatch(/CARTO's style has changed/);
  });
});

describe("without CARTO's labels layer", () => {
  // CARTO's map in today's style; its labels layer answering 404 while `gone`.
  function labelsGone() {
    const state = { gone: true, calls: [] };
    const today = styledTiles('today');
    state.fetchFn = async (url, init) => {
      state.calls.push(String(url));
      if (state.gone && /only_labels/.test(url))
        return new Response('no such style', { status: 404 });
      return today(url, init);
    };
    return state;
  }
  const small = { ...view, zoom: 15, width: 600, height: 300 };

  it('draws the map without labels, says so once, and asks again an hour later', async () => {
    const state = labelsGone();
    let clock = 0;
    const logs = [];
    const basemap = createBasemap({
      cartoKey: 'k',
      fetchFn: state.fetchFn,
      retryDelayMs: 0,
      now: () => clock,
      log: (m) => logs.push(m),
    });
    const png = await basemap(small);
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([600, 300]);
    // Tinted all the same: no blue left anywhere but the credit.
    for (let i = 0; i < 600 * 250 * info.channels; i += info.channels) {
      expect(data[i + 2]).toBe(data[i]);
    }
    expect(logs).toEqual([
      "basemap: CARTO's labels layer (dark_only_labels) failed (HTTP 404): maps drawn without street and place names",
    ]);
    // Tiles load eight at a time, so each of the first few tries (three times);
    // after that, no tile asks for the labels layer until the hour is up.
    const asked = () => state.calls.filter((u) => /only_labels/.test(u)).length;
    const first = asked();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(3 * 8);
    await basemap({ ...small, lat: small.lat + 0.05 });
    expect(asked()).toBe(first);
    expect(logs.length).toBe(1);

    // An hour later it asks again, and finds it back.
    clock += 60 * 60 * 1000;
    state.gone = false;
    await basemap({ ...small, lat: small.lat + 0.1 });
    expect(asked()).toBeGreaterThan(first);
    expect(logs[1]).toBe("basemap: CARTO's labels layer is back");
  });

  it('says so in `check`', async () => {
    const res = await checkCarto({ cartoKey: 'k', fetchFn: labelsGone().fetchFn });
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(
      /no labels layer \(HTTP 404\): maps drawn without street and place names/,
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
    expect(calls.length).toBe(2 * tilePlan(view).tiles.length);
    for (const c of calls) {
      expect(c.url).toMatch(
        /^https:\/\/tracker\.example\/api\/tiles\/dark_(nolabels|only_labels)\/\d+\/\d+\/\d+@2x\.png$/,
      );
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
    // Two layers per tile, re-tinted and laid together: the map and its labels.
    const layers = (layer) =>
      calls.filter((c) => c.url.includes(`.basemaps.cartocdn.com/${layer}/`));
    expect(layers('dark_nolabels').length).toBe(tilePlan(view).tiles.length);
    expect(layers('dark_only_labels').length).toBe(tilePlan(view).tiles.length);
    expect(layers('dark_all').length).toBe(0);
    for (const c of calls) {
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
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/^512-px tiles, /);
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
