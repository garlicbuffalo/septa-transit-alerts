import '@testing-library/jest-dom';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The site's maps with CARTO's tiles tinted back to Dark Matter. The tint
// itself runs in a Web Worker, which jsdom has not; here the worker's side
// (darkMatterTiles.js) is stood in for, and what is checked is what the maps
// ask it for and what they do with its answers. The tint is tested in
// darkMatter.test.js, and in a real browser by hand.
const tinted = vi.hoisted(() => ({ calls: [], answer: null }));
vi.mock('../lib/darkMatterTiles.js', () => ({
  canTint: () => false,
  onStyleNote: () => {},
  tintedTile: (layers, z) => {
    tinted.calls.push({ ...layers, z });
    return tinted.answer(layers, z);
  },
}));

// jsdom has no SVG geometry or layout, which Leaflet checks for when it loads
// and when it sizes the map.
vi.hoisted(() => {
  window.SVGSVGElement.prototype.createSVGRect = () => ({});
});
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 400 });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

const { default: EventMap } = await import('../components/EventMap.jsx');
const { default: InteractiveMap } = await import('../components/InteractiveMap.jsx');
const { activeSource, layerUrls, resetSource, tileSources } = await import('../lib/basemap.js');

const blobFor = ({ base }) => `blob:tinted/${base.match(/\/(\d+\/\d+\/\d+)@2x/)[1]}`;
const lineMap = () =>
  render(<EventMap lineKey="l1" fromStation="34th St" toStation="15th St/City Hall" active />);
const images = (container) => [...container.querySelectorAll('img')];

beforeEach(() => {
  tinted.calls = [];
  tinted.answer = async (layers) => blobFor(layers);
});
afterEach(() => act(() => resetSource('')));

describe('tinted tile sources', () => {
  it('give a CARTO source its map and labels layers, @2x, with the key', () => {
    const { primary } = tileSources('', 'k e/y', true);
    expect(primary.id).toBe('carto-dm');
    const urls = layerUrls(primary, { x: 1192, y: 1551 }, 12);
    expect(urls.base).toMatch(
      /^https:\/\/[a-d]\.basemaps\.cartocdn\.com\/dark_nolabels\/12\/1192\/1551@2x\.png\?key=k%20e%2Fy$/,
    );
    expect(urls.labels).toMatch(/\/dark_only_labels\/12\/1192\/1551@2x\.png\?key=k%20e%2Fy$/);
    // dark_all stays the plain address, for a browser that can't tint.
    expect(primary.url).toContain('/dark_all/');
  });

  it('ask the relay for the layers under their names', () => {
    const { primary } = tileSources('https://tracker.example/api/tiles/', '', true);
    expect(layerUrls(primary, { x: 3, y: 4 }, 5)).toEqual({
      base: 'https://tracker.example/api/tiles/dark_nolabels/5/3/4@2x.png',
      labels: 'https://tracker.example/api/tiles/dark_only_labels/5/3/4@2x.png',
    });
  });

  it('are plain without the tint, and OpenStreetMap is never tinted', () => {
    expect(tileSources('', 'k', false).primary.layers).toBeNull();
    expect(tileSources('', 'k', true).fallback.layers).toBeUndefined();
    expect(tileSources('', '', true).primary.id).toBe('osm');
  });
});

describe('a line map on tinted tiles', () => {
  it('shows each tile the worker tints, once it is ready', async () => {
    act(() => resetSource('', 'abc', true));
    const { container } = lineMap();
    await waitFor(() => expect(images(container).length).toBeGreaterThan(1));
    expect(images(container).length).toBe(tinted.calls.length);
    for (const img of images(container)) expect(img.getAttribute('src')).toMatch(/^blob:tinted\//);
    for (const call of tinted.calls) {
      expect(call.base).toContain('/dark_nolabels/');
      expect(call.labels).toContain('/dark_only_labels/');
    }
  });

  it("goes back to CARTO's own tiles when this browser can't tint", async () => {
    tinted.answer = async () => {
      throw Object.assign(new Error('no worker'), { kind: 'tint' });
    };
    act(() => resetSource('', 'abc', true));
    const { container } = lineMap();
    await waitFor(() => expect(activeSource().layers).toBeNull());
    await waitFor(() => expect(images(container).length).toBeGreaterThan(1));
    for (const img of images(container)) expect(img.getAttribute('src')).toContain('/dark_all/');
  });

  it('moves to OpenStreetMap when the tiles themselves fail', async () => {
    tinted.answer = async () => {
      throw Object.assign(new Error('HTTP 403'), { kind: 'fetch' });
    };
    act(() => resetSource('', 'abc', true));
    const { container } = lineMap();
    await waitFor(() => expect(activeSource().id).toBe('osm'));
    await waitFor(() =>
      expect(images(container)[0]?.getAttribute('src')).toMatch(/tile\.openstreetmap\.org/),
    );
  });
});

describe('an interactive map on tinted tiles', () => {
  const ROUTE = [
    [39.95, -75.19],
    [39.96, -75.17],
    [39.98, -75.14],
  ];
  const map = () =>
    render(
      <InteractiveMap
        label="Route 17"
        fit={ROUTE}
        lines={[{ id: 'a', points: ROUTE, color: '#60a5fa' }]}
      />,
    );
  const tiles = (container) => [...container.querySelectorAll('img.leaflet-tile')];

  it('gets every tile from the worker', async () => {
    act(() => resetSource('', 'abc', true));
    const { container } = map();
    await waitFor(() => expect(tiles(container).length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(tiles(container).every((t) => /^blob:tinted\//.test(t.getAttribute('src')))).toBe(
        true,
      ),
    );
    // Each tile is the one Leaflet placed there.
    const [first] = tiles(container);
    const [, z, x, y] = first.getAttribute('src').match(/(\d+)\/(\d+)\/(\d+)$/);
    expect(tinted.calls.some((c) => c.base.includes(`/${z}/${x}/${y}@2x`))).toBe(true);
  });

  it("goes back to CARTO's own tiles when this browser can't tint", async () => {
    tinted.answer = async () => {
      throw Object.assign(new Error('no worker'), { kind: 'tint' });
    };
    act(() => resetSource('', 'abc', true));
    const { container } = map();
    await waitFor(() => expect(activeSource().layers).toBeNull());
    await waitFor(() =>
      expect(tiles(container).some((t) => t.getAttribute('src')?.includes('/dark_all/'))).toBe(
        true,
      ),
    );
  });
});
