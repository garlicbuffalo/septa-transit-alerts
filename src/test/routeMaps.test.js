import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRouteMap,
  buildSpeedMap,
  loadRouteShapes,
  loadRouteSpeeds,
  loadSystemMapShapes,
  measure,
  railStopsOf,
  SPEEDS_STALE_MS,
  sliceAlong,
  speedWindowLabel,
  stopsOf,
  summarizeSpeeds,
} from '../lib/routeMaps.js';
import { bandFor, SPEED_BANDS } from '../lib/speedBands.js';

const NOW = 1_791_300_000_000;
// 1° of latitude is 111.32 km.
const LINE = [
  [40.0, -75.17],
  [40.01, -75.17],
  [40.02, -75.17],
];

function speedFile(over = {}) {
  return {
    schema_version: 1,
    mode: 'bus',
    route: '17',
    generated_at: NOW - 60_000,
    window_days: 7,
    from_day: '2026-09-30',
    to_day: '2026-10-06',
    days_with_data: 7,
    directions: [
      {
        id: '0',
        label: 'Southbound',
        avg_mph: 9.1,
        coverage: 0.75,
        readings: 400,
        bin_m: 556.6,
        // 2.2 km: four stretches, one of them without data.
        mph: [3.2, null, 12, 22],
        n: [30, 1, 40, 50],
        shape: LINE,
      },
    ],
    ...over,
  };
}

function respond(body, { ok = true } = {}) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body });
}

afterEach(() => vi.unstubAllGlobals());

describe('measure and sliceAlong', () => {
  it('measures a line in meters', () => {
    expect(measure(LINE).length).toBeCloseTo(2226.4, -1);
  });

  it('cuts the part between two distances, keeping the vertices inside it', () => {
    const m = measure(LINE);
    const part = sliceAlong(m, 500, 1500);
    expect(part).toHaveLength(3);
    expect(part[0][0]).toBeCloseTo(40.0 + 500 / 111_320, 4);
    expect(part[1]).toEqual(LINE[1]);
    expect(part[2][0]).toBeCloseTo(40.0 + 1500 / 111_320, 4);
  });
});

describe('speed bands', () => {
  it('picks the band a speed falls in', () => {
    const colors = [3, 7, 12, 40].map((mph) => bandFor(SPEED_BANDS.road, mph).label);
    expect(colors).toEqual(['under 5 mph', '5–10', '10–15', '15+ mph']);
  });
});

describe('buildSpeedMap', () => {
  it('colors each stretch with data by its band, and leaves the rest to the base line', () => {
    const map = buildSpeedMap(speedFile().directions[0]);
    expect(map.stretches.map((s) => [s.index, s.mph, s.color])).toEqual([
      [0, 3.2, SPEED_BANDS.road[0].color],
      [2, 12, SPEED_BANDS.road[2].color],
      [3, 22, SPEED_BANDS.road[3].color],
    ]);
    expect(map.stretches[0].readings).toBe(30);
    expect(map.base).toEqual(LINE);
    expect(map.fit).toEqual(LINE);
  });

  it('puts each stretch along the route, one after another', () => {
    const map = buildSpeedMap(speedFile().directions[0]);
    // The route runs north along one meridian; the first stretch is its first 556.6 m.
    const [first, third] = [map.stretches[0], map.stretches[1]];
    expect(first.points[0]).toEqual([40.0, -75.17]);
    expect(first.points.at(-1)[0]).toBeCloseTo(40.0 + 556.6 / 111_320, 4);
    expect(third.points[0][0]).toBeCloseTo(40.0 + (2 * 556.6) / 111_320, 4);
    for (const s of map.stretches) {
      for (const [lat, lon] of s.points) {
        expect(lat).toBeGreaterThanOrEqual(40.0);
        expect(lat).toBeLessThanOrEqual(40.02);
        expect(lon).toBeCloseTo(-75.17, 6);
      }
    }
  });

  it('has no map without a line', () => {
    expect(buildSpeedMap({ shape: [], mph: [], n: [], bin_m: 100 })).toBeNull();
  });
});

describe('summarizeSpeeds', () => {
  it('gives the average and the slowest and fastest stretch shown', () => {
    expect(summarizeSpeeds(speedFile().directions[0])).toEqual({
      avgMph: 9.1,
      slowestMph: 3.2,
      fastestMph: 22,
      slowCount: 1,
      shownCount: 3,
      readings: 400,
    });
  });

  it('counts the stretches under the slowest band of the bands it’s given', () => {
    expect(summarizeSpeeds(speedFile().directions[0], SPEED_BANDS.rail).slowCount).toBe(2);
  });

  it('has nothing for a direction with no stretches', () => {
    expect(summarizeSpeeds({ mph: [null, null], avg_mph: 0, readings: 0 })).toBeNull();
  });
});

describe('buildRouteMap', () => {
  it('draws each direction and marks the ends once', () => {
    const map = buildRouteMap({ 0: LINE, 1: [...LINE].reverse() });
    expect(map.lines.map((l) => l.id)).toEqual(['0', '1']);
    expect(map.ends).toEqual([LINE[0], LINE[2]]);
    expect(map.fit).toHaveLength(6);
  });

  it('has no map without a line', () => {
    expect(buildRouteMap({})).toBeNull();
    expect(buildRouteMap({ 0: [[40, -75]] })).toBeNull();
  });
});

describe('stopsOf', () => {
  const file = {
    stops: {
      0: [
        [39.95, -75.17, 'Front St & Market St'],
        [39.96, -75.17, '20th St & Johnston St'],
      ],
      1: [
        [39.96, -75.17, '20th St & Johnston St'],
        [39.9501, -75.1702, 'Front St & Market St'],
      ],
    },
  };

  it('lists one direction’s stops in order', () => {
    expect(stopsOf(file, '1').map((s) => s.name)).toEqual([
      '20th St & Johnston St',
      'Front St & Market St',
    ]);
    expect(stopsOf(file, 0)[0]).toEqual({
      id: '0:0',
      point: [39.95, -75.17],
      name: 'Front St & Market St',
    });
  });

  it('lists every direction’s stops once each when no direction is given', () => {
    // 20th St appears in both directions at the same spot; the other side of
    // Front St, 20 m along, is its own stop.
    expect(stopsOf(file).map((s) => s.name)).toEqual([
      'Front St & Market St',
      '20th St & Johnston St',
      'Front St & Market St',
    ]);
  });

  it('has none for a file without stops', () => {
    expect(stopsOf({ directions: {} })).toEqual([]);
    expect(stopsOf(null)).toEqual([]);
  });
});

describe('railStopsOf', () => {
  it('lists a line’s stations from the bundled data', () => {
    const stops = railStopsOf('pao');
    expect(stops.length).toBeGreaterThan(10);
    for (const s of stops) {
      expect(s.name).toBeTruthy();
      expect(s.point[0]).toBeGreaterThan(39);
      expect(s.point[1]).toBeLessThan(-75);
    }
    expect(railStopsOf('nope')).toEqual([]);
  });
});

describe('speedWindowLabel', () => {
  it('names the days the speeds cover', () => {
    expect(speedWindowLabel(speedFile())).toBe('Sep 30 – Oct 6');
    expect(speedWindowLabel({ from_day: '2026-10-06', to_day: '2026-10-06' })).toBe('Oct 6');
  });
});

describe('loading the files', () => {
  it('reads a route’s speeds from speeds/<route>.json', async () => {
    const fetchFn = respond(speedFile());
    vi.stubGlobal('fetch', fetchFn);
    const file = await loadRouteSpeeds('L1-OWL', { now: NOW });
    expect(file.directions).toHaveLength(1);
    expect(fetchFn.mock.calls[0][0]).toMatch(/speeds\/L1-OWL\.json$/);
  });

  it.each([
    ['a missing file', () => respond(null, { ok: false })],
    [
      'a page that isn’t JSON',
      () =>
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => {
            throw new Error('html');
          },
        }),
    ],
    ['a network error', () => vi.fn().mockRejectedValue(new Error('offline'))],
    ['a newer file format', () => respond(speedFile({ schema_version: 2 }))],
    ['a file with no directions', () => respond(speedFile({ directions: [] }))],
  ])('has no speeds for %s', async (_, make) => {
    vi.stubGlobal('fetch', make());
    expect(await loadRouteSpeeds('17', { now: NOW })).toBeNull();
  });

  it('reads a Regional Rail line’s speeds from speeds/rail/<line>.json', async () => {
    const fetchFn = respond(speedFile({ mode: 'regional_rail', route: 'pao' }));
    vi.stubGlobal('fetch', fetchFn);
    expect(await loadRouteSpeeds('pao', { rail: true, now: NOW })).not.toBeNull();
    expect(fetchFn.mock.calls[0][0]).toMatch(/speeds\/rail\/pao\.json$/);
  });

  it('has no speeds from a server that has gone quiet', async () => {
    vi.stubGlobal('fetch', respond(speedFile({ generated_at: NOW - SPEEDS_STALE_MS - 1 })));
    expect(await loadRouteSpeeds('17', { now: NOW })).toBeNull();
  });

  it('reads every bus route’s lines from system-map.json', async () => {
    const file = { schema_version: 1, generated_at: NOW, routes: { 17: [LINE], K: [LINE] } };
    const fetchFn = respond(file);
    vi.stubGlobal('fetch', fetchFn);
    expect((await loadSystemMapShapes()).routes[17]).toEqual([LINE]);
    expect(fetchFn.mock.calls[0][0]).toMatch(/\/system-map\.json$/);
  });

  it('has no system map shapes when the file is missing, empty, or in another format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    expect(await loadSystemMapShapes()).toBeNull();
    vi.stubGlobal('fetch', respond({ schema_version: 1, routes: {} }));
    expect(await loadSystemMapShapes()).toBeNull();
    vi.stubGlobal('fetch', respond({ schema_version: 2, routes: { 17: [LINE] } }));
    expect(await loadSystemMapShapes()).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await loadSystemMapShapes()).toBeNull();
  });

  it('reads a route’s shapes from shapes/<route>.json', async () => {
    const fetchFn = respond({ schema_version: 1, route: '17', directions: { 0: LINE } });
    vi.stubGlobal('fetch', fetchFn);
    expect((await loadRouteShapes('17')).directions[0]).toEqual(LINE);
    expect(fetchFn.mock.calls[0][0]).toMatch(/shapes\/17\.json$/);
    vi.stubGlobal('fetch', respond({ schema_version: 1, route: '17', directions: {} }));
    expect(await loadRouteShapes('17')).toBeNull();
  });
});
