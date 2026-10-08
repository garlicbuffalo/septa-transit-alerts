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
    // A straight line is its two ends.
    expect(file.routes['L1-OWL']).toEqual([
      [
        [39.9, -75.2],
        [39.998, -75.2],
      ],
    ]);
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
    expect(Object.keys(built.routes).sort()).toEqual(['17', 't1']);
    expect(built.routes['17']['0'][0]).toEqual([39.95, -75.17]);
    expect(built.routes['17']['1'][0]).toEqual([39.97, -75.17]);
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
