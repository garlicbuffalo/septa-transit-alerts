import { describe, expect, it } from 'vitest';
import { findIncidentById, formatRoutesLabel, postUrlRkey } from '../lib/incidents.js';
import { incident } from './v2TestHelpers.js';

const ALERT_URL = 'https://bsky.app/profile/did:plc:abc/post/3ml5idb536d2c';
const OBS_URL = 'https://bsky.app/profile/did:plc:xyz/post/3mkuutqcneg2h';
const STANDALONE_OBS_URL = 'https://bsky.app/profile/did:plc:xyz/post/3mkomsa7xhv2i';

const NOW = 1_000_000_000_000;

// findIncidentById now reads the nested `incidents[]` wire shape directly: a
// top-level incident whose `id` is the canonical event rkey, with a nullable
// `cta` block and an `observations[]` list. A merged incident carries both; a
// bot-only incident has `cta: null`.
const mergedIncident = incident({
  id: '3ml5idb536d2c', // = alert post rkey
  kind: 'metro',
  routes: ['l1'],
  first_seen_ts: NOW - 60 * 60_000,
  resolved_ts: NOW - 30 * 60_000,
  active: false,
  sources: ['cta', 'bot'],
  cta: {
    alert_id: 'a1',
    headline: 'Red Line Delays',
    first_seen_ts: NOW - 60 * 60_000,
    resolved_ts: NOW - 30 * 60_000,
    active: false,
    post_url: ALERT_URL,
  },
  observations: [
    {
      id: 1,
      kind: 'metro',
      line: 'l1',
      ts: NOW - 55 * 60_000,
      resolved_ts: NOW - 30 * 60_000,
      active: false,
      post_url: OBS_URL,
    },
  ],
});

const botOnlyIncident = incident({
  id: '3mkomsa7xhv2i', // = obs post rkey
  kind: 'bus',
  routes: ['66'],
  first_seen_ts: NOW - 10 * 60_000,
  resolved_ts: null,
  active: true,
  sources: ['bot'],
  cta: null,
  observations: [
    {
      id: 2,
      kind: 'bus',
      line: '66',
      ts: NOW - 10 * 60_000,
      resolved_ts: null,
      active: true,
      post_url: STANDALONE_OBS_URL,
    },
  ],
});

describe('postUrlRkey', () => {
  it('extracts the rkey from a Bluesky post URL', () => {
    expect(postUrlRkey(ALERT_URL)).toBe('3ml5idb536d2c');
  });

  it('returns null for missing or malformed URLs', () => {
    expect(postUrlRkey(null)).toBeNull();
    expect(postUrlRkey(undefined)).toBeNull();
    expect(postUrlRkey('')).toBeNull();
    expect(postUrlRkey('https://bsky.app/profile/foo')).toBeNull();
  });

  it('stops at query strings and fragments', () => {
    expect(postUrlRkey(`${ALERT_URL}?utm=x`)).toBe('3ml5idb536d2c');
    expect(postUrlRkey(`${ALERT_URL}#anchor`)).toBe('3ml5idb536d2c');
  });
});

describe('findIncidentById', () => {
  const incidents = [mergedIncident, botOnlyIncident];

  it('finds a merged incident by its top-level id (alert post rkey)', () => {
    const found = findIncidentById(incidents, '3ml5idb536d2c');
    expect(found).not.toBeNull();
    expect(found.official_alert?.id).toBe('a1');
    expect(found.detections).toHaveLength(1);
  });

  it('finds a merged incident by one of its observation post rkeys', () => {
    const found = findIncidentById(incidents, '3mkuutqcneg2h');
    expect(found).not.toBeNull();
    expect(found.official_alert?.id).toBe('a1');
  });

  it('finds a bot-only incident by its observation post rkey', () => {
    const found = findIncidentById(incidents, '3mkomsa7xhv2i');
    expect(found).not.toBeNull();
    expect(found.official_alert).toBeNull();
    expect(found.detections[0].id).toBe(2);
  });

  it('finds a grouped incident by any official alert rkey alias', () => {
    const grouped = incident({
      id: 'canonical',
      kind: 'rail',
      routes: ['pao', 'med'],
      official_alerts: [
        { ...mergedIncident.official_alert, post_url: ALERT_URL },
        {
          ...mergedIncident.official_alert,
          id: 'child',
          post_url: 'https://bsky.app/profile/did:plc:abc/post/childrkey',
        },
      ],
    });
    expect(findIncidentById([grouped], 'childrkey')).toBe(grouped);
  });

  it('returns null for an unknown id', () => {
    expect(findIncidentById(incidents, 'nope')).toBeNull();
  });

  it('returns null for a falsy id', () => {
    expect(findIncidentById(incidents, '')).toBeNull();
    expect(findIncidentById(incidents, null)).toBeNull();
  });
});

describe('formatRoutesLabel', () => {
  it('single bus route uses the Route N form', () => {
    expect(formatRoutesLabel('bus', ['17'])).toBe('Route 17');
    expect(formatRoutesLabel('bus', ['L1-OWL'])).toBe('Route L1 OWL');
  });
  it('two bus routes joins with "and"', () => {
    expect(formatRoutesLabel('bus', ['17', '33'])).toBe('Routes 17 and 33');
  });
  it('three bus routes uses comma list', () => {
    expect(formatRoutesLabel('bus', ['17', '33', '48'])).toBe('Routes 17, 33, and 48');
  });
  it('four+ bus routes truncates with overflow count', () => {
    expect(formatRoutesLabel('bus', ['2', '3', '4', '7', '47'])).toBe('Routes 2, 3 + 3 more');
  });
  it('single Metro line uses its code and name', () => {
    expect(formatRoutesLabel('metro', ['l1'])).toBe('L1 Market-Frankford Line');
  });
  it('several Metro lines list their codes', () => {
    expect(formatRoutesLabel('metro', ['l1', 'b2'])).toBe('L1 and B2');
    expect(formatRoutesLabel('metro', ['b1', 'b2', 'b3'])).toBe('B1, B2, and B3');
    expect(formatRoutesLabel('metro', ['t1', 't2', 't3', 't4', 't5'])).toBe('5 Metro lines');
  });
  it('Regional Rail lines use their names', () => {
    expect(formatRoutesLabel('rail', ['pao'])).toBe('Paoli/Thorndale Line');
    expect(formatRoutesLabel('rail', ['lan', 'war'])).toBe(
      'Lansdale/Doylestown and Warminster Lines',
    );
  });
  it('empty routes falls back to generic', () => {
    expect(formatRoutesLabel('bus', [])).toBe('this route');
    expect(formatRoutesLabel('metro', [])).toBe('this line');
  });
});
