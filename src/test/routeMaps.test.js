import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRouteMap,
  buildSpeedMap,
  loadRouteShapes,
  loadRouteSpeeds,
  measure,
  SPEEDS_STALE_MS,
  sliceAlong,
  speedWindowLabel,
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
    expect(map.base).toMatch(/^M/);
    expect(map.basemap.tiles.length).toBeGreaterThan(0);
  });

  it('keeps every stretch inside the map', () => {
    const map = buildSpeedMap(speedFile().directions[0]);
    for (const s of map.stretches) {
      for (const [x, y] of s.d
        .slice(1)
        .split('L')
        .map((p) => p.split(',').map(Number))) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(map.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(map.height);
      }
    }
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

  it('has nothing for a direction with no stretches', () => {
    expect(summarizeSpeeds({ mph: [null, null], avg_mph: 0, readings: 0 })).toBeNull();
  });
});

describe('buildRouteMap', () => {
  it('draws each direction and marks the ends once', () => {
    const map = buildRouteMap({ 0: LINE, 1: [...LINE].reverse() });
    expect(map.paths).toHaveLength(2);
    expect(map.ends).toHaveLength(2);
  });

  it('has no map without a line', () => {
    expect(buildRouteMap({})).toBeNull();
    expect(buildRouteMap({ 0: [[40, -75]] })).toBeNull();
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

  it('has no speeds from a server that has gone quiet', async () => {
    vi.stubGlobal('fetch', respond(speedFile({ generated_at: NOW - SPEEDS_STALE_MS - 1 })));
    expect(await loadRouteSpeeds('17', { now: NOW })).toBeNull();
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
