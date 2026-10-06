import { describe, expect, it } from 'vitest';
import {
  buildEventSummaryText,
  computeAgencyEstimate,
  computeAgencyPlanned,
  computeBotLead,
  findIncidentNeighbors,
  formatLeadTime,
} from '../components/event/callouts.js';
import { incident } from './v2TestHelpers.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe('formatLeadTime', () => {
  it('formats sub-hour spans as minutes', () => {
    expect(formatLeadTime(5 * MIN)).toBe('5 min');
    expect(formatLeadTime(59 * MIN)).toBe('59 min');
  });

  it('formats whole and partial hours', () => {
    expect(formatLeadTime(2 * HOUR)).toBe('2h');
    expect(formatLeadTime(90 * MIN)).toBe('1h 30m');
  });
});

describe('computeBotLead', () => {
  it('reports how far the earliest observation predates the CTA post', () => {
    const out = computeBotLead({
      isMerged: true,
      agencyFirstSeenTs: NOW,
      observations: [{ ts: NOW - 5 * MIN }, { onset_ts: NOW - 20 * MIN, ts: NOW - 10 * MIN }],
    });
    expect(out).toEqual({ phrase: '20 min', onsetTs: NOW - 20 * MIN });
  });

  it('returns null under the 2-minute threshold', () => {
    expect(
      computeBotLead({
        isMerged: true,
        agencyFirstSeenTs: NOW,
        observations: [{ ts: NOW - 1 * MIN }],
      }),
    ).toBeNull();
  });

  it('returns null for non-merged incidents or missing CTA time', () => {
    expect(
      computeBotLead({ isMerged: false, agencyFirstSeenTs: NOW, observations: [] }),
    ).toBeNull();
    expect(
      computeBotLead({ isMerged: true, agencyFirstSeenTs: null, observations: [{ ts: NOW }] }),
    ).toBeNull();
  });
});

describe('computeAgencyPlanned', () => {
  it('returns null when CTA fired within 10 minutes (effectively live)', () => {
    expect(computeAgencyPlanned({ agencyStartTs: NOW - 5 * MIN, startTs: NOW })).toBeNull();
  });

  it('formats a minutes-ahead gap', () => {
    expect(computeAgencyPlanned({ agencyStartTs: NOW - 45 * MIN, startTs: NOW })).toBe(
      '45 min ahead',
    );
  });

  it('formats an hours-ahead gap', () => {
    expect(computeAgencyPlanned({ agencyStartTs: NOW - (2 * HOUR + 30 * MIN), startTs: NOW })).toBe(
      '2h 30m ahead',
    );
  });

  it('formats a days-ahead gap', () => {
    expect(computeAgencyPlanned({ agencyStartTs: NOW - (3 * DAY + 2 * HOUR), startTs: NOW })).toBe(
      '3d 2h ahead',
    );
  });

  it('returns null for a stale EventStart beyond 14 days', () => {
    expect(computeAgencyPlanned({ agencyStartTs: NOW - 20 * DAY, startTs: NOW })).toBeNull();
  });
});

describe('computeAgencyEstimate', () => {
  it('flags resolving after the stated end as "late"', () => {
    expect(
      computeAgencyEstimate({ agencyEndTs: NOW, resolvedTs: NOW + 20 * MIN, dateOnly: false }),
    ).toEqual({ sameMinute: false, phrase: '20 min late' });
  });

  it('flags resolving before the stated end as "early", with hour formatting', () => {
    expect(
      computeAgencyEstimate({
        agencyEndTs: NOW,
        resolvedTs: NOW - (1 * HOUR + 5 * MIN),
        dateOnly: false,
      }),
    ).toEqual({ sameMinute: false, phrase: '1h 5m early' });
  });

  it('reports "right on schedule" within the same minute', () => {
    expect(computeAgencyEstimate({ agencyEndTs: NOW, resolvedTs: NOW, dateOnly: false })).toEqual({
      sameMinute: true,
      phrase: 'cleared right on schedule',
    });
  });

  it('skips date-only EventEnd and gaps beyond a week', () => {
    expect(
      computeAgencyEstimate({ agencyEndTs: NOW, resolvedTs: NOW + 20 * MIN, dateOnly: true }),
    ).toBeNull();
    expect(
      computeAgencyEstimate({ agencyEndTs: NOW, resolvedTs: NOW + 8 * DAY, dateOnly: false }),
    ).toBeNull();
  });
});

describe('findIncidentNeighbors', () => {
  const incidents = [
    incident({ id: 'a', kind: 'metro', routes: ['b1'], first_seen_ts: NOW - 3 * HOUR }),
    incident({ id: 'b', kind: 'metro', routes: ['l1'], first_seen_ts: NOW - 2 * HOUR }),
    incident({ id: 'c', kind: 'metro', routes: ['b1'], first_seen_ts: NOW - 1 * HOUR }),
    incident({ id: 'd', kind: 'bus', routes: ['66'], first_seen_ts: NOW }),
  ];

  it('walks global chronological neighbors', () => {
    const { prev, next } = findIncidentNeighbors(incidents[1], incidents);
    expect(prev.id).toBe('a');
    expect(next.id).toBe('c');
  });

  it('restricts to the same route when asked', () => {
    const { prev, next } = findIncidentNeighbors(incidents[2], incidents, { sameRouteOnly: true });
    expect(prev.id).toBe('a'); // skips 'b' (red) and finds the prior blue
    expect(next).toBeNull(); // newest blue
  });

  it('returns nulls at the ends', () => {
    expect(findIncidentNeighbors(incidents[0], incidents).prev).toBeNull();
    expect(findIncidentNeighbors(incidents[3], incidents).next).toBeNull();
  });
});

describe('buildEventSummaryText', () => {
  it('assembles a multi-line summary for a resolved incident', () => {
    expect(
      buildEventSummaryText({
        description: 'Trains standing near Ashland',
        lineLabel: 'Orange Line',
        dateText: 'May 28, 2026',
        durationText: '59 min',
        active: false,
        url: 'https://chicagotransitalerts.app/event/abc',
      }),
    ).toBe(
      'Orange Line: Trains standing near Ashland\nMay 28, 2026 · lasted 59 min\nhttps://chicagotransitalerts.app/event/abc',
    );
  });

  it('marks an active incident ongoing and omits missing pieces', () => {
    expect(buildEventSummaryText({ description: 'Service disruption', active: true })).toBe(
      'Service disruption\nongoing',
    );
  });
});
