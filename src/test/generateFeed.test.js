import { describe, expect, it } from 'vitest';
// generate-feed.js guards its main() so importing it here is side-effect-free;
// these are the pure builders the postbuild script composes.
import {
  buildEntryRecord,
  emitAtom,
  entryId,
  feedMeta,
  isLikelyDetectorBlip,
  scopedRecords,
  updatedTs,
} from '../../scripts/generate-feed.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// A merged/alert-backed train incident (carries a headline + post_url).
const alertInc = (over = {}) => ({
  kind: 'metro',
  routes: ['red'],
  headline: 'Red Line Delays',
  alert_id: 'a1',
  post_url: 'https://bsky.app/profile/x/post/r1',
  first_seen_ts: NOW - HOUR,
  resolved_ts: NOW,
  active: false,
  ...over,
});

// A standalone bot observation (no headline/alert_id).
const obsInc = (over = {}) => ({
  kind: 'metro',
  line: 'blue',
  detection_source: 'gap',
  post_url: 'https://bsky.app/profile/x/post/o1',
  first_seen_ts: NOW - HOUR,
  ts: NOW - HOUR,
  resolved_ts: NOW,
  active: false,
  ...over,
});

describe('updatedTs (resolution bump)', () => {
  it('uses resolved_ts once an incident clears', () => {
    expect(updatedTs({ first_seen_ts: NOW - HOUR, resolved_ts: NOW })).toBe(NOW);
  });

  it('falls back to the start time while still active', () => {
    expect(updatedTs({ first_seen_ts: NOW - HOUR, resolved_ts: null })).toBe(NOW - HOUR);
  });
});

describe('entryId', () => {
  it('derives a stable tag URI from the Bluesky post rkey', () => {
    expect(entryId({ post_url: 'https://bsky.app/profile/x/post/abc123' })).toBe(
      'tag:chicagotransitalerts.app,2026:event/abc123',
    );
  });

  it('is identical for the same incident across feeds (global vs scoped)', () => {
    const inc = alertInc();
    expect(entryId(inc)).toBe(entryId(inc));
  });

  it('prefers the alert post over the observation post', () => {
    const id = entryId({
      post_url: 'https://bsky.app/profile/x/post/alert',
      obs_post_url: 'https://bsky.app/profile/x/post/obs',
    });
    expect(id).toBe('tag:chicagotransitalerts.app,2026:event/alert');
  });
});

describe('isLikelyDetectorBlip', () => {
  it('drops a standalone observation that resolved within the FP window', () => {
    expect(
      isLikelyDetectorBlip(
        obsInc({ first_seen_ts: NOW - 2 * MIN, ts: NOW - 2 * MIN, resolved_ts: NOW }),
      ),
    ).toBe(true);
  });

  it('keeps a standalone observation that lasted past the window', () => {
    expect(
      isLikelyDetectorBlip(
        obsInc({ first_seen_ts: NOW - 30 * MIN, ts: NOW - 30 * MIN, resolved_ts: NOW }),
      ),
    ).toBe(false);
  });

  it('never drops an alert-backed incident, even a brief one', () => {
    expect(isLikelyDetectorBlip(alertInc({ first_seen_ts: NOW - 1 * MIN, resolved_ts: NOW }))).toBe(
      false,
    );
  });

  it('keeps a still-active observation (no resolution yet)', () => {
    expect(isLikelyDetectorBlip(obsInc({ resolved_ts: null, active: true }))).toBe(false);
  });
});

describe('feedMeta', () => {
  it('builds a distinct id + self/home URLs for a scoped feed', () => {
    expect(
      feedMeta({
        idPath: 'feed/line/red',
        title: 'Chicago Transit Alerts · Red Line',
        subtitle: 'Red Line disruptions.',
        homePath: '/line/red',
        selfBase: '/feed/line/red',
      }),
    ).toEqual({
      id: 'tag:chicagotransitalerts.app,2026:feed/line/red',
      title: 'Chicago Transit Alerts · Red Line',
      subtitle: 'Red Line disruptions.',
      homeUrl: 'https://chicagotransitalerts.app/line/red',
      selfXml: 'https://chicagotransitalerts.app/feed/line/red.xml',
      selfJson: 'https://chicagotransitalerts.app/feed/line/red.json',
    });
  });
});

describe('buildEntryRecord', () => {
  it('carries the stable id, the resolution-bumped updated time, and a cache-busted thumbnail', () => {
    const rec = buildEntryRecord(alertInc());
    expect(rec.id).toBe('tag:chicagotransitalerts.app,2026:event/r1');
    expect(rec.updatedMs).toBe(NOW); // resolved → bumped
    // The OG thumbnail is cache-busted on the same key, so it flips when the
    // entry's <updated> bumps (ongoing → resolved).
    expect(rec.thumb).toContain('/event/r1/og.jpg?v=' + NOW);
  });
});

describe('scopedRecords', () => {
  // A pre-sorted (newest-first) pool spanning two lines and a bus route.
  const pool = [
    alertInc({
      post_url: 'https://bsky.app/profile/x/post/red-new',
      first_seen_ts: NOW - 1 * HOUR,
    }),
    alertInc({
      routes: ['red', 'purple'],
      post_url: 'https://bsky.app/profile/x/post/redpurple',
      first_seen_ts: NOW - 2 * HOUR,
      resolved_ts: NOW - 1 * HOUR,
    }),
    alertInc({
      routes: ['blue'],
      post_url: 'https://bsky.app/profile/x/post/blue',
      first_seen_ts: NOW - 3 * HOUR,
      resolved_ts: NOW - 2 * HOUR,
    }),
    alertInc({
      kind: 'bus',
      routes: ['66'],
      post_url: 'https://bsky.app/profile/x/post/bus66',
      first_seen_ts: NOW - 4 * HOUR,
      resolved_ts: NOW - 3 * HOUR,
    }),
  ];

  it('selects only incidents on the scoped train line and preserves pool order', () => {
    const ids = scopedRecords(pool, 'metro', 'red').map((r) => r.id);
    expect(ids).toEqual([
      'tag:chicagotransitalerts.app,2026:event/red-new',
      'tag:chicagotransitalerts.app,2026:event/redpurple', // multi-route red+purple still matches
    ]);
  });

  it('matches a multi-route incident from any of its routes', () => {
    const ids = scopedRecords(pool, 'metro', 'purple').map((r) => r.id);
    expect(ids).toEqual(['tag:chicagotransitalerts.app,2026:event/redpurple']);
  });

  it('scopes by kind so a bus route never picks up train incidents', () => {
    const ids = scopedRecords(pool, 'bus', '66').map((r) => r.id);
    expect(ids).toEqual(['tag:chicagotransitalerts.app,2026:event/bus66']);
  });
});

describe('emitAtom', () => {
  const meta = feedMeta({
    idPath: 'feed/line/red',
    title: 'Chicago Transit Alerts · Red Line',
    subtitle: 'Red Line disruptions.',
    homePath: '/line/red',
    selfBase: '/feed/line/red',
  });

  it('renders the feed id, scoped self link, and one entry per record', () => {
    const xml = emitAtom([buildEntryRecord(alertInc())], '2026-01-01T00:00:00.000Z', meta);
    expect(xml).toContain('<id>tag:chicagotransitalerts.app,2026:feed/line/red</id>');
    expect(xml).toContain(
      '<link rel="self" type="application/atom+xml" href="https://chicagotransitalerts.app/feed/line/red.xml"/>',
    );
    expect(xml).toContain('<link rel="hub"');
    expect((xml.match(/<entry>/g) || []).length).toBe(1);
  });

  it('produces a valid empty feed (no entries) for a quiet route', () => {
    const xml = emitAtom([], '2026-01-01T00:00:00.000Z', meta);
    expect(xml).toContain('<id>tag:chicagotransitalerts.app,2026:feed/line/red</id>');
    expect((xml.match(/<entry>/g) || []).length).toBe(0);
  });
});

// A Metra cancellation/delay: website-data-first, so NO Bluesky post, and a
// zero-duration point event (resolved_ts == first_seen_ts).
const railInc = (over = {}) => ({
  kind: 'rail',
  id: 'metra-678',
  routes: ['md-n'],
  detection_source: 'delay',
  from_station: 'Fox Lake',
  to_station: 'Chicago Union Station',
  first_seen_ts: NOW,
  ts: NOW,
  resolved_ts: NOW,
  active: false,
  ...over,
});

describe('Metra incidents in the feed', () => {
  it('links a postless Metra record to its SPA event page by id', () => {
    const rec = buildEntryRecord(railInc());
    expect(rec.link).toBe('https://chicagotransitalerts.app/event/rail-678');
    expect(rec.id).toBe('tag:chicagotransitalerts.app,2026:obs-metra-678');
    expect(rec.thumb).toBe(null); // no OG card for postless Metra
  });

  it('is never treated as a detector blip despite zero duration', () => {
    expect(isLikelyDetectorBlip(railInc())).toBe(false);
  });

  it('tags a Metra entry with the Metra mode + line category', () => {
    const rec = buildEntryRecord(railInc());
    const terms = rec.categories.map((c) => c.term);
    expect(terms).toContain('rail');
    expect(terms).toContain('rail-line-md-n');
  });

  it('scopes per-line Metra feeds by the lowercase line key', () => {
    const pool = [railInc(), railInc({ id: 'metra-9', routes: ['up-n'] })];
    expect(scopedRecords(pool, 'rail', 'md-n')).toHaveLength(1);
    expect(scopedRecords(pool, 'rail', 'up-n')).toHaveLength(1);
    expect(scopedRecords(pool, 'rail', 'bnsf')).toHaveLength(0);
  });
});
