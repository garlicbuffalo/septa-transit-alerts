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

describe('G1 vehicle outlines', () => {
  it('tell PCC trolleys from buses on the G1 only', async () => {
    const { vehicleShape, g1LegendRows } = await import('../lib/routes.js');
    expect(vehicleShape('g1', '2324')).toBe('pcc');
    expect(vehicleShape('G1', '3676')).toBe('bus');
    expect(vehicleShape('t1', '9051')).toBe('circle');
    expect(vehicleShape('23', '2324')).toBe('circle');
    expect(g1LegendRows([{ route: 't1', label: '1' }])).toEqual([]);
    expect(
      g1LegendRows([
        { route: 'g1', label: '3676' },
        { route: 'g1', label: '2337' },
      ]).map((r) => r.shape),
    ).toEqual(['pcc', 'bus']);
  });

  it('name what the G1 vehicles in a post are', async () => {
    const { vehiclesNoun } = await import('../lib/routes.js');
    const v = (label) => ({ label });
    expect(vehiclesNoun('metro', 'g1', [v('3676'), v('3400')])).toBe('buses');
    expect(vehiclesNoun('metro', 'g1', [v('2324')], false)).toBe('trolley');
    expect(vehiclesNoun('metro', 'g1', [v('2324'), v('3400')])).toBe('vehicles');
    expect(vehiclesNoun('metro', 'g1', [])).toBe('vehicles');
    expect(vehiclesNoun('metro', 't1', [v('9051')])).toBe('trolleys');
    expect(vehiclesNoun('bus', '23', [], false)).toBe('bus');
  });

  it('draw a trolley pole on a PCC and big wheels on a bus', async () => {
    const { vehicleMark } = await import('../map/draw.js');
    const pcc = vehicleMark(100, 100, 22, { shape: 'pcc', fill: '#f00' });
    const bus = vehicleMark(100, 100, 22, { shape: 'bus', fill: '#f00' });
    expect(pcc).toContain('<line'); // the pole
    expect(bus).not.toContain('<line');
    expect(pcc.match(/<circle/g)).toHaveLength(4); // two pairs of small wheels
    expect(bus.match(/<circle/g)).toHaveLength(2);
    expect(vehicleMark(100, 100, 22, { fill: '#f00' })).toMatch(/^<circle /);
  });
});
