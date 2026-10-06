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
    // Regression for the Brown Line Belmont→Fullerton overshoot.
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
    const map = buildMultiLineMap(['purple', 'pink', 'green', 'brown', 'orange']);
    expect(map).not.toBeNull();
    expect(map.width).toBeGreaterThan(0);
    expect(map.height).toBeGreaterThan(0);
    const keys = map.tracksByLine.map((t) => t.key).sort();
    expect(keys).toEqual(['brown', 'green', 'orange', 'pink', 'purple']);
    for (const t of map.tracksByLine) {
      expect(t.color).toMatch(/^#/);
      expect(t.tracks.length).toBeGreaterThan(0);
    }
  });

  it('tags shared Loop stations with every serving line', () => {
    const map = buildMultiLineMap(['purple', 'pink', 'green', 'brown', 'orange']);
    const wabash = map.stations.find((s) => s.name === 'Washington/Wabash');
    expect(wabash).toBeTruthy();
    expect(wabash.lines.sort()).toEqual(['brown', 'green', 'orange', 'pink', 'purple']);
    expect(wabash.slug).toBe('washington-wabash');
  });

  it('dedups repeated line keys', () => {
    const map = buildMultiLineMap(['purple', 'purple', 'pink']);
    expect(map.tracksByLine.map((t) => t.key).sort()).toEqual(['pink', 'purple']);
  });
});

describe('affectedLineSegments', () => {
  it('returns one segment per merged observation, each on its own line', () => {
    // Observation ts ordering vs the CTA anchor decides the primary (closest)
    // and the order of the extras: brown (anchor), then pink, then orange.
    const T = 1_000_000_000_000;
    const incident = v2Incident({
      id: '115102',
      kind: 'metro',
      routes: ['purple', 'pink', 'green', 'brown', 'orange'],
      cta: {
        alert_id: '115102',
        first_seen_ts: T,
        affected_from_station: null,
        affected_to_station: null,
      },
      observations: [
        {
          line: 'brown',
          from_station: 'Armitage (Brown/Purple)',
          to_station: 'Chicago (Brown/Purple)',
          ts: T,
        },
        {
          line: 'pink',
          from_station: 'Ashland (Green/Pink)',
          to_station: 'Washington/Wabash',
          ts: T + 1000,
        },
        {
          line: 'orange',
          from_station: '35th/Archer',
          to_station: 'Halsted (Orange)',
          ts: T + 2000,
        },
      ],
    });
    const segs = affectedLineSegments(incident);
    expect(segs).toEqual([
      { line: 'brown', from: 'Armitage (Brown/Purple)', to: 'Chicago (Brown/Purple)' },
      { line: 'pink', from: 'Ashland (Green/Pink)', to: 'Washington/Wabash' },
      { line: 'orange', from: '35th/Archer', to: 'Halsted (Orange)' },
    ]);
  });

  it('uses the alert-level segment (line null) for a pure CTA alert', () => {
    const incident = v2Incident({
      id: 'a1',
      kind: 'metro',
      routes: ['red', 'purple'],
      cta: { alert_id: 'a1', affected_from_station: 'Belmont', affected_to_station: 'Howard' },
      observations: [],
    });
    expect(affectedLineSegments(incident)).toEqual([{ line: null, from: 'Belmont', to: 'Howard' }]);
  });

  it('returns the single segment for a standalone observation', () => {
    const incident = v2Incident({
      id: 'o1',
      kind: 'metro',
      routes: ['red'],
      cta: null,
      observations: [{ line: 'red', from_station: 'Howard', to_station: 'Loyola', ts: 1 }],
    });
    expect(affectedLineSegments(incident)).toEqual([{ line: 'red', from: 'Howard', to: 'Loyola' }]);
  });

  it('skips segments with no endpoints', () => {
    const incident = v2Incident({
      id: 'm1',
      kind: 'metro',
      routes: ['red'],
      cta: { alert_id: 'm1', affected_from_station: null, affected_to_station: null },
      observations: [{ line: 'red', from_station: null, to_station: null, ts: 1 }],
    });
    expect(affectedLineSegments(incident)).toEqual([]);
  });
});
