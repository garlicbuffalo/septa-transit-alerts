import { describe, expect, it } from 'vitest';
import {
  currentlyOut,
  groupOutagesByStation,
  outageDuration,
  outageHasLine,
  outagesForLine,
  outagesForStation,
  stationHref,
  stationReliability,
  summarizeOutages,
} from '../lib/accessibility.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const outage = (over = {}) => ({
  id: 'cta-1',
  agency: 'cta',
  station: { slug: 'belmont-red-brown-purple', name: 'Belmont', lines: ['red', 'brn', 'p'] },
  unit_type: 'elevator',
  unit_label: 'to platform',
  lifecycle: {
    first_seen_ts: NOW - 2 * HOUR,
    last_seen_ts: NOW - HOUR,
    restored_ts: null,
    active: true,
  },
  ...over,
});

describe('accessibility helpers', () => {
  it('builds CTA and Metra station links', () => {
    expect(stationHref(outage())).toBe('/station/belmont-red-brown-purple');
    expect(
      stationHref(
        outage({ agency: 'rail', station: { slug: 'aurora', name: 'Aurora', lines: ['bnsf'] } }),
      ),
    ).toBe('/rail/station/aurora');
  });

  it('matches CTA line aliases when filtering outages', () => {
    const row = outage();
    expect(outageHasLine(row, 'brown')).toBe(true);
    expect(outageHasLine(row, 'brn')).toBe(true);
    expect(outageHasLine(row, 'blue')).toBe(false);
  });

  it('sorts active outages by current duration', () => {
    const rows = [
      outage({ id: 'cta-short', lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - HOUR } }),
      outage({
        id: 'cta-long',
        lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - 3 * HOUR },
      }),
    ];
    expect(currentlyOut(rows, { now: NOW }).map((o) => o.id)).toEqual(['cta-long', 'cta-short']);
    expect(outageDuration(rows[0], NOW)).toBe(HOUR);
  });

  it('finds station-specific rows and reliability totals', () => {
    const restored = outage({
      id: 'cta-restored',
      lifecycle: {
        first_seen_ts: NOW - 4 * HOUR,
        last_seen_ts: NOW - 3 * HOUR,
        restored_ts: NOW - 3 * HOUR,
        active: false,
      },
    });
    const rows = [outage(), restored];
    expect(
      outagesForStation(rows, { agency: 'cta', slug: 'belmont-red-brown-purple', now: NOW }),
    ).toHaveLength(2);
    const [station] = stationReliability(rows, { agency: 'cta', now: NOW });
    expect(station).toMatchObject({
      agency: 'cta',
      slug: 'belmont-red-brown-purple',
      outageCount: 2,
      currentlyOut: 1,
    });
  });

  it('summarizes active outages by station and agency', () => {
    const rows = [
      outage(),
      outage({ id: 'cta-2' }),
      outage({
        id: 'metra-1',
        agency: 'rail',
        station: { slug: 'aurora', name: 'Aurora', lines: ['bnsf'] },
      }),
    ];
    // two outages share the Belmont station, so it counts once.
    expect(summarizeOutages(rows)).toEqual({ total: 3, stations: 2, cta: 2, rail: 1 });
  });

  it('collapses multiple units at one station into a single group', () => {
    const rows = [
      outage({ id: 'cta-1', unit_label: 'to platform' }),
      outage({ id: 'cta-2', unit_label: 'to street' }),
      outage({
        id: 'cta-blue',
        station: { slug: 'clark-lake', name: 'Clark/Lake', lines: ['blue'] },
      }),
    ];
    const groups = groupOutagesByStation(rows);
    expect(groups.map((g) => g.key)).toEqual(['cta:belmont-red-brown-purple', 'cta:clark-lake']);
    expect(groups[0]).toMatchObject({
      agency: 'cta',
      name: 'Belmont',
      slug: 'belmont-red-brown-purple',
      lines: ['red', 'brn', 'p'],
    });
    expect(groups[0].outages.map((o) => o.id)).toEqual(['cta-1', 'cta-2']);
  });

  it('keeps stations in input order so the longest-out station leads', () => {
    const rows = currentlyOut(
      [
        outage({
          id: 'short',
          station: { slug: 'a', name: 'A', lines: ['red'] },
          lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - HOUR },
        }),
        outage({
          id: 'long',
          station: { slug: 'b', name: 'B', lines: ['blue'] },
          lifecycle: { ...outage().lifecycle, first_seen_ts: NOW - 5 * HOUR },
        }),
      ],
      { now: NOW },
    );
    expect(groupOutagesByStation(rows).map((g) => g.name)).toEqual(['B', 'A']);
  });

  it('finds line-specific rows with active rows first', () => {
    const restored = outage({
      id: 'cta-restored',
      lifecycle: {
        first_seen_ts: NOW - 4 * HOUR,
        last_seen_ts: NOW - 3 * HOUR,
        restored_ts: NOW - 3 * HOUR,
        active: false,
      },
    });
    const blue = outage({
      id: 'cta-blue',
      station: { slug: 'clark-lake', name: 'Clark/Lake', lines: ['blue'] },
    });
    const rows = outagesForLine([restored, blue, outage()], {
      agency: 'cta',
      line: 'brown',
      now: NOW,
    });
    expect(rows.map((row) => row.id)).toEqual(['cta-1', 'cta-restored']);
  });
});
