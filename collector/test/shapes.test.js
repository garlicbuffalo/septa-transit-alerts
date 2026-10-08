import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRouteShapes,
  publishRouteShapes,
  publishSystemMap,
  RouteShapes,
  SYSTEM_MAP_FILE,
} from '../lib/shapes.js';

// The corner of a street, a quarter circle with a 60 m radius: the sort of curve a bus loop
// around City Hall is made of. Simplified to 6 m it is three points and 4.7 m off the street;
// to 3 m, five points and 1.7 m off.
const R = 60;
const R_LAT = R / 111_320;
const R_LON = R / (111_320 * Math.cos((39.95 * Math.PI) / 180));
const arc = Array.from({ length: 31 }, (_, i) => {
  const t = (i / 30) * (Math.PI / 2);
  return [39.95 + R_LAT * Math.sin(t), -75.17 + R_LON * (1 - Math.cos(t))];
});
const round5 = (points) =>
  points.map(([lat, lon]) => [Math.round(lat * 1e5) / 1e5, Math.round(lon * 1e5) / 1e5]);
// How far, in meters, the farthest of `points` is from a polyline.
function farthestFrom(points, polyline) {
  const nearest = (p) => {
    const k = Math.cos((p[0] * Math.PI) / 180);
    let best = Infinity;
    for (let i = 1; i < polyline.length; i++) {
      const ax = (polyline[i - 1][1] - p[1]) * 111_320 * k;
      const ay = (polyline[i - 1][0] - p[0]) * 111_320;
      const dx = (polyline[i][1] - p[1]) * 111_320 * k - ax;
      const dy = (polyline[i][0] - p[0]) * 111_320 - ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  };
  return Math.max(...points.map(nearest));
}

const line = (lon) => Array.from({ length: 50 }, (_, i) => [39.9 + i * 0.002, lon + i * 1e-7]);
const shapes = new RouteShapes({
  version: 1,
  built_at: 1,
  routes: {
    17: { 0: line(-75.17), 1: line(-75.18) },
    'L1-OWL': { 0: line(-75.2) },
    t1: { 0: line(-75.19) },
  },
  stops: {
    17: {
      0: [
        [39.9, -75.17, 'Front St & Market St'],
        [39.95, -75.17, '20th St & Johnston St'],
      ],
    },
  },
});

const readJson = async (dir, file) => JSON.parse(await readFile(join(dir, 'shapes', file), 'utf8'));

describe('publishRouteShapes', () => {
  it('writes each bus and Metro route’s directions, simplified', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shapes-'));
    expect(await publishRouteShapes(dir, shapes)).toEqual({ written: 3, removed: 0 });
    expect((await readdir(join(dir, 'shapes'))).sort()).toEqual([
      '17.json',
      'L1-OWL.json',
      't1.json',
    ]);
    const file = await readJson(dir, '17.json');
    expect(file).toMatchObject({ schema_version: 1, route: '17' });
    expect(Object.keys(file.directions)).toEqual(['0', '1']);
    // A straight line is its two ends.
    expect(file.directions[0]).toHaveLength(2);
    expect(file.directions[0][0]).toEqual([39.9, -75.17]);
  });

  it('includes a direction’s stops where it has them, and no stops key where none do', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shapes-'));
    await publishRouteShapes(dir, shapes);
    expect((await readJson(dir, '17.json')).stops).toEqual({
      0: [
        [39.9, -75.17, 'Front St & Market St'],
        [39.95, -75.17, '20th St & Johnston St'],
      ],
    });
    expect(await readJson(dir, 't1.json')).not.toHaveProperty('stops');
  });

  it('leaves unchanged files alone and removes routes that are gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shapes-'));
    await publishRouteShapes(dir, shapes);
    await writeFile(join(dir, 'shapes', 'gone.json'), '{}');
    expect(await publishRouteShapes(dir, shapes)).toEqual({ written: 0, removed: 1 });
  });
});

describe('publishSystemMap', () => {
  // A cache from before the finer copy: only the 6 m shapes.
  const north = line(-75.17);
  const south = [...north].reverse();
  const system = new RouteShapes({
    version: 1,
    built_at: 42,
    routes: {
      // Two streets, one for each direction.
      17: { 0: north, 1: line(-75.18) },
      // The same street both ways.
      K: { 0: north, 1: south },
      'L1-OWL': { 0: line(-75.2) },
      t1: { 0: line(-75.19) },
    },
  });
  const read = async (dir) => JSON.parse(await readFile(join(dir, SYSTEM_MAP_FILE), 'utf8'));

  it('puts every bus route in one file, and leaves Metro routes to the site', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
    expect(await publishSystemMap(dir, system)).toBe(true);
    const file = await read(dir);
    expect(file).toMatchObject({ schema_version: 1, generated_at: 42 });
    expect(Object.keys(file.routes).sort()).toEqual(['17', 'K', 'L1-OWL']);
    // With no finer copy, the cached shapes are published as they are (to a meter).
    expect(file.routes['L1-OWL']).toEqual([round5(line(-75.2))]);
  });

  describe('from a cache with the finer copy', () => {
    const coarse = [arc[0], arc[15], arc[30]];
    const fine = new RouteShapes({
      version: 1,
      built_at: 7,
      routes: { 17: { 0: coarse }, K: { 0: coarse }, t1: { 0: coarse } },
      // No finer copy of K (as if its shape had failed), and none of Metro's t1.
      fine: { 17: { 0: arc } },
    });

    it('publishes the finer line, not the coarse one', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
      await publishSystemMap(dir, fine);
      const { routes } = await read(dir);
      expect(routes['17']).toEqual([round5(arc)]);
      expect(routes['17'][0]).toHaveLength(arc.length);
    });

    it('falls back to the cached shape for a route that has no finer copy', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
      await publishSystemMap(dir, fine);
      expect((await read(dir)).routes.K).toEqual([round5(coarse)]);
    });

    it('still leaves Metro out, and keeps one line for a street run both ways', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
      const both = new RouteShapes({
        version: 1,
        built_at: 7,
        routes: { 17: { 0: arc, 1: [...arc].reverse() }, t1: { 0: arc } },
        fine: { 17: { 0: arc, 1: [...arc].reverse() } },
      });
      await publishSystemMap(dir, both);
      const { routes } = await read(dir);
      expect(Object.keys(routes)).toEqual(['17']);
      expect(routes['17']).toHaveLength(1);
    });
  });

  it('keeps both directions only when they run on different streets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
    await publishSystemMap(dir, system);
    const { routes } = await read(dir);
    expect(routes['17']).toHaveLength(2);
    expect(routes.K).toHaveLength(1);
  });

  it('writes nothing again when nothing changed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'system-map-'));
    await publishSystemMap(dir, system);
    expect(await publishSystemMap(dir, system)).toBe(false);
  });

  it('creates the data directory if it is not there yet', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'system-map-')), 'data');
    expect(await publishSystemMap(dir, system)).toBe(true);
    expect((await read(dir)).routes).toHaveProperty('17');
  });
});

// A small GTFS bundle: route 17 has a common and a rare pattern northbound, and
// one southbound; T1 is a trolley.
function gtfs(files) {
  return { read: (name) => Buffer.from(files[name]) };
}
const bundle = gtfs({
  'trips.txt': [
    'route_id,service_id,trip_id,direction_id,shape_id',
    '17,wk,t1,0,S1',
    '17,wk,t2,0,S1',
    '17,wk,t3,0,S2',
    '17,wk,t4,1,S3',
    'T1,wk,t5,0,S4',
    'K,wk,t6,0,S5',
  ].join('\n'),
  'shapes.txt': [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'S1,39.95,-75.17,1',
    'S1,39.96,-75.17,2',
    'S1,39.97,-75.17,3',
    'S2,39.95,-75.2,1',
    'S2,39.96,-75.2,2',
    'S3,39.97,-75.17,1',
    'S3,39.95,-75.17,2',
    'S4,39.95,-75.21,1',
    'S4,39.96,-75.21,2',
    ...arc.map(([lat, lon], i) => `S5,${lat.toFixed(6)},${lon.toFixed(6)},${i + 1}`),
  ].join('\n'),
  // Rows are out of order and the other trips' stops are mixed in.
  'stop_times.txt': [
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
    't1,08:10:00,08:10:00,c,3',
    't3,08:00:00,08:00:00,z,1',
    't1,08:00:00,08:00:00,a,1',
    't2,08:00:00,08:00:00,y,1',
    't1,08:05:00,08:05:00,b,2',
    't4,09:00:00,09:00:00,c,1',
    't4,09:10:00,09:10:00,a,2',
    't5,09:00:00,09:00:00,t,1',
  ].join('\n'),
  'stops.txt': [
    'stop_id,stop_name,stop_lat,stop_lon',
    'a,Front St & Market St - FS,39.95,-75.17',
    'b,"Broad St, at Spring Garden",39.96,-75.17',
    'c,20th St & Johnston St Boarding Area 2,39.97,-75.17',
    'z,Rare Pattern Stop,39.95,-75.2',
    'y,Another Trip’s Stop,39.951,-75.17',
    't,Trolley Stop,39.95,-75.21',
    'n,Nowhere,0,0',
  ].join('\n'),
});

describe('buildRouteShapes', () => {
  const built = buildRouteShapes(bundle, 123);

  it('keeps the shape most of a route’s trips run, per direction', () => {
    expect(built).toMatchObject({ version: 1, built_at: 123 });
    expect(Object.keys(built.routes).sort()).toEqual(['17', 'K', 't1']);
    expect(built.routes['17']['0'][0]).toEqual([39.95, -75.17]);
    expect(built.routes['17']['1'][0]).toEqual([39.97, -75.17]);
  });

  describe('the finer copy, for the system map', () => {
    it('is kept for each bus route, and not for Metro, which the site draws itself', () => {
      expect(Object.keys(built.fine).sort()).toEqual(['17', 'K']);
      expect(Object.keys(built.fine['17']).sort()).toEqual(['0', '1']);
    });

    it('is the same line where the shape is straight, and keeps more of a curve', () => {
      expect(built.fine['17']['0']).toEqual(built.routes['17']['0']);
      expect(built.fine.K['0'].length).toBeGreaterThan(built.routes.K['0'].length);
    });

    it('ends where the shape does', () => {
      expect(built.fine.K['0'][0]).toEqual(built.routes.K['0'][0]);
      expect(built.fine.K['0'].at(-1)).toEqual(built.routes.K['0'].at(-1));
    });

    it('keeps the curve within 3 m of the shape, where the cached one is up to 6 m off', () => {
      // (to the 1 m the coordinates are rounded to, and a little for the flat projection)
      expect(farthestFrom(arc, built.fine.K['0'])).toBeLessThanOrEqual(3.6);
      expect(farthestFrom(arc, built.routes.K['0'])).toBeGreaterThan(3.6);
      expect(farthestFrom(arc, built.routes.K['0'])).toBeLessThanOrEqual(6.6);
    });

    it('is read back as the system map’s lines, or the coarse ones for an older cache', () => {
      const shapes2 = new RouteShapes(built);
      expect(shapes2.systemLines('K')).toEqual([built.fine.K['0']]);
      const older = new RouteShapes({ ...built, fine: undefined });
      expect(older.systemLines('K')).toEqual([built.routes.K['0']]);
      expect(older.systemLines('nope')).toEqual([]);
    });
  });

  it('lists a direction’s stops in order, from a trip that runs that shape', () => {
    expect(built.stops['17']['0']).toEqual([
      [39.95, -75.17, 'Front St & Market St'],
      [39.96, -75.17, 'Broad St, at Spring Garden'],
      [39.97, -75.17, '20th St & Johnston St'],
    ]);
    expect(built.stops['17']['1'].map((s) => s[2])).toEqual([
      '20th St & Johnston St',
      'Front St & Market St',
    ]);
    expect(built.stops.t1['0']).toEqual([[39.95, -75.21, 'Trolley Stop']]);
  });

  it('is readable as RouteShapes', () => {
    const shapes2 = new RouteShapes(built);
    expect(shapes2.stops('17', 0)).toHaveLength(3);
    expect(shapes2.stops('17', 1)).toHaveLength(2);
    expect(shapes2.stops('nope')).toEqual([]);
    // A cache built before stops were kept has none.
    expect(new RouteShapes({ ...built, stops: undefined }).stops('17')).toEqual([]);
  });
});
