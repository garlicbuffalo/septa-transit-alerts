import { describe, expect, it } from 'vitest';
import {
  computeHourOfDayContext,
  computeLineDurationRank,
  computeStretchRecurrence,
} from '../lib/aggregate.js';
import { incident } from './v2TestHelpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A fixed Chicago-afternoon anchor so hour bucketing is deterministic.
const NOW = Date.UTC(2026, 4, 28, 20, 0, 0); // 2026-05-28 20:00 UTC ≈ 15:00 CDT

function obs(line, from, to, source = 'pulse-cold') {
  return { line, from_station: from, to_station: to, detection_source: source };
}

function inc(over = {}) {
  return incident({
    kind: 'metro',
    routes: over.routes ?? [over.observations?.[0]?.line ?? 'red'],
    cta: null,
    ...over,
  });
}

describe('computeStretchRecurrence', () => {
  const incidents = [
    inc({
      id: 's1',
      kind: 'metro',
      first_seen_ts: NOW - 1 * DAY,
      observations: [obs('orange', 'Western (Orange)', 'Ashland (Orange)')],
    }),
    inc({
      id: 's2',
      kind: 'metro',
      first_seen_ts: NOW - 10 * DAY,
      observations: [obs('orange', 'Western (Orange)', 'Ashland (Orange)')],
    }),
    inc({
      id: 'self',
      kind: 'metro',
      first_seen_ts: NOW,
      observations: [obs('orange', 'Western (Orange)', 'Ashland (Orange)')],
    }),
    // Different stretch — must not count.
    inc({
      id: 'other',
      kind: 'metro',
      first_seen_ts: NOW - 2 * DAY,
      observations: [obs('orange', 'Halsted', 'Ashland (Orange)')],
    }),
  ];

  it('counts incidents on the same stretch and excludes self from priorCount', () => {
    const out = computeStretchRecurrence(incidents, {
      line: 'orange',
      fromStation: 'Western (Orange)',
      toStation: 'Ashland (Orange)',
      selfId: 'self',
      now: NOW,
      windowDays: 90,
    });
    expect(out.count).toBe(3); // includes self
    expect(out.priorCount).toBe(2); // excludes self
    expect(out.lastOtherTs).toBe(NOW - 1 * DAY);
  });

  it('returns null for a one-off stretch (no prior recurrence)', () => {
    expect(
      computeStretchRecurrence(incidents, {
        line: 'orange',
        fromStation: 'Halsted',
        toStation: 'Ashland (Orange)',
        selfId: 'other',
        now: NOW,
        windowDays: 90,
      }),
    ).toBeNull();
  });

  it('ignores roundup observations and missing stretch', () => {
    const round = [
      inc({
        id: 'r',
        kind: 'metro',
        first_seen_ts: NOW,
        observations: [obs('orange', 'A', 'B', 'roundup')],
      }),
    ];
    expect(
      computeStretchRecurrence(round, {
        line: 'orange',
        fromStation: 'A',
        toStation: 'B',
        now: NOW,
      }),
    ).toBeNull();
    expect(computeStretchRecurrence(incidents, { line: 'orange', now: NOW })).toBeNull();
  });
});

describe('computeLineDurationRank', () => {
  // 10 blue incidents; the subject is the longest.
  const incidents = [];
  for (let i = 0; i < 9; i++) {
    incidents.push(
      inc({
        id: `b${i}`,
        kind: 'metro',
        routes: ['blue'],
        first_seen_ts: NOW - (i + 1) * DAY,
        resolved_ts: NOW - (i + 1) * DAY + 20 * MIN,
      }),
    );
  }
  const subject = inc({
    id: 'subj',
    kind: 'metro',
    routes: ['blue'],
    first_seen_ts: NOW - 5 * MIN,
    resolved_ts: NOW + 3 * HOUR,
  });
  incidents.push(subject);

  it('flags the longest incident on the line', () => {
    const out = computeLineDurationRank(subject, incidents, { now: NOW, windowDays: 30 });
    expect(out.tier).toBe('longest');
    expect(out.rank).toBe(1);
    expect(out.count).toBe(10);
  });

  it('returns null when the cohort is too small', () => {
    const tiny = [subject, incidents[0], incidents[1]];
    expect(computeLineDurationRank(subject, tiny, { now: NOW })).toBeNull();
  });

  it('returns null for an active (unbounded) incident', () => {
    const active = inc({
      id: subject.id,
      kind: 'metro',
      routes: ['blue'],
      first_seen_ts: NOW - 5 * MIN,
      resolved_ts: null,
    });
    expect(computeLineDurationRank(active, incidents, { now: NOW })).toBeNull();
  });
});

describe('computeHourOfDayContext', () => {
  // Pile 30 incidents into the same Chicago hour as NOW (15:00 CDT) so that
  // hour is far above the flat mean.
  const incidents = [];
  for (let i = 0; i < 30; i++) {
    incidents.push(
      inc({ id: `h${i}`, kind: 'metro', routes: ['red'], first_seen_ts: NOW - i * DAY }),
    );
  }
  const subject = inc({ id: 'subj', kind: 'metro', routes: ['red'], first_seen_ts: NOW });
  incidents.push(subject);

  it('flags a busy hour for the line', () => {
    const out = computeHourOfDayContext(subject, incidents, { now: NOW, windowDays: 90 });
    expect(out.tier).toBe('busy');
    expect(out.ratio).toBeGreaterThan(1.75);
  });

  it('returns null under the minimum sample', () => {
    const sparse = [subject, incidents[0], incidents[1]];
    expect(computeHourOfDayContext(subject, sparse, { now: NOW })).toBeNull();
  });

  it('does not flag a thin daytime hour that only clears the ratio (4 of 54)', () => {
    // Reproduces the "11 AM is a relatively busy hour … 4 of the last 54" noise:
    // 4/54 ≈ 1.78× the flat mean but only ~1.2σ above expectation, so it must
    // not read as busy.
    const THIS_HOUR = NOW; // subject's hour
    const list = [inc({ id: 'subj', kind: 'metro', routes: ['blue'], first_seen_ts: THIS_HOUR })];
    // 3 more in the subject's hour → 4 total in-hour.
    for (let i = 1; i < 4; i++)
      list.push(
        inc({
          id: `in${i}`,
          kind: 'metro',
          routes: ['blue'],
          first_seen_ts: THIS_HOUR - i * DAY,
        }),
      );
    // 50 spread across OTHER hours (offset by hours, not whole days) → total 54.
    for (let i = 0; i < 50; i++) {
      list.push(
        inc({
          id: `out${i}`,
          kind: 'metro',
          routes: ['blue'],
          first_seen_ts: THIS_HOUR - ((i % 12) + 1) * HOUR - i * DAY,
        }),
      );
    }
    const subj = list[0];
    const out = computeHourOfDayContext(subj, list, { now: NOW, windowDays: 90 });
    expect(out).toBeNull();
  });
});
