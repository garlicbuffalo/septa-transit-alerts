import { describe, expect, it } from 'vitest';
import {
  currentlyOut,
  groupOutagesByStation,
  outageDuration,
  outageHasLine,
  outageKind,
  outagesForLine,
  outagesForStation,
  stationHref,
  stationReliability,
  summarizeOutages,
} from '../lib/accessibility.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const outage = (over = {}) => ({
  id: 'metro-1',
  agency: 'septa',
  mode: 'metro',
  station: { slug: '8th-market', name: '8th-Market', lines: ['l1', 'b3'] },
  unit_type: 'elevator',
  unit_label: 'Eastbound',
  lifecycle: {
    first_seen_ts: NOW - 2 * HOUR,
    last_seen_ts: NOW - HOUR,
    restored_ts: null,
    active: true,
  },
  ...over,
});

const railOutage = (over = {}) =>
  outage({
    id: 'rail-1',
    mode: 'regional_rail',
    station: { slug: 'suburban-station', name: 'Suburban Station', lines: ['pao', 'wtr'] },
    ...over,
  });

describe('accessibility helpers', () => {
  it('maps the wire mode to a station network', () => {
    expect(outageKind(outage())).toBe('metro');
    expect(outageKind(railOutage())).toBe('rail');
  });

  it('builds SEPTA Metro and Regional Rail station links', () => {
    expect(stationHref(outage())).toBe('/station/8th-market');
    expect(stationHref(railOutage())).toBe('/rail/station/suburban-station');
  });

  it('matches line keys case-insensitively when filtering outages', () => {
    const row = outage();
    expect(outageHasLine(row, 'b3')).toBe(true);
    expect(outageHasLine(row, 'B3')).toBe(true);
    expect(outageHasLine(row, 'b1')).toBe(false);
    expect(outageHasLine(railOutage(), 'PAO')).toBe(true);
  });

  it('sorts active outages by current duration', () => {
    const rows = [
      outage({ id: 'short', lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - HOUR } }),
      outage({
        id: 'long',
        lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - 3 * HOUR },
      }),
    ];
    expect(currentlyOut(rows, { now: NOW }).map((o) => o.id)).toEqual(['long', 'short']);
    expect(outageDuration(rows[0], NOW)).toBe(HOUR);
    expect(currentlyOut([...rows, railOutage()], { now: NOW, kind: 'rail' })).toHaveLength(1);
  });

  it('finds station-specific rows and reliability totals', () => {
    const restored = outage({
      id: 'metro-restored',
      lifecycle: {
        first_seen_ts: NOW - 4 * HOUR,
        last_seen_ts: NOW - 3 * HOUR,
        restored_ts: NOW - 3 * HOUR,
        active: false,
      },
    });
    const rows = [outage(), restored, railOutage()];
    expect(outagesForStation(rows, { kind: 'metro', slug: '8th-market', now: NOW })).toHaveLength(
      2,
    );
    // The same slug on the other network doesn't match.
    expect(outagesForStation(rows, { kind: 'rail', slug: '8th-market', now: NOW })).toHaveLength(0);
    const [station] = stationReliability(rows, { kind: 'metro', now: NOW });
    expect(station).toMatchObject({
      kind: 'metro',
      slug: '8th-market',
      outageCount: 2,
      currentlyOut: 1,
    });
  });

  it('summarizes active outages by station and network', () => {
    const rows = [outage(), outage({ id: 'metro-2' }), railOutage()];
    // Two outages share the 8th-Market station, so it counts once.
    expect(summarizeOutages(rows)).toEqual({ total: 3, stations: 2, metro: 2, rail: 1 });
  });

  it('collapses multiple units at one station into a single group', () => {
    const rows = [
      outage({ id: 'metro-1', unit_label: 'Eastbound' }),
      outage({ id: 'metro-2', unit_label: 'Westbound' }),
      outage({
        id: 'metro-15th',
        station: { slug: '15th-st', name: '15th St', lines: ['l1'] },
      }),
    ];
    const groups = groupOutagesByStation(rows);
    expect(groups.map((g) => g.key)).toEqual(['metro:8th-market', 'metro:15th-st']);
    expect(groups[0]).toMatchObject({
      kind: 'metro',
      name: '8th-Market',
      slug: '8th-market',
      lines: ['l1', 'b3'],
    });
    expect(groups[0].outages.map((o) => o.id)).toEqual(['metro-1', 'metro-2']);
  });

  it('keeps stations in input order so the longest-out station leads', () => {
    const rows = currentlyOut(
      [
        outage({
          id: 'short',
          station: { slug: 'a', name: 'A', lines: ['l1'] },
          lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - HOUR },
        }),
        outage({
          id: 'long',
          station: { slug: 'b', name: 'B', lines: ['b1'] },
          lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - 5 * HOUR },
        }),
      ],
      { now: NOW },
    );
    expect(groupOutagesByStation(rows).map((g) => g.name)).toEqual(['B', 'A']);
  });

  it('finds line-specific rows with active rows first', () => {
    const restored = outage({
      id: 'metro-restored',
      lifecycle: {
        first_seen_ts: NOW - 4 * HOUR,
        last_seen_ts: NOW - 3 * HOUR,
        restored_ts: NOW - 3 * HOUR,
        active: false,
      },
    });
    const l1Only = outage({
      id: 'metro-15th',
      station: { slug: '15th-st', name: '15th St', lines: ['l1'] },
    });
    const rows = outagesForLine([restored, l1Only, outage()], {
      kind: 'metro',
      line: 'b3',
      now: NOW,
    });
    expect(rows.map((row) => row.id)).toEqual(['metro-1', 'metro-restored']);
  });
});
