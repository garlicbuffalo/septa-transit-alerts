import { describe, expect, it } from 'vitest';
import { affectedLineSegments } from '../lib/incidents.js';
import { buildMultiLineMap, sliceTrackBetween } from '../lib/lineMap.js';
import { incident as v2Incident } from './v2TestHelpers.js';

describe('sliceTrackBetween', () => {
  // A simple horizontal polyline; stations sit on two of its points.
  const track = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];

  it('returns an SVG path between the two nearest points', () => {
    const d = sliceTrackBetween([track], { x: 10, y: 0 }, { x: 20, y: 0 });
    expect(typeof d).toBe('string');
    expect(d.startsWith('M')).toBe(true);
    expect(d).toContain('L');
  });

  it('picks the branch that best covers both endpoints', () => {
    const right = track;
    const wrong = [
      { x: 0, y: 100 },
      { x: 30, y: 100 },
    ];
    const d = sliceTrackBetween([wrong, right], { x: 10, y: 0 }, { x: 20, y: 0 });
    // The chosen path should hug y=0 (the right branch), not y=100.
    expect(d).not.toContain(',100');
  });

  it('returns null when no polyline has two usable points', () => {
    expect(sliceTrackBetween([[{ x: 0, y: 0 }]], { x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  });

  it('does not overshoot when the nearest vertex sits past the end station', () => {
    // Sparse track: both stations snap to the same vertex (y=30), which is
    // *beyond* the end station (y=12). The slice is a single vertex, so the
    // old per-segment trim (gated on length>=2) never fired and the highlight
    // drew a stub down to y=30 and back. The chord-projection trim drops it.
    // Regression for a sparse-track overshoot past the end station.
    const sparse = [
      { x: 0, y: 30 },
      { x: 0, y: 40 },
    ];
    const d = sliceTrackBetween([sparse], { x: 0, y: 0 }, { x: 0, y: 12 });
    expect(d).not.toContain(',30');
    expect(d).not.toContain(',40');
    expect(d).toBe('M0.0,0.0L0.0,12.0');
  });
});

describe('buildMultiLineMap', () => {
  it('returns null when no known line is given', () => {
    expect(buildMultiLineMap([])).toBeNull();
    expect(buildMultiLineMap(['not-a-line'])).toBeNull();
  });

  it('projects every requested line with its brand color', () => {
    const map = buildMultiLineMap(['l1', 'b1', 't1', 'm1', 'g1']);
    expect(map).not.toBeNull();
    expect(map.width).toBeGreaterThan(0);
    expect(map.height).toBeGreaterThan(0);
    const keys = map.tracksByLine.map((t) => t.key).sort();
    expect(keys).toEqual(['b1', 'g1', 'l1', 'm1', 't1']);
    for (const t of map.tracksByLine) {
      expect(t.color).toMatch(/^#/);
      expect(t.tracks.length).toBeGreaterThan(0);
    }
  });

  it('tags shared Center City stations with every serving line', () => {
    const map = buildMultiLineMap(['l1', 'b1', 't1']);
    const cityHall = map.stations.find((s) => s.name === '15th St/City Hall');
    expect(cityHall).toBeTruthy();
    expect(cityHall.lines.sort()).toEqual(['b1', 'b2', 'l1', 't1', 't2', 't3', 't4', 't5']);
    expect(cityHall.slug).toBe('15th-st-city-hall');
  });

  it('dedups repeated line keys', () => {
    const map = buildMultiLineMap(['b2', 'b2', 'd1']);
    expect(map.tracksByLine.map((t) => t.key).sort()).toEqual(['b2', 'd1']);
  });
});

describe('affectedLineSegments', () => {
  it('returns one segment per merged observation, each on its own line', () => {
    // Observation ts ordering vs the alert anchor decides the primary (closest)
    // and the order of the extras: M1 (anchor), then D1, then G1.
    const T = 1_000_000_000_000;
    const incident = v2Incident({
      id: '115102',
      kind: 'metro',
      routes: ['b2', 'd1', 't1', 'm1', 'g1'],
      cta: {
        alert_id: '115102',
        first_seen_ts: T,
        affected_from_station: null,
        affected_to_station: null,
      },
      observations: [
        {
          line: 'm1',
          from_station: 'Bryn Mawr',
          to_station: 'Villanova',
          ts: T,
        },
        {
          line: 'd1',
          from_station: '69th St Transit Center',
          to_station: 'Drexel Hill Junction',
          ts: T + 1000,
        },
        {
          line: 'g1',
          from_station: 'Girard-Broad',
          to_station: 'Girard-Frankford',
          ts: T + 2000,
        },
      ],
    });
    const segs = affectedLineSegments(incident);
    expect(segs).toEqual([
      { line: 'm1', from: 'Bryn Mawr', to: 'Villanova' },
      { line: 'd1', from: '69th St Transit Center', to: 'Drexel Hill Junction' },
      { line: 'g1', from: 'Girard-Broad', to: 'Girard-Frankford' },
    ]);
  });

  it('uses the alert-level segment (line null) for a pure SEPTA alert', () => {
    const incident = v2Incident({
      id: 'a1',
      kind: 'metro',
      routes: ['l1', 'b2'],
      cta: {
        alert_id: 'a1',
        affected_from_station: 'Spring Garden',
        affected_to_station: 'Frankford Transit Center',
      },
      observations: [],
    });
    expect(affectedLineSegments(incident)).toEqual([
      { line: null, from: 'Spring Garden', to: 'Frankford Transit Center' },
    ]);
  });

  it('returns the single segment for a standalone observation', () => {
    const incident = v2Incident({
      id: 'o1',
      kind: 'metro',
      routes: ['l1'],
      cta: null,
      observations: [
        {
          line: 'l1',
          from_station: 'Frankford Transit Center',
          to_station: 'Arrott Transit Center',
          ts: 1,
        },
      ],
    });
    expect(affectedLineSegments(incident)).toEqual([
      { line: 'l1', from: 'Frankford Transit Center', to: 'Arrott Transit Center' },
    ]);
  });

  it('skips segments with no endpoints', () => {
    const incident = v2Incident({
      id: 'm1',
      kind: 'metro',
      routes: ['l1'],
      cta: { alert_id: 'm1', affected_from_station: null, affected_to_station: null },
      observations: [{ line: 'l1', from_station: null, to_station: null, ts: 1 }],
    });
    expect(affectedLineSegments(incident)).toEqual([]);
  });
});
