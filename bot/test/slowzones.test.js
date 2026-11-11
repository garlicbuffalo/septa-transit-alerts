import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { easternToEpoch } from '../../collector/lib/time.js';
import {
  buildSlowZones,
  composeSlowZones,
  composeSpeedChanges,
  onePerRoute,
  postSlowZones,
  publishSlowZones,
  routeSlowZones,
  SLOW_ZONES_FILE,
  speedChanges,
  stretchName,
} from '../features/slowzones.js';
import { MPH_PER_MPS } from '../features/speedmaps.js';
import { measureShape } from '../lib/geo.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import { testPoster } from './helpers.js';

const MIN = 60_000;
// Sunday, Oct 11, 2026, 11:10 AM in Philadelphia: the week is Oct 4–10.
const SUNDAY = easternToEpoch(2026, 10, 11, 11, 10);
const WEEK = Array.from({ length: 7 }, (_, i) => `2026-10-${String(4 + i).padStart(2, '0')}`);
// About 11 km north to south: 28 stretches of about 400 m.
const LINE = [
  [40.05, -75.17],
  [39.95, -75.17],
];
const LENGTH = measureShape(LINE).length;
const BINS = 28;
const BIN_M = LENGTH / BINS;

/** A route's shapes and stops, as the bot's RouteShapes gives them. */
function shapesFor(routes) {
  return {
    directions: (route) => (routes.includes(route) ? [['0', LINE]] : []),
    stops: (route, dir) =>
      routes.includes(route) && dir === '0'
        ? Array.from({ length: 12 }, (_, i) => [
            40.05 - (i * 0.1) / 11,
            -75.17,
            `Broad St & ${i + 1}th St - FS`,
          ])
        : [],
  };
}

/** A week of tallies for a route: `mph` everywhere, but `slow` mph in stretches `at`. */
function seedRoute(
  db,
  route,
  { mph = 12, slow = 3, at = [10, 11], mode = 'bus', days = WEEK, n = 30 } = {},
) {
  db.prepare(
    "INSERT OR REPLACE INTO speed_dirs (mode, route, text, dir, len, bin_m, ts) VALUES (?, ?, 'SouthBound', '0', ?, ?, 0)",
  ).run(mode, route, LENGTH, BIN_M);
  for (const day of days) {
    for (let bin = 0; bin < BINS; bin++) {
      const v = at.includes(bin) ? slow : mph;
      const dt = n * MIN;
      db.prepare(
        'INSERT INTO speed_bins (day, mode, route, dir, bin, dist, dt, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(day, mode, route, '0', bin, (v / MPH_PER_MPS) * (dt / 1000), dt, n);
    }
  }
}

describe("a stretch's name", () => {
  it('reads along one street, or from stop to stop', () => {
    expect(stretchName('Chestnut St & 17th St - FS', 'Chestnut St & 12th St')).toBe(
      'Chestnut St, 17th St to 12th St',
    );
    expect(stretchName('Market St & 15th St', 'Chestnut St & 12th St')).toBe(
      'Market St & 15th St to Chestnut St & 12th St',
    );
    expect(stretchName('Olney Transit Center', 'Olney Transit Center')).toBe(
      'near Olney Transit Center',
    );
    expect(stretchName(null, null)).toBeNull();
  });
});

describe("a route's slow zone", () => {
  const direction = (mph, n = mph.map(() => 30)) => ({
    id: '0',
    label: 'Southbound',
    avg_mph: 10,
    bin_m: BIN_M,
    mph,
    n,
    shape: LINE,
  });
  const file = (mph, n) => ({ mode: 'bus', route: '23', directions: [direction(mph, n)] });

  it('is the slowest two stretches in a row, timed as one', () => {
    const mph = Array(BINS).fill(12);
    mph[10] = 2;
    mph[11] = 6;
    // One slow stretch on its own, between fast ones, is no slower than this pair.
    mph[20] = 2.5;
    const [zone] = routeSlowZones(file(mph));
    // 800 m at 2 and 6 mph: twice the distance over the two times.
    expect(zone.mph).toBe(3);
    expect(zone.readings).toBe(60);
    expect(zone.length_m).toBe(Math.round(2 * BIN_M));
    expect(zone.points[0][0]).toBeCloseTo(40.05 - (10 / BINS) * 0.1, 3);
    expect(zone).toMatchObject({ mode: 'bus', route: '23', direction: 'Southbound', name: null });
  });

  it('leaves out the layovers at the ends, stretches without data, and thin ones', () => {
    const mph = Array(BINS).fill(12);
    mph[0] = 1; // the terminal
    mph[14] = null;
    mph[15] = 1; // beside a stretch with no data on one side…
    mph[16] = null; // …and on the other
    const [zone] = routeSlowZones(file(mph));
    expect(zone.mph).toBe(12);
    const thin = Array(BINS).fill(12);
    thin[10] = 2;
    thin[11] = 2;
    const n = thin.map((_, i) => (i === 10 || i === 11 ? 5 : 30));
    expect(routeSlowZones(file(thin, n))[0].mph).toBe(12);
  });

  it('is named for the stops at its ends', () => {
    const mph = Array(BINS).fill(12);
    mph[10] = 3;
    mph[11] = 3;
    const [zone] = routeSlowZones(file(mph), shapesFor(['23']));
    expect(zone.name).toBe('Broad St, 5th St to 6th St');
  });
});

describe('the slow-zones file', () => {
  it("holds each mode's slowest zones, slowest first", async () => {
    const { db } = testPoster();
    const shapes = shapesFor(['21', '47', 't2']);
    seedRoute(db, '21', { slow: 4 });
    seedRoute(db, '47', { slow: 2.5 });
    seedRoute(db, 't2', { slow: 5, mode: 'metro' });
    const now = easternToEpoch(2026, 10, 10, 23);
    const file = buildSlowZones(db, { shapes, now });
    expect(file).toMatchObject({ schema_version: 1, from_day: '2026-10-04', to_day: '2026-10-10' });
    expect(file.zones.map((z) => [z.mode, z.route, z.mph])).toEqual([
      ['bus', '47', 2.5],
      ['bus', '21', 4],
      ['metro', 't2', 5],
    ]);
    const dataDir = await mkdtemp(join(tmpdir(), 'septa-slow-'));
    expect(await publishSlowZones(db, { dataDir, shapes, now })).toEqual({ zones: 3 });
    const written = JSON.parse(await readFile(join(dataDir, SLOW_ZONES_FILE), 'utf8'));
    expect(written.zones[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it("isn't written without zones", async () => {
    const { db } = testPoster();
    const dataDir = await mkdtemp(join(tmpdir(), 'septa-slow-'));
    expect(await publishSlowZones(db, { dataDir, shapes: shapesFor([]), now: SUNDAY })).toEqual({
      zones: 0,
    });
  });
});

describe('week over week', () => {
  const current = [
    { route: '1', value: 8.6 },
    { route: '2', value: 9.0 },
    { route: '3', value: 10.2 },
    { route: '4', value: 7 },
  ];
  const previous = new Map([
    ['1', 9.8],
    ['2', 8.1],
    ['3', 10.0],
  ]);

  it('finds the routes that slowed and sped up most', () => {
    const { slower, faster } = speedChanges(current, previous);
    expect(slower.map((m) => m.route)).toEqual(['1']);
    expect(faster.map((m) => m.route)).toEqual(['2']);
  });

  it('says so in a reply, or nothing when no route moved', () => {
    expect(composeSpeedChanges('bus', speedChanges(current, previous))).toBe(
      'Average speed by route, against the week before:\n📉 Route 1: 9.8 → 8.6 mph\n📈 Route 2: 8.1 → 9.0 mph',
    );
    expect(composeSpeedChanges('bus', speedChanges(current, new Map()))).toBeNull();
  });
});

describe('the weekly post', () => {
  const routes = ['21', '47', '17', '33', '2', '9'];

  it('lists the slowest stretch of each route, within a post', () => {
    const zones = routes.map((route, i) => ({
      mode: 'bus',
      route,
      mph: 3 + i,
      direction: 'Southbound',
      name: 'Chestnut St, 17th St to 12th St',
      points: LINE,
    }));
    const { text, facets, alt } = composeSlowZones('bus', zones, { label: 'Oct 4 – Oct 10' });
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(text).toContain('🐢 Slowest bus stretches · Oct 4 – Oct 10');
    expect(text).toContain('1. Route 21 · Chestnut St, 17th St to 12th St — 3.0 mph');
    expect(facets[0].features[0].uri).toMatch(/\/map\?layer=slow$/);
    expect(alt).toContain('1. Route 21, Chestnut St, 17th St to 12th St, 3.0 mph');
    expect(onePerRoute([...zones, { ...zones[0], mph: 9 }])).toHaveLength(6);
  });

  it('posts a map once a week, and the changes as a reply', async () => {
    const { db, poster, client } = testPoster();
    const shapes = shapesFor(routes);
    routes.forEach((route, i) => {
      seedRoute(db, route, { slow: 2 + i, mph: 10 + i });
    });
    // The week before, Route 21 ran much faster and Route 9 much slower.
    db.prepare('INSERT INTO scorecard_weeks (week_to, account, data, ts) VALUES (?, ?, ?, 0)').run(
      '2026-10-03',
      'bus',
      JSON.stringify({
        from: '2026-09-27',
        to: '2026-10-03',
        ranked: 2,
        entries: [
          { route: '21', measures: { speed: 14 } },
          { route: '9', measures: { speed: 9 } },
        ],
      }),
    );
    const res = await postSlowZones({
      db,
      poster,
      shapes,
      basemap: createBasemap(),
      account: 'bus',
      now: SUNDAY,
    });
    expect(res).toMatchObject({ posted: 6, changes: 2 });
    expect(client.posts).toHaveLength(2);
    const [post, reply] = client.posts;
    expect(post.account).toBe('bus');
    expect(post.opts.text).toContain('1. Route 21 · Broad St, 5th St to 6th St — 2.0 mph');
    const meta = await sharp(post.opts.image.data).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 1200]);
    expect(reply.opts.reply.root.uri).toBe(post.uri);
    expect(reply.opts.text).toContain('📉 Route 21: 14.0 →');
    expect(reply.opts.text).toContain('📈 Route 9: 9.0 →');
    expect(
      await postSlowZones({
        db,
        poster,
        shapes,
        basemap: createBasemap(),
        account: 'bus',
        now: SUNDAY + MIN,
      }),
    ).toEqual({ skipped: 'posted' });
  });

  it('stays quiet with too little data', async () => {
    const { db, poster, client } = testPoster();
    seedRoute(db, '21');
    const res = await postSlowZones({
      db,
      poster,
      shapes: shapesFor(['21']),
      basemap: createBasemap(),
      account: 'bus',
      now: SUNDAY,
    });
    expect(res).toEqual({ skipped: 'too-little-data', zones: 1 });
    expect(client.posts).toHaveLength(0);
  });
});
