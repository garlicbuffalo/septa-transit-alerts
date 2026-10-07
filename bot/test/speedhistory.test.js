import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RouteShapes } from '../../collector/lib/shapes.js';
import {
  assignDirections,
  buildSpeedFiles,
  HISTORY,
  maybePublishSpeeds,
  publishSpeeds,
  rollupSpeeds,
  stretchesFor,
} from '../features/speedhistory.js';
import { openDb, pruneDb } from '../lib/db.js';
import { measureShape } from '../lib/geo.js';
import { recordObservations } from '../lib/observations.js';
import { NOW, vehicle } from './helpers.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// 10 mph is 268 m a minute, 0.00241° of latitude.
const DEG_PER_MIN_AT_10MPH = 268.2 / 111_320;
const SOUTH = [
  [40.05, -75.17],
  [39.95, -75.17],
];
const NORTH = [...SOUTH].reverse();
const shapesFor = (routes = { 23: { 0: SOUTH, 1: NORTH } }) =>
  new RouteShapes({ version: 1, built_at: NOW, routes });

/**
 * Vehicles going south at `mph`, one report a minute, from `start`. Each
 * stretch needs a few readings to show, so a few follow the same path.
 */
function drive(
  db,
  { id = 'v', route = '23', mode = 'bus', mph, minutes, start, from = 40.04, vehicles = 4 },
) {
  for (let m = 0; m <= minutes; m++) {
    const t = start + m * MIN;
    recordObservations(db, t, {
      vehicles: Array.from({ length: vehicles }, (_, i) =>
        vehicle({
          id: `${id}${i}`,
          label: `${id}${i}`,
          mode,
          route,
          lat: from - (m * DEG_PER_MIN_AT_10MPH * mph) / 10,
          lon: -75.17,
          directionName: 'SouthBound',
          reportTs: t,
        }),
      ),
    });
  }
}

const eligibleSpeeds = (direction) => direction.mph.filter((v) => v != null);

describe('assignDirections', () => {
  const directions = [
    { id: '0', measured: measureShape(SOUTH) },
    {
      id: '1',
      measured: measureShape([
        [40.05, -75.18],
        [39.95, -75.18],
      ]),
    },
  ];
  const along = (lon) => Array.from({ length: 20 }, (_, i) => ({ lat: 40.04 - i * 0.004, lon }));

  it('gives each direction text the shape it runs along', () => {
    const got = assignDirections(
      new Map([
        ['SouthBound', along(-75.17)],
        ['NorthBound', along(-75.18)],
      ]),
      directions,
    );
    expect(got.get('SouthBound')).toBe('0');
    expect(got.get('NorthBound')).toBe('1');
  });

  it('keeps two directions off one shape when both run along the same streets', () => {
    const same = [
      { id: '0', measured: measureShape(SOUTH) },
      { id: '1', measured: measureShape(NORTH) },
    ];
    const got = assignDirections(
      new Map([
        ['SouthBound', along(-75.17)],
        ['NorthBound', along(-75.17)],
      ]),
      same,
    );
    expect(new Set(got.values()).size).toBe(2);
  });

  it('avoids a shape another direction already follows', () => {
    const got = assignDirections(
      new Map([['NorthBound', along(-75.17)]]),
      directions,
      new Set(['0']),
    );
    expect(got.get('NorthBound')).toBe('1');
  });
});

describe('stretchesFor', () => {
  it('cuts a route into stretches of about 400 m, between 20 and 80', () => {
    expect(stretchesFor(12_000).count).toBe(30);
    expect(stretchesFor(2_000).count).toBe(20);
    expect(stretchesFor(60_000).count).toBe(80);
    expect(stretchesFor(12_000).binM).toBeCloseTo(400);
  });
});

describe('the week of speeds', () => {
  it('averages a vehicle’s speed along each stretch of its direction', async () => {
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    const shapes = shapesFor();
    await rollupSpeeds(db, { shapes, now: NOW });
    const files = buildSpeedFiles(db, { shapes, now: NOW });
    const file = files.get('bus|23');
    expect(file.directions).toHaveLength(1);
    const [south] = file.directions;
    expect(south.label).toBe('Southbound');
    expect(south.avg_mph).toBeCloseTo(10, 0);
    for (const v of eligibleSpeeds(south)) expect(v).toBeCloseTo(10, 0);
    expect(south.shape.length).toBe(2);
    expect(south.mph).toHaveLength(Math.ceil(measureShape(south.shape).length / south.bin_m));
    // Layover at the ends isn't traffic.
    expect(south.mph[0]).toBeNull();
    expect(south.coverage).toBeGreaterThan(0.5);
  });

  it('counts every reading once, however often it runs', async () => {
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    const shapes = shapesFor();
    // Stop partway, then carry on: the run boundary falls mid-trip.
    await rollupSpeeds(db, { shapes, now: NOW - 25 * MIN });
    await rollupSpeeds(db, { shapes, now: NOW - 25 * MIN });
    await rollupSpeeds(db, { shapes, now: NOW - 10 * MIN });
    await rollupSpeeds(db, { shapes, now: NOW });
    await rollupSpeeds(db, { shapes, now: NOW });
    const twice = buildSpeedFiles(db, { shapes, now: NOW }).get('bus|23').directions[0];

    const once = openDb(':memory:');
    drive(once, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    await rollupSpeeds(once, { shapes, now: NOW });
    const base = buildSpeedFiles(once, { shapes, now: NOW }).get('bus|23').directions[0];
    expect(twice.readings).toBe(base.readings);
    expect(twice.n).toEqual(base.n);
  });

  it('weighs speeds by time across days, and leaves out days past the week', async () => {
    const db = openDb(':memory:');
    drive(db, { id: 'a', mph: 10, minutes: 30, start: NOW - 3 * DAY });
    drive(db, { id: 'b', mph: 20, minutes: 15, start: NOW - 2 * DAY });
    drive(db, { id: 'old', mph: 40, minutes: 8, start: NOW - 9 * DAY });
    const shapes = shapesFor();
    await rollupSpeeds(db, { shapes, now: NOW });
    const file = buildSpeedFiles(db, { shapes, now: NOW }).get('bus|23');
    // Equal distances at 10 and 20 mph: 2d / (d/10 + d/20) ≈ 13.3.
    expect(Math.abs(file.directions[0].avg_mph - 13.3)).toBeLessThan(1);
    expect(file.days_with_data).toBe(2);
    expect(file.window_days).toBe(7);
    expect(file.from_day < file.to_day).toBe(true);
  });

  it('keeps a stretch off the map until it has a few readings', async () => {
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    const shapes = shapesFor();
    await rollupSpeeds(db, { shapes, now: NOW });
    const [south] = buildSpeedFiles(db, { shapes, now: NOW }).get('bus|23').directions;
    south.n.forEach((n, i) => {
      if (n < HISTORY.minReadings) expect(south.mph[i]).toBeNull();
      else expect(south.mph[i]).not.toBeNull();
    });
  });

  it('keeps each direction on its own shape', async () => {
    const db = openDb(':memory:');
    const shapes = shapesFor({
      7: {
        0: SOUTH,
        1: [
          [39.95, -75.19],
          [40.05, -75.19],
        ],
      },
    });
    drive(db, { route: '7', mph: 10, minutes: 30, start: NOW - 40 * MIN });
    for (let m = 0; m <= 30; m++) {
      const t = NOW - 40 * MIN + m * MIN;
      recordObservations(db, t, {
        vehicles: ['n1', 'n2', 'n3', 'n4'].map((id) =>
          vehicle({
            id,
            label: id,
            route: '7',
            lat: 39.96 + m * DEG_PER_MIN_AT_10MPH * 2,
            lon: -75.19,
            directionName: 'NorthBound',
            reportTs: t,
          }),
        ),
      });
    }
    await rollupSpeeds(db, { shapes, now: NOW });
    const dirs = buildSpeedFiles(db, { shapes, now: NOW }).get('bus|7').directions;
    expect(dirs.map((d) => d.label)).toEqual(['Southbound', 'Northbound']);
    expect(dirs[0].avg_mph).toBeCloseTo(10, 0);
    expect(dirs[1].avg_mph).toBeCloseTo(20, 0);
  });

  it('only maps Metro lines, and bus routes with a shape', async () => {
    const db = openDb(':memory:');
    drive(db, { route: 'm1', mode: 'metro', mph: 10, minutes: 30, start: NOW - 40 * MIN });
    drive(db, { route: 'zzz', mph: 10, minutes: 30, start: NOW - 40 * MIN });
    drive(db, { route: 'not-a-line', mode: 'metro', mph: 10, minutes: 30, start: NOW - 40 * MIN });
    const shapes = shapesFor({
      m1: { 0: SOUTH },
      'not-a-line': { 0: SOUTH },
    });
    await rollupSpeeds(db, { shapes, now: NOW });
    expect([...buildSpeedFiles(db, { shapes, now: NOW }).keys()]).toEqual(['metro|m1']);
  });

  it('starts a direction’s tallies over when its shape changes length', async () => {
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    await rollupSpeeds(db, { shapes: shapesFor(), now: NOW });
    const longer = shapesFor({
      23: {
        0: [
          [40.05, -75.17],
          [39.9, -75.17],
        ],
      },
    });
    drive(db, { mph: 20, minutes: 15, start: NOW + 10 * MIN });
    await rollupSpeeds(db, { shapes: longer, now: NOW + 30 * MIN });
    const [south] = buildSpeedFiles(db, { shapes: longer, now: NOW + 30 * MIN }).get(
      'bus|23',
    ).directions;
    expect(south.avg_mph).toBeCloseTo(20, 0);
  });

  it('leaves out a route with data for too little of it', async () => {
    const db = openDb(':memory:');
    // Five minutes of one vehicle: a sliver of the route.
    drive(db, { mph: 10, minutes: 5, start: NOW - 10 * MIN });
    const shapes = shapesFor();
    await rollupSpeeds(db, { shapes, now: NOW });
    expect(buildSpeedFiles(db, { shapes, now: NOW }).size).toBe(0);
  });

  it('does nothing without shapes', async () => {
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    expect(await rollupSpeeds(db, { shapes: null, now: NOW })).toEqual({ skipped: 'no-shapes' });
  });
});

describe('publishing the speed files', () => {
  it('writes one file per route, drops the stale ones, and waits an hour between', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'speeds-'));
    const db = openDb(':memory:');
    drive(db, { mph: 10, minutes: 30, start: NOW - 40 * MIN });
    const shapes = shapesFor();
    await rollupSpeeds(db, { shapes, now: NOW });
    await publishSpeeds(db, { dataDir, shapes, now: NOW });
    expect(await readdir(join(dataDir, 'speeds'))).toEqual(['23.json']);
    const file = JSON.parse(await readFile(join(dataDir, 'speeds', '23.json'), 'utf8'));
    expect(file).toMatchObject({ schema_version: 1, mode: 'bus', route: '23', generated_at: NOW });

    await writeFile(join(dataDir, 'speeds', 'stale.json'), '{}');
    expect(await maybePublishSpeeds(db, { dataDir, shapes, now: NOW + 30 * MIN })).toEqual({
      skipped: 'recent',
    });
    expect(await readdir(join(dataDir, 'speeds'))).toContain('stale.json');
    await maybePublishSpeeds(db, { dataDir, shapes, now: NOW + 61 * MIN });
    expect(await readdir(join(dataDir, 'speeds'))).toEqual(['23.json']);
  });
});

describe('the database', () => {
  it('prunes tallies past the week, with a margin', () => {
    const db = openDb(':memory:');
    const put = db.prepare("INSERT INTO speed_bins VALUES (?, 'bus', '23', '0', 0, 1, 1, 1)");
    put.run('2026-09-01');
    put.run('2026-10-02');
    pruneDb(db, NOW, { observationRetentionDays: 3 });
    expect(db.prepare('SELECT day FROM speed_bins').all()).toEqual([{ day: '2026-10-02' }]);
  });
});
