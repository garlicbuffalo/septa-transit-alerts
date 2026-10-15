import '@testing-library/jest-dom';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The site's maps on CARTO's vector tiles. MapLibre needs WebGL, which jsdom
// has not, so what draws them (vectorMap.js's picture and Leaflet layer) is
// stood in for here; this checks what the maps ask of it and what they do with
// the answer. The drawing itself was checked in Chromium.
const drawn = vi.hoisted(() => ({ pictures: [], layers: [], picture: null, layer: null }));
vi.mock('../lib/vectorMap.js', async (real) => {
  const actual = await real();
  return {
    ...actual,
    canDrawVector: () => false,
    staticMap: (view, key) => {
      drawn.pictures.push({ ...view, key });
      return drawn.picture(view);
    },
    leafletLayer: async (key, onFail) => {
      const L = (await import('leaflet')).default;
      const layer = L.layerGroup();
      layer.fail = onFail;
      drawn.layers.push({ key, layer });
      return drawn.layer?.(layer) ?? layer;
    },
  };
});

// jsdom has no SVG geometry or layout, which Leaflet checks for.
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
const { activeSource, fitMercator, mercator, resetSource, tileSources } = await import(
  '../lib/basemap.js'
);
const { withKey, watchFailures } = await import('../lib/vectorMap.js');

const lineMap = () =>
  render(<EventMap lineKey="l1" fromStation="34th St" toStation="15th St/City Hall" active />);

beforeEach(() => {
  drawn.pictures = [];
  drawn.layers = [];
  drawn.picture = async () => 'blob:vector/picture';
  drawn.layer = null;
});
afterEach(() => act(() => resetSource('')));

describe('the vector source', () => {
  it('is CARTO with a key, the raster tiles kept behind it', () => {
    const { primary, fallback } = tileSources('', 'k', true);
    expect(primary.id).toBe('carto-vector');
    expect(primary.vector).toEqual({ key: 'k' });
    expect(primary.url).toContain('/dark_all/');
    expect(fallback.id).toBe('osm');
  });

  it('is not used through the relay, nor without it asked for', () => {
    expect(tileSources('https://t.example/api/tiles', '', true).primary.vector).toBeUndefined();
    expect(tileSources('', 'k', false).primary.vector).toBeNull();
    expect(tileSources('', '', true).primary.id).toBe('osm');
  });
});

describe('withKey', () => {
  it("puts the key on CARTO's addresses only", () => {
    expect(withKey('https://tiles-a.basemaps.cartocdn.com/vectortiles/x/1/2/3.mvt', 'k e')).toBe(
      'https://tiles-a.basemaps.cartocdn.com/vectortiles/x/1/2/3.mvt?key=k+e',
    );
    expect(withKey('https://tiles.basemaps.cartocdn.com/fonts/A/0-255.pbf?x=1', 'k')).toBe(
      'https://tiles.basemaps.cartocdn.com/fonts/A/0-255.pbf?x=1&key=k',
    );
    expect(withKey('/maps/dark-matter.json', 'k')).toBe('/maps/dark-matter.json');
    expect(withKey('https://evil.example/basemaps.cartocdn.com/x', 'k')).toBe(
      'https://evil.example/basemaps.cartocdn.com/x',
    );
  });
});

describe('watchFailures', () => {
  const fakeMap = () => {
    const on = {};
    return {
      on: (type, fn) => {
        on[type] = fn;
      },
      fire: (type, e) => on[type]?.(e),
    };
  };

  it('gives up once two tiles fail before any has drawn', () => {
    const map = fakeMap();
    const onFail = vi.fn();
    watchFailures(map, onFail);
    map.fire('error', { sourceId: 'carto', tile: {}, error: { status: 403 } });
    expect(onFail).not.toHaveBeenCalled();
    map.fire('error', { sourceId: 'carto', tile: {}, error: { status: 403 } });
    map.fire('error', { sourceId: 'carto', tile: {}, error: { status: 403 } });
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('gives up at once when the style fails', () => {
    const map = fakeMap();
    const onFail = vi.fn();
    watchFailures(map, onFail);
    map.fire('error', { error: { status: 404, message: 'no style' } });
    expect(onFail).toHaveBeenCalledTimes(1);
  });

  it('takes a missing tile once others have drawn as just that', () => {
    const map = fakeMap();
    const onFail = vi.fn();
    watchFailures(map, onFail);
    map.fire('data', { dataType: 'source', tile: { state: 'loaded' } });
    for (let i = 0; i < 5; i++) map.fire('error', { sourceId: 'carto', tile: {}, error: {} });
    expect(onFail).not.toHaveBeenCalled();
  });
});

describe('fitMercator’s view', () => {
  it('centres and scales a MapLibre map on the canvas, as `project` places points', () => {
    const points = [
      [39.962, -75.24],
      [39.952, -75.165],
      [40.023, -75.077],
    ];
    const fit = fitMercator(points, { maxWidth: 720, maxHeight: 400, margin: 28 });
    const { lat, lon, zoom, width, height } = fit.basemap.view;
    expect([width, height]).toEqual([fit.width, fit.height]);
    // MapLibre puts a point at (its mercator - the centre's) · 512 · 2^zoom
    // from the middle of a `width` x `height` map.
    const c = mercator(lat, lon);
    for (const [plat, plon] of points) {
      const m = mercator(plat, plon);
      const p = fit.project(plat, plon);
      expect(width / 2 + (m.x - c.x) * 512 * 2 ** zoom).toBeCloseTo(p.x, 6);
      expect(height / 2 + (m.y - c.y) * 512 * 2 ** zoom).toBeCloseTo(p.y, 6);
    }
  });
});

describe('a line map on the vector map', () => {
  it('shows the picture of its area, asked for at its size with the key', async () => {
    act(() => resetSource('', 'abc', true));
    const { container } = lineMap();
    await waitFor(() =>
      expect(container.querySelector('img[src="blob:vector/picture"]')).not.toBeNull(),
    );
    expect(drawn.pictures).toHaveLength(1);
    const [asked] = drawn.pictures;
    expect(asked.key).toBe('abc');
    expect(asked.width).toBeGreaterThan(100);
    expect(asked.lat).toBeGreaterThan(39.9);
    expect(asked.lon).toBeLessThan(-75);
    // No raster tiles alongside it.
    expect(container.querySelector('img[src*="cartocdn"]')).toBeNull();
  });

  it("goes to CARTO's raster tiles when the vector map can't be had", async () => {
    drawn.picture = async () => {
      throw Object.assign(new Error('refused'), { kind: 'fetch' });
    };
    act(() => resetSource('', 'abc', true));
    const { container } = lineMap();
    await waitFor(() => expect(activeSource().vector).toBeNull());
    await waitFor(() =>
      expect(
        container.querySelectorAll('img[src*="basemaps.cartocdn.com/dark_all/"]').length,
      ).toBeGreaterThan(1),
    );
  });
});

describe('an interactive map on the vector map', () => {
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
  const rasterTiles = (container) => container.querySelectorAll('img.leaflet-tile');

  it('lays the vector layer under its lines, with the key, and no raster tiles', async () => {
    act(() => resetSource('', 'abc', true));
    const { container } = map();
    await waitFor(() => expect(drawn.layers).toHaveLength(1));
    expect(drawn.layers[0].key).toBe('abc');
    await waitFor(() => expect(drawn.layers[0].layer._map).toBeTruthy());
    expect(rasterTiles(container)).toHaveLength(0);
    // The lines are still drawn.
    expect(container.querySelectorAll('.leaflet-overlay-pane path').length).toBeGreaterThan(0);
  });

  it("goes to CARTO's raster tiles when the vector layer fails", async () => {
    act(() => resetSource('', 'abc', true));
    const { container } = map();
    await waitFor(() => expect(drawn.layers[0]?.layer._map).toBeTruthy());
    act(() => drawn.layers[0].layer.fail({ status: 403 }));
    expect(activeSource().vector).toBeNull();
    await waitFor(() => expect(rasterTiles(container).length).toBeGreaterThan(0));
    expect(rasterTiles(container)[0].getAttribute('src')).toContain('/dark_all/');
    expect(drawn.layers[0].layer._map).toBeFalsy();
  });
});
