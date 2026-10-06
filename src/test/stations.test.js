import { describe, expect, it } from 'vitest';
import { buildStationIndex, slugifyStation } from '../lib/stations.js';

const NOW = 1_000_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const makeObs = (overrides = {}) => ({
  id: 1,
  kind: 'metro',
  line: 'red',
  from_station: 'Howard',
  to_station: 'Jarvis',
  ts: NOW - DAY,
  resolved_ts: NOW - DAY + 10 * 60_000,
  active: false,
  ...overrides,
});

const makeAlert = (overrides = {}) => ({
  alert_id: 1,
  kind: 'metro',
  routes: ['red'],
  affected_from_station: 'Howard',
  affected_to_station: null,
  first_seen_ts: NOW - DAY,
  resolved_ts: NOW - DAY + 60_000,
  active: false,
  ...overrides,
});

describe('slugifyStation', () => {
  it('lowercases and dashifies', () => {
    expect(slugifyStation('Howard')).toBe('howard');
    expect(slugifyStation('Clark/Division')).toBe('clark-division');
    expect(slugifyStation("O'Hare")).toBe('o-hare');
  });

  it('handles parenthetical line qualifiers', () => {
    expect(slugifyStation('Central (Green)')).toBe('central-green');
    expect(slugifyStation('Western (Brown)')).toBe('western-brown');
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
    const o = makeObs({ from_station: 'Howard', to_station: 'Jarvis' });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.has('howard')).toBe(true);
    expect(r.has('jarvis')).toBe(true);
  });

  it('includes every line that physically serves the station, not just lines with recent incidents', () => {
    // Howard serves Purple + Red + Yellow per the master roster. A station
    // page that only had a Pink (sorry, Red) incident in the window should
    // still surface Purple and Yellow pills so visitors see the full
    // line context — this is the Ashland (Green/Pink) bug class.
    const obs = [makeObs({ id: 1, line: 'red' })];
    const r = buildStationIndex([], obs, { now: NOW });
    // Sorted in CTA canonical order: red, brown, green, orange, pink, purple, yellow.
    // Howard's served set after normalization: red, purple, yellow.
    expect(r.get('howard').lines).toEqual(['red', 'purple', 'yellow']);
  });

  it('normalizes raw short-code line keys so they merge with the master roster', () => {
    // A hand-built record passes `line: 'p'` (raw CTA short code). The index
    // should not end up with both `'p'` and `'purple'` as distinct entries.
    const r = buildStationIndex([], [makeObs({ line: 'p' })], { now: NOW });
    expect(r.get('howard').lines).not.toContain('p');
    expect(r.get('howard').lines).toContain('purple');
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
    const o = makeObs({ from_station: 'Howard', to_station: null });
    const a = makeAlert({ affected_from_station: 'Howard' });
    const r = buildStationIndex([a], [o], { now: NOW });
    expect(r.get('howard').count).toBe(2);
  });

  it('does not double-count an observation that touches a station at both endpoints', () => {
    // Same name in both endpoints is contrived but the dedup guard is real.
    const o = makeObs({ from_station: 'Howard', to_station: 'Howard' });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('howard').count).toBe(1);
  });

  it('indexes alert mentioned_stations alongside the segment endpoints', () => {
    // The Monroe sick-customer alert names a single station ("delays at
    // Monroe") so it has no segment endpoints, only mentioned_stations.
    // Without indexing mentions, /station/monroe-red would show no CTA
    // alerts for this incident.
    const a = makeAlert({
      affected_from_station: null,
      affected_to_station: null,
      mentioned_stations: ['Monroe (Red)'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('monroe-red').alerts).toContain(a);
  });

  it('mentioned_stations dedupes against the segment endpoints', () => {
    // Upstream extractor includes between/from-to results in
    // mentioned_stations too — overlap shouldn't double-count.
    const a = makeAlert({
      affected_from_station: 'Howard',
      affected_to_station: null,
      mentioned_stations: ['Howard'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('howard').alerts).toHaveLength(1);
  });

  it('ties an observation to inner stops via the enumerated stations fill', () => {
    // Rockwell → Montrose on the Brown Line: the inner Western/Damen stops must
    // tie to the incident, not just the two named endpoints.
    const o = makeObs({
      line: 'brn',
      from_station: 'Rockwell',
      to_station: 'Montrose (Brown)',
      stations: ['Rockwell', 'Western (Brown)', 'Damen (Brown)', 'Montrose (Brown)'],
    });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('western-brown').observations).toContain(o);
    expect(r.get('damen-brown').observations).toContain(o);
    expect(r.get('rockwell').observations).toContain(o);
    expect(r.get('montrose-brown').observations).toContain(o);
  });

  it('falls back to from/to when an observation has no stations fill', () => {
    const o = makeObs({ from_station: 'Howard', to_station: 'Jarvis', stations: [] });
    const r = buildStationIndex([], [o], { now: NOW });
    expect(r.get('howard').observations).toContain(o);
    expect(r.get('jarvis').observations).toContain(o);
  });

  it('ties an alert to inner stops via affected_stations', () => {
    const a = makeAlert({
      routes: ['brn'],
      affected_from_station: 'Rockwell',
      affected_to_station: 'Montrose (Brown)',
      affected_stations: ['Rockwell', 'Western (Brown)', 'Damen (Brown)', 'Montrose (Brown)'],
    });
    const r = buildStationIndex([a], [], { now: NOW });
    expect(r.get('western-brown').alerts).toContain(a);
    expect(r.get('damen-brown').alerts).toContain(a);
  });
});
