import { describe, expect, it } from 'vitest';
import { cacheIsCurrent, SCHEDULE_VERSION } from '../lib/schedule.js';
import { SHAPES_REV } from '../lib/shapes.js';

const NOW = 1_791_300_000_000;
const HOUR = 60 * 60 * 1000;
const cache = (over = {}) => ({
  version: SCHEDULE_VERSION,
  built_at: NOW - HOUR,
  shapes_rev: SHAPES_REV,
  ...over,
});

describe('cacheIsCurrent', () => {
  it('uses a cache under a day old that was built with today’s shapes', () => {
    expect(cacheIsCurrent(cache(), NOW)).toBe(true);
    expect(cacheIsCurrent(cache({ built_at: NOW - 23 * HOUR }), NOW)).toBe(true);
  });

  it('rebuilds one that is a day old', () => {
    expect(cacheIsCurrent(cache({ built_at: NOW - 24 * HOUR - 1 }), NOW)).toBe(false);
    expect(cacheIsCurrent(cache({ built_at: NOW - 3 * 24 * HOUR }), NOW)).toBe(false);
  });

  it('rebuilds one built before the shapes cache held what the site needs, however new', () => {
    // As every cache is until the collector is updated: no revision at all.
    expect(cacheIsCurrent(cache({ shapes_rev: undefined }), NOW)).toBe(false);
    expect(cacheIsCurrent(cache({ shapes_rev: SHAPES_REV - 1 }), NOW)).toBe(false);
  });

  it('rebuilds one from an earlier version of the index, however new', () => {
    expect(cacheIsCurrent(cache({ version: SCHEDULE_VERSION - 1 }), NOW)).toBe(false);
  });

  it('has no use for a cache that is not there', () => {
    expect(cacheIsCurrent(null, NOW)).toBe(false);
    expect(cacheIsCurrent(undefined, NOW)).toBe(false);
  });
});
