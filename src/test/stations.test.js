import { describe, expect, it } from 'vitest';
import { buildStationIndex, slugifyStation } from '../lib/stations.js';

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const makeObs = (overrides = {}) => ({
  id: 1,
  kind: 'metro',
  line: 'l1',
  from_station: 'Frankford Transit Center',
  to_station: 'Arrott Transit Center',
  ts: NOW - DAY,
  resolved_ts: NOW - DAY + 10 * 60_000,
  active: false,
  ...overrides,
});

const makeAlert = (overrides = {}) => ({
  alert_id: 1,
  kind: 'metro',
  routes: ['l1'],
  affected_from_station: 'Frankford Transit Center',
  affected_to_station: null,
  first_seen_ts: NOW - DAY,
  resolved_ts: NOW - DAY + 60_000,
  active: false,
  ...overrides,
});

describe('slugifyStation', () => {
  it('lowercases and dashifies', () => {
    expect(slugifyStation('Frankford Transit Center')).toBe('frankford-transit-center');
    expect(slugifyStation('15th St/City Hall')).toBe('15th-st-city-hall');
    expect(slugifyStation("St. Martin's")).toBe('st-martin-s');
  });

  it('keeps hyphenated intersection names readable', () => {
    expect(slugifyStation('8th-Market')).toBe('8th-market');
    expect(slugifyStation('York-Dauphin')).toBe('york-dauphin');
  });

  it('returns null for empty/null input', () => {
    expect(slugifyStation(null)).toBeNull();
    expect(slugifyStation('')).toBeNull();
    expect(slugifyStation('---')).toBeNull();
  });
});

describe('buildStationIndex', () => {
  it('returns an empty map for empty input', () => {
    const r = buildStationIndex([], [], { now: NOW });
    expect(r.size).toBe(0);
  });

  it('indexes both endpoints of an observation', () => {
    const o = makeObs();
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.has('frankford-transit-center')).toBe(true);
    expect(r.has('arrott-transit-center')).toBe(true);
  });

  it('includes every line that physically serves the station, not just lines with recent incidents', () => {
    // 8th-Market serves the L1 and the B3 (Broad-Ridge Spur) per the master
    // roster. A station page that only had an L1 incident in the window should
    // still surface the B3 pill so visitors see the full line context.
    const obs = [makeObs({ id: 1, line: 'l1', from_station: '8th-Market', to_station: null })];
    const r = buildStationIndex([], obs, { now: NOW });
    // Sorted in SEPTA Metro canonical order.
    expect(r.get('8th-market').lines).toEqual(['l1', 'b3']);
  });

  it('normalizes raw uppercase line keys so they merge with the master roster', () => {
    // A hand-built record passes `line: 'L1'` (SEPTA's GTFS route_id). The index
    // should not end up with both `'L1'` and `'l1'` as distinct entries.
    const r = buildStationIndex([], [makeObs({ line: 'L1' })], { now: NOW });
    expect(r.get('frankford-transit-center').lines).not.toContain('L1');
    expect(r.get('frankford-transit-center').lines).toContain('l1');
  });

  it('drops observations outside the rolling window', () => {
    const old = makeObs({ ts: NOW - 100 * DAY });
    const r = buildStationIndex([], [old], { now: NOW, windowDays: 90 });
    expect(r.size).toBe(0);
  });

  it('skips bus incidents', () => {
    const o = makeObs({ kind: 'bus', line: '66', from_station: 'Foo', to_station: 'Bar' });
    expect(buildStationIndex([], [o], { now: NOW }).size).toBe(0);
  });

  it('counts alerts and observations together at a station', () => {
    const o = makeObs({ to_station: null });
    const a = makeAlert();
    const r = buildStationIndex([a], [o], { now: NOW });
    expect(r.get('frankford-transit-center').count).toBe(2);
  });

  it('does not double-count an observation that touches a station at both endpoints', () => {
    // Same name in both endpoints is contrived but the dedup guard is real.
    const o = makeObs({ to_station: 'Frankford Transit Center' });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('frankford-transit-center').count).toBe(1);
  });

  it('indexes alert mentioned_stations alongside the segment endpoints', () => {
    // A single-station alert ("11th St Station Closed") has no segment
    // endpoints, only mentioned_stations. Without indexing mentions, the
    // station page would show no alerts for this incident.
    const a = makeAlert({
      affected_from_station: null,
      affected_to_station: null,
      mentioned_stations: ['13th St'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('13th-st').alerts).toContain(a);
  });

  it('mentioned_stations dedupes against the segment endpoints', () => {
    // The collector includes between/from-to results in mentioned_stations
    // too — overlap shouldn't double-count.
    const a = makeAlert({
      affected_to_station: null,
      mentioned_stations: ['Frankford Transit Center'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('frankford-transit-center').alerts).toHaveLength(1);
  });

  it('ties an observation to inner stops via the enumerated stations fill', () => {
    // Spring Garden → York-Dauphin on the L1: the inner Front-Girard/Berks stops
    // must tie to the incident, not just the two named endpoints.
    const o = makeObs({
      from_station: 'Spring Garden',
      to_station: 'York-Dauphin',
      stations: ['Spring Garden', 'Front-Girard', 'Berks', 'York-Dauphin'],
    });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('front-girard').observations).toContain(o);
    expect(r.get('berks').observations).toContain(o);
    expect(r.get('spring-garden').observations).toContain(o);
    expect(r.get('york-dauphin').observations).toContain(o);
  });

  it('falls back to from/to when an observation has no stations fill', () => {
    const o = makeObs({ stations: [] });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('frankford-transit-center').observations).toContain(o);
    expect(r.get('arrott-transit-center').observations).toContain(o);
  });

  it('ties an alert to inner stops via affected_stations', () => {
    const a = makeAlert({
      affected_from_station: 'Spring Garden',
      affected_to_station: 'York-Dauphin',
      affected_stations: ['Spring Garden', 'Front-Girard', 'Berks', 'York-Dauphin'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('front-girard').alerts).toContain(a);
    expect(r.get('berks').alerts).toContain(a);
  });
});
