import { describe, expect, it } from 'vitest';
import {
  activeAgeBreakdown,
  computeModeHealth,
  hourlyUnplannedStarts,
  issueTypeBreakdown,
  mostAffectedRoutes,
} from '../lib/systemHealth.js';
import { incident } from './v2TestHelpers.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Bot-only gap detection → 'disruption'.
const gap = (id, routes, over = {}) =>
  incident({
    id,
    kind: 'metro',
    routes,
    cta: null,
    active: true,
    first_seen_ts: NOW - 30 * MIN,
    observations: [{ detection_source: 'gap', line: routes[0] }],
    ...over,
  });
// Bot-only cancelled-trips record → 'delay'.
const cancelledTrips = (id, routes, over = {}) =>
  incident({
    id,
    kind: 'metro',
    routes,
    cta: null,
    active: true,
    first_seen_ts: NOW - 2 * HOUR,
    observations: [{ detection_source: 'trip-cancellations', line: routes[0] }],
    ...over,
  });
// SEPTA advisory over a dated multi-day window → 'planned'.
const planned = (id, routes, over = {}) =>
  incident({
    id,
    kind: 'metro',
    routes,
    active: true,
    first_seen_ts: NOW - 3 * DAY,
    cta: {
      headline: 'Weekend shuttle buses',
      agency_event_window: {
        start_ts: NOW - 3 * DAY,
        end_ts: NOW + 2 * DAY,
        end_is_date_only: true,
      },
    },
    ...over,
  });

describe('computeModeHealth', () => {
  it('reports good service with nothing open', () => {
    const h = computeModeHealth([], 'metro', { now: NOW });
    expect(h.status).toBe('good');
    expect(h.counts).toEqual({ disruption: 0, delay: 0, planned: 0 });
    expect(h.affected).toBe(0);
    expect(h.rosterSize).toBe(13);
  });

  it('keeps a mode with only planned work at good service', () => {
    const h = computeModeHealth([planned('p1', ['l1']), planned('p2', ['b1', 'b2'])], 'metro', {
      now: NOW,
    });
    expect(h.status).toBe('good');
    expect(h.counts.planned).toBe(2);
    expect(h.lineCounts.planned).toBe(3);
    expect(h.affected).toBe(3);
  });

  it('takes each line’s worst open category for the line board', () => {
    const h = computeModeHealth(
      [planned('p1', ['l1']), gap('g1', ['l1']), cancelledTrips('c1', ['t1'])],
      'metro',
      { now: NOW },
    );
    expect(h.lineStatus.get('l1').status).toBe('disruption');
    expect(h.lineStatus.get('l1').counts).toEqual({ disruption: 1, delay: 0, planned: 1 });
    expect(h.lineStatus.get('t1').status).toBe('delay');
    expect(h.status).toBe('serious');
  });

  it('grades delays alone as minor, and widespread disruption as major', () => {
    expect(computeModeHealth([cancelledTrips('c1', ['t1'])], 'metro', { now: NOW }).status).toBe(
      'warning',
    );
    const many = ['l1', 'b1', 'm1'].map((r, i) => gap(`g${i}`, [r]));
    expect(computeModeHealth(many, 'metro', { now: NOW }).status).toBe('critical');
  });

  it('ignores other modes and resolved incidents', () => {
    const h = computeModeHealth(
      [
        gap('g1', ['l1'], { active: false, resolved_ts: NOW - 10 * MIN }),
        incident({ id: 'r1', kind: 'rail', routes: ['pao'], active: true, first_seen_ts: NOW }),
      ],
      'metro',
      { now: NOW },
    );
    expect(h.counts).toEqual({ disruption: 0, delay: 0, planned: 0 });
    // The resolved gap still counts toward the last-24h activity.
    expect(h.last24).toBe(1);
  });

  it('only compares with the prior 24h when the data covers it', () => {
    const incs = [gap('g1', ['l1'])];
    expect(computeModeHealth(incs, 'metro', { now: NOW, dataStartTs: NOW - DAY }).prior24).toBe(
      null,
    );
    expect(computeModeHealth(incs, 'metro', { now: NOW, dataStartTs: NOW - 3 * DAY }).prior24).toBe(
      0,
    );
  });
});

describe('hourlyUnplannedStarts', () => {
  it('buckets unplanned starts into 24 clock hours, current hour last', () => {
    const bins = hourlyUnplannedStarts(
      [
        gap('g1', ['l1'], { first_seen_ts: NOW - 1000 }),
        gap('g2', ['l1'], { first_seen_ts: NOW - 5 * HOUR }),
        planned('p1', ['l1'], { first_seen_ts: NOW - 1000 }),
        gap('old', ['l1'], { first_seen_ts: NOW - 2 * DAY }),
      ],
      { now: NOW },
    );
    expect(bins).toHaveLength(24);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(2);
    expect(bins[23].count).toBe(1);
    expect(bins[23].start).toBeLessThanOrEqual(NOW);
    expect(bins[23].end).toBeGreaterThan(NOW);
  });

  it('flags hours before collection started as no-data', () => {
    const bins = hourlyUnplannedStarts([], { now: NOW, dataStartTs: NOW - 6 * HOUR });
    expect(bins.filter((b) => b.noData).length).toBeGreaterThanOrEqual(17);
    expect(bins[23].noData).toBe(false);
  });
});

describe('activeAgeBreakdown', () => {
  it('buckets open incidents by elapsed time and category', () => {
    const bins = activeAgeBreakdown(
      [gap('g1', ['l1']), cancelledTrips('c1', ['t1']), planned('p1', ['l1'])],
      { now: NOW },
    );
    const byKey = Object.fromEntries(bins.map((b) => [b.key, b]));
    expect(byKey.lt1h.disruption).toBe(1);
    expect(byKey['1-3h'].delay).toBe(1);
    expect(byKey['1-7d'].planned).toBe(1);
    expect(bins.reduce((s, b) => s + b.total, 0)).toBe(3);
  });
});

describe('issueTypeBreakdown', () => {
  it('counts each kind of trouble once per incident, most common first', () => {
    const rows = issueTypeBreakdown(
      [gap('g1', ['l1']), gap('g2', ['b1']), cancelledTrips('c1', ['t1']), planned('p1', ['l1'])],
      { now: NOW },
    );
    expect(rows[0]).toEqual({ key: 'gap', label: 'Headway gaps', count: 2 });
    expect(rows.map((r) => r.key)).toEqual(
      expect.arrayContaining(['trip-cancellations', 'planned']),
    );
  });

  it('folds the tail into Other past the limit', () => {
    const sources = ['gap', 'bunching', 'ghost', 'pulse-held', 'trip-cancellations'];
    const incs = sources.map((s, i) =>
      incident({
        id: `i${i}`,
        cta: null,
        active: true,
        first_seen_ts: NOW,
        observations: [{ detection_source: s }],
      }),
    );
    const rows = issueTypeBreakdown(incs, { now: NOW, limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ key: 'other', count: 3 });
  });
});

describe('mostAffectedRoutes', () => {
  it('ranks lines by incidents in the window, split by category', () => {
    const rows = mostAffectedRoutes(
      [gap('g1', ['l1']), planned('p1', ['l1']), cancelledTrips('c1', ['t1'])],
      { now: NOW },
    );
    expect(rows[0]).toMatchObject({
      mode: 'metro',
      route: 'l1',
      total: 2,
      disruption: 1,
      planned: 1,
    });
    expect(rows[1]).toMatchObject({ route: 't1', delay: 1 });
  });
});
