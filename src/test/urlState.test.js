import { describe, expect, it } from 'vitest';
import { buildSearch, parseUrlState } from '../lib/urlState.js';

describe('parseUrlState', () => {
  it('returns defaults when no params present', () => {
    expect(parseUrlState('')).toEqual({
      selectedLines: null,
      showBus: true,
      selectedBusRoutes: [],
      selectedRailLines: [],
      dateRange: 7,
      selectedDay: null,
      selectedSignals: [],
      selectedSources: ['official', 'bot', 'merged'],
      search: '',
      selectedNetwork: 'all',
    });
  });

  it('parses lines list', () => {
    expect(parseUrlState('?lines=l1,b1').selectedLines).toEqual(['l1', 'b1']);
  });

  it('parses lines=none as empty selection', () => {
    expect(parseUrlState('?lines=none').selectedLines).toEqual([]);
  });

  it('drops unknown line keys silently', () => {
    expect(parseUrlState('?lines=l1,fake,b1').selectedLines).toEqual(['l1', 'b1']);
  });

  it('falls back to default when every line key is invalid', () => {
    expect(parseUrlState('?lines=fake,bogus').selectedLines).toBeNull();
  });

  it('parses bus=0 as hidden', () => {
    expect(parseUrlState('?bus=0').showBus).toBe(false);
  });

  it('defaults showBus to false when narrowed to a positive train selection', () => {
    expect(parseUrlState('?lines=l1').showBus).toBe(false);
  });

  it('defaults showBus to true when lines=none (bus-only view)', () => {
    expect(parseUrlState('?lines=none').showBus).toBe(true);
  });

  it('honors explicit bus=1 override even when lines is narrowed', () => {
    expect(parseUrlState('?lines=l1&bus=1').showBus).toBe(true);
  });

  it('parses bus routes', () => {
    expect(parseUrlState('?routes=66,77').selectedBusRoutes).toEqual(['66', '77']);
  });

  it('keeps SEPTA route ids (K, LUCYGO, L1-OWL, 310), drops garbage', () => {
    expect(
      parseUrlState('?routes=17,K,LUCYGO,L1-OWL,310,../etc,none,-x,33').selectedBusRoutes,
    ).toEqual(['17', 'K', 'LUCYGO', 'L1-OWL', '310', '33']);
  });

  it('parses Regional Rail lines and drops invalid keys', () => {
    expect(parseUrlState('?rail=nor,pao').selectedRailLines).toEqual(['nor', 'pao']);
    expect(parseUrlState('?rail=NOR,fake').selectedRailLines).toEqual(['nor']);
    // A param with no valid line → no narrowing.
    expect(parseUrlState('?rail=1').selectedRailLines).toEqual([]);
  });

  it('parses range=all as null', () => {
    expect(parseUrlState('?range=all').dateRange).toBeNull();
  });

  it('parses numeric range', () => {
    expect(parseUrlState('?range=30').dateRange).toBe(30);
  });

  it('falls back when range is unknown', () => {
    expect(parseUrlState('?range=42').dateRange).toBe(7);
  });
});

describe('buildSearch', () => {
  it('returns empty string for default state', () => {
    expect(
      buildSearch({
        selectedLines: null,
        showBus: true,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('');
  });

  it('serializes selected lines (and the implicit bus=0 stays implicit)', () => {
    expect(
      buildSearch({
        selectedLines: ['l1', 'b1'],
        showBus: false,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('?lines=l1%2Cb1');
  });

  it('serializes empty line selection as none', () => {
    expect(
      buildSearch({
        selectedLines: [],
        showBus: true,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('?lines=none');
  });

  it('serializes bus hidden against the all-trains default', () => {
    expect(
      buildSearch({
        selectedLines: null,
        showBus: false,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('?bus=0');
  });

  it('omits bus param when showBus matches the narrowed-train default (false)', () => {
    expect(
      buildSearch({
        selectedLines: ['l1'],
        showBus: false,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('?lines=l1');
  });

  it('emits bus=1 when user overrides the narrowed-train default', () => {
    expect(
      buildSearch({
        selectedLines: ['l1'],
        showBus: true,
        selectedBusRoutes: [],
        dateRange: 7,
      }),
    ).toBe('?lines=l1&bus=1');
  });

  it('serializes bus routes', () => {
    expect(
      buildSearch({
        selectedLines: null,
        showBus: true,
        selectedBusRoutes: ['66', '77'],
        dateRange: 7,
      }),
    ).toBe('?routes=66%2C77');
  });

  it('serializes non-default range', () => {
    expect(
      buildSearch({
        selectedLines: null,
        showBus: true,
        selectedBusRoutes: [],
        dateRange: 30,
      }),
    ).toBe('?range=30');
  });

  it('serializes range=all', () => {
    expect(
      buildSearch({
        selectedLines: null,
        showBus: true,
        selectedBusRoutes: [],
        dateRange: null,
      }),
    ).toBe('?range=all');
  });

  it('round-trips a complex state', () => {
    const state = {
      selectedLines: ['l1'],
      showBus: false,
      selectedBusRoutes: ['66'],
      selectedRailLines: ['nor', 'pao'],
      dateRange: 30,
      selectedDay: null,
      selectedSignals: [],
      selectedSources: ['official', 'bot', 'merged'],
      search: '',
      selectedNetwork: 'all',
    };
    expect(parseUrlState(buildSearch(state))).toEqual(state);
  });

  it('round-trips a pinned day', () => {
    const dayUtc = Date.UTC(2026, 4, 6); // 2026-05-06
    const state = {
      selectedLines: null,
      showBus: true,
      selectedBusRoutes: [],
      selectedRailLines: [],
      dateRange: 7,
      selectedDay: dayUtc,
      selectedSignals: [],
      selectedSources: ['official', 'bot', 'merged'],
      search: '',
      selectedNetwork: 'all',
    };
    const search = buildSearch(state);
    expect(search).toBe('?day=2026-05-06');
    expect(parseUrlState(search)).toEqual(state);
  });

  it('drops malformed day param silently', () => {
    expect(parseUrlState('?day=not-a-date').selectedDay).toBeNull();
    expect(parseUrlState('?day=2026-13-01').selectedDay).toBeNull(); // month out of range
    expect(parseUrlState('?day=2026-02-30').selectedDay).toBeNull(); // overflow rejected
  });
});
