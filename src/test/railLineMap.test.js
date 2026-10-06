import { describe, expect, it } from 'vitest';
import { buildRailLineMap, sliceTrackBetween } from '../lib/railLineMap.js';
import { RAIL_LINE_ORDER } from '../lib/railLines.js';

describe('buildRailLineMap', () => {
  it('returns null for an unknown line key', () => {
    expect(buildRailLineMap('not-a-line')).toBe(null);
    expect(buildRailLineMap(null)).toBe(null);
  });

  it('builds projected geometry for every Regional Rail line', () => {
    for (const key of RAIL_LINE_ORDER) {
      const map = buildRailLineMap(key);
      expect(map, `${key} should build`).not.toBe(null);
      expect(map.width).toBeGreaterThan(0);
      expect(map.height).toBeGreaterThan(0);
      expect(map.stations.length).toBeGreaterThan(1);
      expect(map.tracks.length).toBeGreaterThan(0);
      // No downtown inset on the Regional Rail side.
      expect(map.downtown).toBe(null);
      // Every projected station sits inside the SVG box.
      for (const s of map.stations) {
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(map.width);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(map.height);
      }
    }
  });

  it('flags exactly two terminals (first + last stop)', () => {
    const map = buildRailLineMap('pao');
    const terminals = map.stations.filter((s) => s.isTerminal);
    expect(terminals).toHaveLength(2);
  });

  it('accepts case-insensitive line keys', () => {
    expect(buildRailLineMap('PAO')).not.toBe(null);
    expect(buildRailLineMap('pao')).not.toBe(null);
  });

  it('colors stations from the injected station index', () => {
    const map0 = buildRailLineMap('pao');
    const someSlug = map0.stations.find((s) => s.slug)?.slug;
    expect(someSlug).toBeTruthy();
    const index = new Map([[someSlug, { count: 7 }]]);
    const map = buildRailLineMap('pao', index);
    expect(map.maxCount).toBe(7);
    expect(map.stations.find((s) => s.slug === someSlug).count).toBe(7);
  });

  it('slices a track path between two stations on the line', () => {
    const map = buildRailLineMap('wtr');
    const a = map.stations[0];
    const b = map.stations[map.stations.length - 1];
    const path = sliceTrackBetween(map.tracks, a, b);
    expect(typeof path).toBe('string');
    expect(path.startsWith('M')).toBe(true);
  });
});
