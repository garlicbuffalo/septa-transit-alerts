import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publishRouteShapes, RouteShapes } from '../lib/shapes.js';

const line = (lon) => Array.from({ length: 50 }, (_, i) => [39.9 + i * 0.002, lon + i * 1e-7]);
const shapes = new RouteShapes({
  version: 1,
  built_at: 1,
  routes: {
    17: { 0: line(-75.17), 1: line(-75.18) },
    'L1-OWL': { 0: line(-75.2) },
    t1: { 0: line(-75.19) },
  },
});

describe('publishRouteShapes', () => {
  it('writes each bus route’s directions, simplified, and no Metro lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shapes-'));
    expect(await publishRouteShapes(dir, shapes)).toEqual({ written: 2, removed: 0 });
    expect((await readdir(join(dir, 'shapes'))).sort()).toEqual(['17.json', 'L1-OWL.json']);
    const file = JSON.parse(await readFile(join(dir, 'shapes', '17.json'), 'utf8'));
    expect(file).toMatchObject({ schema_version: 1, route: '17' });
    expect(Object.keys(file.directions)).toEqual(['0', '1']);
    // A straight line is its two ends.
    expect(file.directions[0]).toHaveLength(2);
    expect(file.directions[0][0]).toEqual([39.9, -75.17]);
  });

  it('leaves unchanged files alone and removes routes that are gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shapes-'));
    await publishRouteShapes(dir, shapes);
    await writeFile(join(dir, 'shapes', 'gone.json'), '{}');
    expect(await publishRouteShapes(dir, shapes)).toEqual({ written: 0, removed: 1 });
  });
});
