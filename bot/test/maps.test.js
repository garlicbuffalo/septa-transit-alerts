import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createBasemap, staticMapUrl } from '../map/basemap.js';
import { lineStations, planAlertMap, renderPlan, sliceBranch } from '../map/lineMap.js';
import { fitView, project } from '../map/projection.js';
import { officialIncident } from './helpers.js';

describe('projection', () => {
  it('fits a bbox and centers it', () => {
    const view = fitView({ minLat: 39.9, maxLat: 40.0, minLon: -75.2, maxLon: -75.1 }, 1200, 1200, {
      pad: 100,
    });
    const nw = project(view, 40.0, -75.2);
    const se = project(view, 39.9, -75.1);
    expect(nw.x).toBeGreaterThanOrEqual(99);
    expect(se.x).toBeLessThanOrEqual(1101);
    expect((nw.x + se.x) / 2).toBeCloseTo(600, 0);
    expect((nw.y + se.y) / 2).toBeCloseTo(600, 0);
    expect(Math.round(view.zoom * 100)).toBe(view.zoom * 100);
  });

  it('builds Mapbox static URLs for the view', () => {
    const url = staticMapUrl(
      { lat: 39.95, lon: -75.16, zoom: 12.5, width: 1200, height: 1200 },
      'pk.x',
    );
    expect(url).toBe(
      'https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/-75.16000,39.95000,12.5/1200x1200@2x?access_token=pk.x',
    );
  });
});

describe('alert maps', () => {
  it('cuts a line shape between two stations', () => {
    const branch = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ];
    expect(
      sliceBranch(branch, { lat: 0, lon: 2.5 }, { lat: 0, lon: 0.5 }, { maxOffDeg: 0.1 }),
    ).toEqual([
      [0, 0.5],
      [0, 1],
      [0, 2],
      [0, 2.5],
    ]);
    expect(
      sliceBranch(branch, { lat: 1, lon: 1 }, { lat: 0, lon: 2 }, { maxOffDeg: 0.1 }),
    ).toBeNull();
  });

  it('plans a map for a named stretch of a Metro line', () => {
    const stations = lineStations('metro', 'b1');
    expect(stations.length).toBeGreaterThan(10);
    const inc = officialIncident({
      routes: ['b1'],
      headline: 'Shuttle Busing Between Olney and Fern Rock Transit Center',
      scope: {
        from_station: 'Olney Transit Center',
        to_station: 'Fern Rock Transit Center',
        stations: ['Olney Transit Center', 'Fern Rock Transit Center'],
      },
    });
    const plan = planAlertMap(inc);
    expect(plan.title).toBe('⚠ B1 · Olney Transit Center ↔ Fern Rock Transit Center');
    expect(plan.lines[0].stretch.length).toBeGreaterThan(1);
  });

  it('has nothing to map for bus alerts or alerts without stations', () => {
    expect(planAlertMap(officialIncident({ mode: 'bus', routes: ['17'] }))).toBeNull();
    expect(planAlertMap(officialIncident())).toBeNull();
  });

  it('renders a 1200×1200 JPEG over the placeholder basemap', async () => {
    const plan = planAlertMap(
      officialIncident({
        mode: 'regional_rail',
        routes: ['nor'],
        scope: { from_station: 'Conshohocken', to_station: 'Norristown Elm Street', stations: [] },
      }),
    );
    const jpg = await renderPlan(plan, { basemap: createBasemap() });
    const meta = await sharp(jpg).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1200, height: 1200 });
  });
});
