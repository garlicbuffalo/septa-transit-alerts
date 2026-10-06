import { describe, expect, it } from 'vitest';
import {
  buildBusIncidentsByDay,
  computeCohortDurationStats,
  computeDayOfWeekCounts,
  computeDisruptionMinutes,
  computeRailCancellationDelayStats,
  computeRailLeaderboards,
  computeRailStatusCounts,
  computeRecentBurst,
  computeRestorationDeltas,
  computeSegmentRecurrence,
  computeWorstDay,
  DEFAULT_SERVICE_HOURS_PER_DAY,
  serviceHoursForLine,
} from '../lib/aggregate.js';
import { phillyDayUTC } from '../lib/format.js';
import { incident } from './v2TestHelpers.js';

// Fixed reference instant so day/window math is deterministic across runs.
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const obs = (over = {}) => ({
  id: 1,
  kind: 'metro',
  line: 'l1',
  ts: NOW - HOUR,
  resolved_ts: NOW,
  active: false,
  ...over,
});

const alert = (over = {}) => ({
  alert_id: 1,
  kind: 'metro',
  routes: ['l1'],
  headline: 'L1 Delays',
  first_seen_ts: NOW - HOUR,
  resolved_ts: NOW,
  active: false,
  ...over,
});

// ---------------------------------------------------------------------------
// serviceHoursForLine
// ---------------------------------------------------------------------------
describe('serviceHoursForLine', () => {
  it('has no 24h Metro rail lines (overnight L1/B1 service runs as Owl buses)', () => {
    expect(serviceHoursForLine('metro', 'l1')).toBe(DEFAULT_SERVICE_HOURS_PER_DAY);
    expect(serviceHoursForLine('metro', 'b1')).toBe(DEFAULT_SERVICE_HOURS_PER_DAY);
  });

  it('gives Metro lines and buses the default 20h/day', () => {
    expect(DEFAULT_SERVICE_HOURS_PER_DAY).toBe(20);
    expect(serviceHoursForLine('metro', 'm1')).toBe(DEFAULT_SERVICE_HOURS_PER_DAY);
    expect(serviceHoursForLine('bus', '66')).toBe(DEFAULT_SERVICE_HOURS_PER_DAY);
  });
});

// ---------------------------------------------------------------------------
// computeDisruptionMinutes
// ---------------------------------------------------------------------------
describe('computeDisruptionMinutes', () => {
  it('sums a single span and computes the service-time denominator', () => {
    const out = computeDisruptionMinutes([], [obs({ ts: NOW - HOUR, resolved_ts: NOW })], {
      now: NOW,
      windowDays: 30,
      lines: [{ kind: 'metro', line: 'l1' }],
    });
    expect(out.disruptedMinutes).toBe(60);
    // L1 runs the default 20h service day.
    expect(out.serviceMinutes).toBe(20 * 30 * 60);
    expect(out.ratio).toBeCloseTo(60 / (20 * 30 * 60), 6);
  });

  it('unions overlapping spans on the same line instead of double-counting', () => {
    const out = computeDisruptionMinutes(
      [],
      [
        obs({ id: 1, ts: NOW - 60 * MIN, resolved_ts: NOW - 30 * MIN }),
        obs({ id: 2, ts: NOW - 40 * MIN, resolved_ts: NOW - 10 * MIN }),
      ],
      { now: NOW, windowDays: 30, lines: [{ kind: 'metro', line: 'l1' }] },
    );
    // Union of [-60,-30] and [-40,-10] is [-60,-10] = 50 minutes.
    expect(out.disruptedMinutes).toBe(50);
  });

  it('only counts in-scope routes for a multi-route alert', () => {
    const multi = alert({ routes: ['l1', 'b1'], first_seen_ts: NOW - HOUR, resolved_ts: NOW });
    const scoped = computeDisruptionMinutes([multi], [], {
      now: NOW,
      windowDays: 30,
      lines: [{ kind: 'metro', line: 'l1' }],
    });
    expect(scoped.disruptedMinutes).toBe(60);
  });

  it('clamps spans to the window', () => {
    const out = computeDisruptionMinutes([], [obs({ ts: NOW - 40 * DAY, resolved_ts: NOW })], {
      now: NOW,
      windowDays: 30,
      lines: [{ kind: 'metro', line: 'l1' }],
    });
    // Only the last 30 days of the 40-day span count toward the numerator.
    expect(out.disruptedMinutes).toBe(30 * 24 * 60);
  });
});

// ---------------------------------------------------------------------------
// computeRecentBurst
// ---------------------------------------------------------------------------
describe('computeRecentBurst', () => {
  it('counts incidents in the recent window and scales the baseline', () => {
    const out = computeRecentBurst(
      [],
      [
        obs({ id: 1, ts: NOW - 1 * HOUR }),
        obs({ id: 2, ts: NOW - 2 * HOUR }),
        obs({ id: 3, ts: NOW - 10 * DAY }),
      ],
      { now: NOW, windowHours: 3, baselineDays: 30 },
    );
    expect(out.recentCount).toBe(2);
    expect(out.windowHours).toBe(3);
    expect(out.ratio).toBeGreaterThan(0);
  });

  it('returns a null ratio when there is no baseline to compare against', () => {
    const out = computeRecentBurst([], [obs({ ts: NOW - 1 * HOUR })], {
      now: NOW,
      windowHours: 3,
      baselineDays: 30,
    });
    expect(out.recentCount).toBe(1);
    expect(out.ratio).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeDayOfWeekCounts
// ---------------------------------------------------------------------------
describe('computeDayOfWeekCounts', () => {
  it('returns a 7-element histogram and an honest week denominator', () => {
    const out = computeDayOfWeekCounts(
      [],
      [obs({ id: 1, ts: NOW }), obs({ id: 2, ts: NOW }), obs({ id: 3, ts: NOW })],
      { now: NOW, windowDays: 91 },
    );
    expect(out.counts).toHaveLength(7);
    expect(out.total).toBe(3);
    // All three share the same instant → one weekday bucket holds all of them.
    expect(out.maxCount).toBe(3);
    expect(out.numWeeks).toBe(13);
  });

  it('excludes incidents older than the window', () => {
    const out = computeDayOfWeekCounts([], [obs({ ts: NOW - 200 * DAY })], {
      now: NOW,
      windowDays: 91,
    });
    expect(out.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeWorstDay
// ---------------------------------------------------------------------------
describe('computeWorstDay', () => {
  it('returns the Chicago day with the most incident starts', () => {
    const out = computeWorstDay(
      [],
      [
        obs({ id: 1, ts: NOW }),
        obs({ id: 2, ts: NOW - 30 * MIN }),
        obs({ id: 3, ts: NOW - 2 * DAY }),
      ],
      { now: NOW, windowDays: 90 },
    );
    expect(out.count).toBe(2);
    expect(out.dayUtc).toBe(phillyDayUTC(NOW));
  });

  it('returns null when there are no incidents in the window', () => {
    expect(computeWorstDay([], [], { now: NOW })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeSegmentRecurrence
// ---------------------------------------------------------------------------
describe('computeSegmentRecurrence', () => {
  const seg = (over = {}) =>
    obs({ from_station: 'Belmont', to_station: 'Fullerton', detection_source: 'gap', ...over });

  it('ranks repeated station-to-station segments above the minimum count', () => {
    const out = computeSegmentRecurrence(
      [
        seg({ id: 1, ts: NOW - 1 * DAY }),
        seg({ id: 2, ts: NOW - 2 * DAY }),
        // A different segment that only appears once → below minCount.
        seg({ id: 3, from_station: 'Clark', to_station: 'Division', ts: NOW - 1 * DAY }),
      ],
      { now: NOW, windowDays: 90, minCount: 2 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      line: 'l1',
      fromStation: 'Belmont',
      toStation: 'Fullerton',
      count: 2,
    });
  });

  it('ignores roundup observations and respects the line filter', () => {
    const out = computeSegmentRecurrence(
      [
        seg({ id: 1, ts: NOW - 1 * DAY }),
        seg({ id: 2, ts: NOW - 2 * DAY, detection_source: 'roundup' }),
        seg({ id: 3, line: 'b1', ts: NOW - 1 * DAY }),
      ],
      { now: NOW, windowDays: 90, minCount: 1, lineFilter: 'l1' },
    );
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(1);
    expect(out[0].line).toBe('l1');
  });
});

// ---------------------------------------------------------------------------
// computeCohortDurationStats
// ---------------------------------------------------------------------------
describe('computeCohortDurationStats', () => {
  // Peers share kind/line/detection_source so they bucket together.
  const peer = (id, durMin) =>
    obs({
      id,
      detection_source: 'gap',
      ts: NOW - 1 * DAY,
      resolved_ts: NOW - 1 * DAY + durMin * MIN,
    });

  it('returns the cohort median/p90 and this incident’s duration', () => {
    const target = {
      kind: 'metro',
      line: 'l1',
      detection_source: 'gap',
      post_url: 'https://bsky.app/profile/x/post/self',
      first_seen_ts: NOW - 2 * HOUR,
      resolved_ts: NOW - 2 * HOUR + 40 * MIN,
    };
    const peers = [peer(11, 10), peer(12, 20), peer(13, 30), peer(14, 40), peer(15, 50)];
    const out = computeCohortDurationStats(target, [], peers, {
      now: NOW,
      windowDays: 90,
      minCohort: 5,
    });
    expect(out.count).toBe(5);
    expect(out.medianMs).toBe(30 * MIN);
    expect(out.maxMs).toBe(50 * MIN);
    expect(out.thisMs).toBe(40 * MIN);
  });

  it('returns null when the cohort is below the minimum size', () => {
    const target = { kind: 'metro', line: 'l1', detection_source: 'gap' };
    const out = computeCohortDurationStats(target, [], [peer(11, 10), peer(12, 20)], {
      now: NOW,
      minCohort: 5,
    });
    expect(out).toBeNull();
  });

  it('returns null for an incident with no signal to bucket on', () => {
    const transitOnly = { kind: 'metro', line: 'l1' }; // no detection_source
    expect(computeCohortDurationStats(transitOnly, [], [], { now: NOW })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeRestorationDeltas
// ---------------------------------------------------------------------------
describe('computeRestorationDeltas', () => {
  // An alert + observation sharing an _incidentId merge into one record that
  // carries both resolution timestamps.
  const pair = ({ alertResolved, obsTs, obsResolved, id = 'r1', rkey = 'aaa' }) => ({
    alert: alert({
      _incidentId: id,
      post_url: `https://bsky.app/profile/x/post/${rkey}`,
      first_seen_ts: NOW - 60 * MIN,
      resolved_ts: alertResolved,
      active: false,
    }),
    obs: obs({
      _incidentId: id,
      post_url: `https://bsky.app/profile/x/post/${rkey}-obs`,
      ts: obsTs,
      resolved_ts: obsResolved,
      active: false,
    }),
  });

  it('flags CTA clearing late (after service recovered)', () => {
    const { alert: a, obs: o } = pair({
      alertResolved: NOW,
      obsTs: NOW - 58 * MIN,
      obsResolved: NOW - 20 * MIN,
    });
    const out = computeRestorationDeltas([a], [o], { now: NOW, windowDays: 90 });
    expect(out.matchedCount).toBe(1);
    expect(out.agencyClearedLate).toHaveLength(1);
    expect(out.agencyClearedEarly).toHaveLength(0);
    expect(out.agencyClearedLate[0].deltaMs).toBe(20 * MIN);
  });

  it('flags CTA clearing early (before service recovered)', () => {
    const { alert: a, obs: o } = pair({
      alertResolved: NOW - 30 * MIN,
      obsTs: NOW - 58 * MIN,
      obsResolved: NOW - 10 * MIN,
    });
    const out = computeRestorationDeltas([a], [o], { now: NOW, windowDays: 90 });
    expect(out.agencyClearedEarly).toHaveLength(1);
    expect(out.agencyClearedEarly[0].deltaMs).toBe(-20 * MIN);
  });

  it('drops pairs whose observation barely overlaps the alert span', () => {
    // Obs covers only a sliver of a long alert → not a meaningful comparison.
    const a = alert({
      _incidentId: 'r2',
      post_url: 'https://bsky.app/profile/x/post/bbb',
      first_seen_ts: NOW - 10 * DAY,
      resolved_ts: NOW,
      active: false,
    });
    const o = obs({
      _incidentId: 'r2',
      ts: NOW - 30 * MIN,
      resolved_ts: NOW - 10 * MIN,
      active: false,
    });
    const out = computeRestorationDeltas([a], [o], { now: NOW, windowDays: 90 });
    expect(out.matchedCount).toBe(0);
  });

  it('drops sub-threshold deltas', () => {
    const { alert: a, obs: o } = pair({
      alertResolved: NOW,
      obsTs: NOW - 58 * MIN,
      obsResolved: NOW - 2 * MIN, // only 2 min delta, below the 5-min floor
    });
    const out = computeRestorationDeltas([a], [o], { now: NOW, windowDays: 90 });
    expect(out.matchedCount).toBe(0);
  });

  it('excludes Metra incidents (CTA-only concept)', () => {
    const { alert: a, obs: o } = pair({
      alertResolved: NOW,
      obsTs: NOW - 58 * MIN,
      obsResolved: NOW - 20 * MIN,
    });
    a.kind = 'rail';
    a.routes = ['nor'];
    o.kind = 'rail';
    o.line = 'nor';
    const out = computeRestorationDeltas([a], [o], { now: NOW, windowDays: 90 });
    expect(out.matchedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeRailLeaderboards
// ---------------------------------------------------------------------------
describe('computeRailLeaderboards', () => {
  const mObs = (over = {}) =>
    obs({ kind: 'rail', line: 'nor', detection_source: 'delay', ...over });

  it('tallies cancellations and delays per line', () => {
    const observations = [
      mObs({ id: 1, line: 'nor', detection_source: 'delay' }),
      mObs({ id: 2, line: 'nor', detection_source: 'delay' }),
      mObs({ id: 3, line: 'nor', detection_source: 'cancellation' }),
      mObs({ id: 4, line: 'pao', detection_source: 'cancellation-inferred' }),
      // Non-rail and unrelated sources are ignored.
      obs({ id: 5, kind: 'metro', line: 'l1', detection_source: 'ghost' }),
    ];
    const out = computeRailLeaderboards([], observations, { now: NOW, windowDays: 90 });
    expect(out.delayTotal).toBe(2);
    expect(out.cancellationTotal).toBe(2); // 1 confirmed + 1 inferred
    expect(out.topDelayed).toEqual({ line: 'nor', delays: 2, cancellations: 1, total: 3 });
    // nor and pao each have 1 cancellation → tie broken alphabetically (nor first).
    expect(out.topCancelled.line).toBe('nor');
    expect(out.hasData).toBe(true);
  });

  it('counts Regional Rail alerts separately', () => {
    const alerts = [alert({ kind: 'rail', routes: ['war'], first_seen_ts: NOW - HOUR })];
    const out = computeRailLeaderboards(alerts, [], { now: NOW, windowDays: 90 });
    expect(out.alertsCount).toBe(1);
    expect(out.byLine).toEqual([]);
    expect(out.hasData).toBe(true);
  });

  it('reports no data when nothing Metra is in window', () => {
    const stale = [mObs({ id: 1, ts: NOW - 120 * DAY, resolved_ts: NOW - 120 * DAY })];
    const out = computeRailLeaderboards([], stale, { now: NOW, windowDays: 90 });
    expect(out.hasData).toBe(false);
    expect(out.topCancelled).toBeNull();
    expect(out.topDelayed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeRailStatusCounts
// ---------------------------------------------------------------------------
describe('computeRailStatusCounts', () => {
  const railIncident = (over = {}) =>
    incident({
      id: 'm1',
      kind: 'rail',
      routes: ['wtr'],
      first_seen_ts: NOW - HOUR,
      resolved_ts: NOW,
      active: false,
      cta: null,
      observations: [],
      ...over,
    });

  it('counts bot delay and cancellation observations for a line', () => {
    const out = computeRailStatusCounts(
      [
        railIncident({
          observations: [
            { id: 'd1', kind: 'rail', line: 'wtr', detection_source: 'delay', ts: NOW - HOUR },
            {
              id: 'c1',
              kind: 'rail',
              line: 'wtr',
              detection_source: 'cancellation-inferred',
              ts: NOW - HOUR,
            },
            { id: 'd2', kind: 'rail', line: 'lan', detection_source: 'delay', ts: NOW - HOUR },
          ],
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out).toEqual({ cancellations: 1, delays: 1, total: 2 });
  });

  it('counts official-only Metra alert status once', () => {
    const out = computeRailStatusCounts(
      [
        railIncident({
          cta: { headline: 'ME train #121 delayed' },
          rail_status: { source: 'delay', train_number: '121' },
        }),
        railIncident({
          id: 'm2',
          cta: { headline: 'ME train #123 will not operate' },
          rail_status: { source: 'cancellation', train_number: '123' },
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out).toEqual({ cancellations: 1, delays: 1, total: 2 });
  });

  it('does not count planned-work Metra delay advisories as late trains', () => {
    const out = computeRailStatusCounts(
      [
        railIncident({
          cta: {
            headline: 'Track Construction Saturday, June 13 through Sunday, June 14',
            short_description:
              'Track construction will be taking place on Saturday, June 13 through Sunday, June 14. Trains may incur delays enroute up to 20 minutes behind scheduled passing through the work zone.',
          },
          rail_status: { source: 'planned-delay', train_number: null },
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out).toEqual({ cancellations: 0, delays: 0, total: 0 });
  });

  it('does not double-count merged official and bot status', () => {
    const out = computeRailStatusCounts(
      [
        railIncident({
          cta: { headline: 'ME train #121 delayed' },
          rail_status: { source: 'delay', train_number: '121' },
          observations: [
            { id: 'd1', kind: 'rail', line: 'wtr', detection_source: 'delay', ts: NOW - HOUR },
          ],
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out).toEqual({ cancellations: 0, delays: 1, total: 1 });
  });

  it('excludes stale official and bot statuses', () => {
    const old = NOW - 120 * DAY;
    const out = computeRailStatusCounts(
      [
        railIncident({
          first_seen_ts: old,
          cta: { headline: 'ME train #121 delayed' },
          rail_status: { source: 'delay', train_number: '121' },
        }),
        railIncident({
          observations: [
            { id: 'd1', kind: 'rail', line: 'wtr', detection_source: 'delay', ts: old },
          ],
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out).toEqual({ cancellations: 0, delays: 0, total: 0 });
  });
});

// ---------------------------------------------------------------------------
// computeRailCancellationDelayStats
// ---------------------------------------------------------------------------
describe('computeRailCancellationDelayStats', () => {
  const railIncident = (over = {}) =>
    incident({
      id: 'm1',
      kind: 'rail',
      routes: ['wtr'],
      first_seen_ts: NOW - HOUR,
      resolved_ts: NOW,
      active: false,
      cta: null,
      observations: [],
      ...over,
    });
  const cancelObs = ({ id = 'c', depTs = NOW - DAY, origin = 'Chicago Union' } = {}) => ({
    id,
    kind: 'rail',
    line: 'wtr',
    detection_source: 'cancellation',
    ts: depTs,
    onset_ts: depTs,
    from_station: origin,
  });
  const delayObs = ({ id = 'd', ts = NOW - DAY } = {}) => ({
    id,
    kind: 'rail',
    line: 'wtr',
    detection_source: 'delay',
    ts,
  });

  it('counts cancellations (incl. inferred) and delays with per-week rates', () => {
    const out = computeRailCancellationDelayStats(
      [
        railIncident({
          id: 'm1',
          observations: [
            cancelObs({ id: 'c1', depTs: NOW - DAY }),
            {
              ...delayObs({ id: 'd1' }),
              detection_source: 'cancellation-inferred',
              onset_ts: NOW - 2 * DAY,
            },
          ],
        }),
        railIncident({ id: 'm2', observations: [delayObs({ id: 'd2' }), delayObs({ id: 'd3' })] }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out.cancellations.count).toBe(2);
    expect(out.delays.count).toBe(2);
    expect(out.total).toBe(4);
    expect(out.cancellations.perWeek).toBeCloseTo(2 / (90 / 7), 5);
    expect(out.delays.perWeek).toBeCloseTo(2 / (90 / 7), 5);
  });

  it('breaks cancellations down by origin terminal, busiest first', () => {
    const out = computeRailCancellationDelayStats(
      [
        railIncident({
          observations: [
            cancelObs({ id: 'c1', origin: 'Chicago Union', depTs: NOW - DAY }),
            cancelObs({ id: 'c2', origin: 'Chicago Union', depTs: NOW - 2 * DAY }),
            cancelObs({ id: 'c3', origin: 'Aurora', depTs: NOW - 3 * DAY }),
          ],
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out.cancellations.byOrigin).toEqual([
      { origin: 'Chicago Union', count: 2 },
      { origin: 'Aurora', count: 1 },
    ]);
    const partTotal = out.cancellations.byPartOfDay.reduce((s, p) => s + p.count, 0);
    expect(partTotal).toBe(out.cancellations.count);
  });

  it('reports recency of the most recent cancelled departure in hours', () => {
    const out = computeRailCancellationDelayStats(
      [railIncident({ observations: [cancelObs({ depTs: NOW - 5 * HOUR })] })],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out.cancellations.hoursSinceLast).toBe(5);
  });

  it('excludes planned-delay advisories', () => {
    const out = computeRailCancellationDelayStats(
      [
        railIncident({
          cta: { headline: 'Track work this weekend' },
          rail_status: { source: 'planned-delay', train_number: null },
        }),
      ],
      { now: NOW, windowDays: 90, lineFilter: 'wtr' },
    );
    expect(out.total).toBe(0);
  });

  it('returns an empty, renderable shape with no Metra history', () => {
    const out = computeRailCancellationDelayStats([], {
      now: NOW,
      windowDays: 90,
      lineFilter: 'wtr',
    });
    expect(out.total).toBe(0);
    expect(out.cancellations.hoursSinceLast).toBeNull();
    expect(out.cancellations.byOrigin).toEqual([]);
    expect(out.delays.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildBusIncidentsByDay
// ---------------------------------------------------------------------------
describe('buildBusIncidentsByDay', () => {
  it('buckets bus incidents by day and ranks the top routes', () => {
    const busObs = (over) => obs({ kind: 'bus', line: '66', from_station: null, ...over });
    const out = buildBusIncidentsByDay(
      [],
      [
        busObs({ id: 1, line: '66', ts: NOW, resolved_ts: NOW }),
        busObs({ id: 2, line: '66', ts: NOW - 1 * DAY, resolved_ts: NOW - 1 * DAY }),
        busObs({ id: 3, line: '9', ts: NOW, resolved_ts: NOW }),
      ],
      90,
      NOW,
    );
    expect(out.topRoutes).toContain('66');
    expect(out.byRoute['66'][0]).toBe(1); // one incident today on the 66
    expect(out.aggregate[0]).toBe(2); // two distinct routes had an incident today
  });

  it('ignores train incidents', () => {
    const out = buildBusIncidentsByDay([], [obs({ kind: 'metro', line: 'l1' })], 90, NOW);
    expect(out.topRoutes).toHaveLength(0);
    expect(Object.keys(out.byRoute)).toHaveLength(0);
  });
});
