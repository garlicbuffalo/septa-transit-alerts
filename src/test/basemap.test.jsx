import { render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import EventMap from '../components/EventMap.jsx';
import LineMap from '../components/LineMap.jsx';
import MultiLineEventMap from '../components/MultiLineEventMap.jsx';
import {
  activeSource,
  fitMercator,
  mercator,
  noteTileFailed,
  noteTileLoaded,
  resetSource,
  tileOf,
  tileSources,
  tileUrl,
} from '../lib/basemap.js';
import { buildLineMap, buildMultiLineMap } from '../lib/lineMap.js';
import { buildRailLineMap } from '../lib/railLineMap.js';

// The latitude/longitude of a tile's north-west corner, from the inverse of
// the Web Mercator formula (so it checks the tiles against the projection
// rather than repeating it).
function tileCorner(z, x, y) {
  const n = 2 ** z;
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI,
    lon: (x / n) * 360 - 180,
  };
}

const PHILLY = [
  [39.9526, -75.1652],
  [39.9566, -75.1899],
  [40.0231, -75.0775],
];

describe('Web Mercator', () => {
  it('puts the equator and the prime meridian in the middle of the world', () => {
    const m = mercator(0, 0);
    expect(m.x).toBeCloseTo(0.5, 10);
    expect(m.y).toBeCloseTo(0.5, 10);
  });

  it('finds the tile a point is in (Berlin at zoom 12 is 2200/1343)', () => {
    expect(tileOf(52.5163, 13.3777, 12)).toEqual({ x: 2200, y: 1343 });
  });
});

describe('fitMercator', () => {
  const opts = { maxWidth: 720, maxHeight: 320, margin: 40 };

  it('keeps every point inside the margins', () => {
    const fit = fitMercator(PHILLY, opts);
    for (const [lat, lon] of PHILLY) {
      const { x, y } = fit.project(lat, lon);
      expect(x).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(x).toBeLessThanOrEqual(fit.width - 40 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(40 - 1e-6);
      expect(y).toBeLessThanOrEqual(fit.height - 40 + 1e-6);
    }
  });

  it('lays each tile where its corner projects', () => {
    const fit = fitMercator(PHILLY, opts);
    const { z, tiles } = fit.basemap;
    expect(tiles.length).toBeGreaterThan(1);
    for (const t of tiles) {
      const corner = tileCorner(z, t.x, t.y);
      const p = fit.project(corner.lat, corner.lon);
      expect((p.x / fit.width) * 100).toBeCloseTo(t.left, 6);
      expect((p.y / fit.height) * 100).toBeCloseTo(t.top, 6);
    }
  });

  it('covers the whole canvas with tiles', () => {
    const fit = fitMercator(PHILLY, opts);
    const { tiles } = fit.basemap;
    const left = Math.min(...tiles.map((t) => t.left));
    const top = Math.min(...tiles.map((t) => t.top));
    const right = Math.max(...tiles.map((t) => t.left + t.w));
    const bottom = Math.max(...tiles.map((t) => t.top + t.h));
    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(100);
    expect(bottom).toBeGreaterThanOrEqual(100);
  });

  it('picks a zoom whose tiles are a sensible size', () => {
    const { z, tiles } = fitMercator(PHILLY, opts).basemap;
    const tileUnits = (tiles[0].w / 100) * 720;
    expect(z).toBeGreaterThan(8);
    expect(tileUnits).toBeGreaterThan(150);
    expect(tileUnits).toBeLessThan(500);
  });

  it('fills a tall canvas around a narrow line instead of shrinking to it', () => {
    const tall = [
      [39.9, -75.16],
      [40.1, -75.15],
    ];
    const fit = fitMercator(tall, opts);
    expect(fit.width).toBe(720);
    expect(fit.height).toBe(320);
  });

  it('does not run past the world for a single point', () => {
    const fit = fitMercator([[39.95, -75.16]], opts);
    expect(fit.basemap.z).toBeLessThanOrEqual(19);
    expect(Number.isFinite(fit.project(39.95, -75.16).x)).toBe(true);
  });

  it('returns null when there is nothing to fit', () => {
    expect(fitMercator([], opts)).toBeNull();
  });
});

describe('the map builders with a basemap', () => {
  it('leave the flat schematic alone by default', () => {
    const map = buildLineMap('l1', null, { maxWidth: 720, maxHeight: 540 });
    expect(map.basemap).toBeNull();
    expect(map.downtown.basemap ?? null).toBeNull();
  });

  it('project a Metro line onto tiles, with a downtown inset of its own', () => {
    const map = buildLineMap('l1', null, {
      maxWidth: 720,
      maxHeight: 540,
      margin: 40,
      basemap: true,
    });
    expect(map.width).toBe(720);
    expect(map.basemap.tiles.length).toBeGreaterThan(0);
    for (const s of map.stations) {
      expect(s.x).toBeGreaterThanOrEqual(39);
      expect(s.x).toBeLessThanOrEqual(681);
    }
    // The inset has tiles of its own, at least as close as the main map's.
    expect(map.downtown.basemap.tiles.length).toBeGreaterThan(0);
    expect(map.downtown.basemap.z).toBeGreaterThanOrEqual(map.basemap.z);
  });

  it('never rotate: a very tall line keeps north up', () => {
    // B1 is long and nearly vertical, so the flat map turns it sideways.
    const flat = buildLineMap('b1', null, { maxWidth: 720, maxHeight: 540 });
    const tiled = buildLineMap('b1', null, { maxWidth: 720, maxHeight: 540, basemap: true });
    const north = tiled.stations.reduce((a, b) => (a.y < b.y ? a : b));
    const south = tiled.stations.reduce((a, b) => (a.y > b.y ? a : b));
    expect(north.name).toBe('Fern Rock Transit Center');
    expect(south.y).toBeGreaterThan(north.y);
    expect(flat.basemap).toBeNull();
  });

  it('project a Regional Rail line onto tiles', () => {
    const map = buildRailLineMap('pao', null, { basemap: true });
    expect(map.basemap.z).toBeGreaterThan(5);
    expect(map.downtown).toBeNull();
  });

  it('project a multi-line map, cropped to the affected stations', () => {
    const wide = buildMultiLineMap(['b1', 'b2', 'b3'], { basemap: true });
    const crop = buildMultiLineMap(['b1', 'b2', 'b3'], {
      basemap: true,
      cropToStationNames: ['Olney Transit Center', 'Fern Rock Transit Center'],
    });
    expect(wide.basemap.tiles.length).toBeGreaterThan(0);
    expect(crop.basemap.z).toBeGreaterThan(wide.basemap.z);
    expect(buildMultiLineMap(['b1'], {}).basemap).toBeNull();
  });
});

describe('tile sources', () => {
  it('uses CARTO through the relay when one is set, OpenStreetMap behind it', () => {
    const { primary, fallback } = tileSources('https://tracker.example/api/tiles/');
    expect(primary.id).toBe('carto');
    expect(primary.url).toBe('https://tracker.example/api/tiles/{z}/{x}/{y}{r}.png');
    expect(primary.filter).toBeNull();
    expect(primary.credits.map((c) => c.label)).toContain('© CARTO');
    expect(fallback.id).toBe('osm');
    expect(fallback.filter).toContain('invert');
  });

  it('uses darkened OpenStreetMap alone with no relay', () => {
    const { primary, fallback } = tileSources('');
    expect(primary.id).toBe('osm');
    expect(primary.filter).toContain('invert');
    expect(fallback).toBeNull();
  });

  it('asks for @2x tiles on a retina screen only', () => {
    const { primary } = tileSources('https://tracker.example/api/tiles');
    const tile = { x: 1192, y: 1551 };
    expect(tileUrl(primary, tile, 12, false)).toBe(
      'https://tracker.example/api/tiles/12/1192/1551.png',
    );
    expect(tileUrl(primary, tile, 12, true)).toBe(
      'https://tracker.example/api/tiles/12/1192/1551@2x.png',
    );
  });
});

describe('falling back from the relay', () => {
  afterEach(() => resetSource(''));

  it('moves to OpenStreetMap once two tiles fail before any has loaded', () => {
    resetSource('https://tracker.example/api/tiles');
    const carto = activeSource();
    expect(carto.id).toBe('carto');
    noteTileFailed(carto);
    expect(activeSource().id).toBe('carto');
    noteTileFailed(carto);
    expect(activeSource().id).toBe('osm');
  });

  it('stays on CARTO if tiles are loading (a stray 404 is just a missing tile)', () => {
    resetSource('https://tracker.example/api/tiles');
    const carto = activeSource();
    noteTileLoaded();
    noteTileFailed(carto);
    noteTileFailed(carto);
    noteTileFailed(carto);
    expect(activeSource().id).toBe('carto');
  });

  it('has nowhere to go without a relay', () => {
    resetSource('');
    noteTileFailed(activeSource());
    noteTileFailed(activeSource());
    expect(activeSource().id).toBe('osm');
  });

  it('puts the credit and the filter on the maps when it switches', async () => {
    resetSource('https://tracker.example/api/tiles');
    const { container } = render(
      <EventMap lineKey="l1" fromStation="34th St" toStation="15th St/City Hall" />,
    );
    expect(container.querySelector('img').src).toContain('tracker.example/api/tiles/');
    expect(screen.getByText('© CARTO')).toBeInTheDocument();

    const carto = activeSource();
    act(() => {
      noteTileFailed(carto);
      noteTileFailed(carto);
    });
    await waitFor(() =>
      expect(container.querySelector('img').src).toContain('tile.openstreetmap.org'),
    );
    expect(container.querySelector('img').parentElement.style.filter).toContain('invert');
    expect(screen.queryByText('© CARTO')).toBeNull();
  });
});

describe('the maps on tiles', () => {
  // LineMap watches its scroll box's size; jsdom has no ResizeObserver.
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => resetSource(''));

  it('EventMap lays tiles under the line and credits them', () => {
    const { container } = render(
      <EventMap lineKey="l1" fromStation="34th St" toStation="15th St/City Hall" active />,
    );
    expect(container.querySelectorAll('img').length).toBeGreaterThan(1);
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
    // The tiles are decoration; the SVG keeps its name.
    expect(
      screen.getByRole('img', { name: /Affected stretch on the L1 Line/ }),
    ).toBeInTheDocument();
    expect(container.querySelector('img').closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('EventMap works for Regional Rail too', () => {
    const { container } = render(
      <EventMap kind="rail" lineKey="pao" fromStation="Wayne" toStation="Radnor" />,
    );
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('MultiLineEventMap lays tiles under the stretches', () => {
    const { container } = render(
      <MultiLineEventMap
        lineKeys={['b1', 'b2', 'b3']}
        segments={[{ line: null, from: 'Olney Transit Center', to: 'Fern Rock Transit Center' }]}
        active
      />,
    );
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
    expect(screen.getByText('© OpenStreetMap contributors')).toBeInTheDocument();
  });

  it('LineMap lays tiles under both the line and the downtown inset', () => {
    const { container } = render(<LineMap lineKey="l1" stationIndex={new Map()} />);
    const boxes = new Set([...container.querySelectorAll('img')].map((i) => i.parentElement));
    expect(boxes.size).toBe(2);
    // One credit line for the card, not one per map.
    expect(screen.getAllByText('© OpenStreetMap contributors')).toHaveLength(1);
  });
});
