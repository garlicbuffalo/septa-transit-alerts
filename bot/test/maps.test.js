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

describe('vehicle outlines', () => {
  it('draw each vehicle as what it is', async () => {
    const { vehicleShape } = await import('../lib/routes.js');
    expect(vehicleShape({ mode: 'bus', route: '23', label: '3676' })).toBe('bus');
    expect(vehicleShape({ mode: 'metro', route: 't1', label: '9051' })).toBe('lrv'); // Kawasaki
    expect(vehicleShape({ mode: 'metro', route: 'd2', label: '113' })).toBe('lrv');
    expect(vehicleShape({ mode: 'metro', route: 'g1', label: '2324' })).toBe('pcc');
    expect(vehicleShape({ mode: 'metro', route: 'g1', label: '3676' })).toBe('bus');
    expect(vehicleShape({ mode: 'metro', route: 'm1', label: '154' })).toBe('m1');
    expect(vehicleShape({ mode: 'regional_rail', route: 'pao', label: '9233' })).toBe('rail');
    expect(vehicleShape({ mode: 'metro', route: 'l1', label: '1001' })).toBe('subway');
    // Without a mode, from the route.
    expect(vehicleShape({ route: 'm1' })).toBe('m1');
    expect(vehicleShape({ route: 'pao' })).toBe('rail');
    expect(vehicleShape({ route: 'b2' })).toBe('subway');
    expect(vehicleShape({ route: '23', label: '3112' })).toBe('bus'); // any other route
    expect(vehicleShape({})).toBe('circle');
  });

  it('get a legend only when a map mixes kinds', async () => {
    const { vehicleLegendRows } = await import('../lib/routes.js');
    const v = (mode, route, label) => ({ mode, route, label });
    expect(vehicleLegendRows([v('bus', '23', '1'), v('bus', '23', '2')])).toEqual([]);
    expect(
      vehicleLegendRows([v('metro', 'g1', '3676'), v('metro', 'g1', '2337')]).map((r) => r.label),
    ).toEqual(['PCC trolley', 'Bus']);
    expect(
      vehicleLegendRows([
        v('metro', 't1', '9051'),
        v('metro', 'g1', '2337'),
        v('bus', '64', '1'),
      ]).map((r) => r.label),
    ).toEqual(['PCC trolley', 'Kawasaki trolley', 'Bus']);
    expect(
      vehicleLegendRows([v('metro', 'm1', '154'), v('regional_rail', 'pao', '9233')]).map(
        (r) => r.shape,
      ),
    ).toEqual(['m1', 'rail']);
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

  it('carry each vehicle’s features', async () => {
    const { vehicleMark } = await import('../map/draw.js');
    const mark = (shape) => vehicleMark(100, 100, 22, { shape, fill: '#f00' });
    expect(mark('pcc')).toContain('<line'); // the trolley pole
    expect(mark('pcc').match(/fill="#0b0d10" stroke/g)).toHaveLength(4); // two pairs of small wheels
    expect(mark('pcc')).toContain('fill="#fff5c2"'); // the headlight
    expect(mark('pcc')).toContain('<path'); // the streamlined body
    // Long and low: a longer outline than the bus's.
    const { MARK_WIDTH } = await import('../map/draw.js');
    expect(MARK_WIDTH.pcc).toBeGreaterThan(MARK_WIDTH.bus);
    expect(mark('lrv')).toContain('<line'); // its pole too
    expect(mark('lrv').match(/<circle/g)).toHaveLength(5); // and a third truck under the joint
    expect(mark('lrv')).toContain('<path'); // angled cabs
    expect(mark('subway')).not.toContain('<line'); // no pole
    expect(mark('subway').match(/<circle/g)).toHaveLength(4);
    expect(mark('bus')).not.toContain('<line');
    expect(mark('bus').match(/<circle/g)).toHaveLength(2); // two big wheels
    expect(mark('m1').match(/<circle/g)).toHaveLength(4); // two bogies
    expect(mark('m1')).not.toContain('<line'); // third rail: no pole
    expect(mark('rail').match(/<circle/g)).toHaveLength(6); // two cars' bogies
    expect(mark('rail')).toMatch(/fill="none"/); // the pantograph
    expect(vehicleMark(100, 100, 22, { fill: '#f00' })).toMatch(/^<circle /);
  });
});
