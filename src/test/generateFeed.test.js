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
import { SITE_ORIGIN } from '../lib/site.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// The site origin is configurable (SITE_URL), so derive the expected URLs.
const TAG = `tag:${new URL(SITE_ORIGIN).host},2026`;

// An alert-backed Metro incident (carries a headline + alert id).
const alertInc = (over = {}) => ({
  _incidentId: 'alert-1',
  kind: 'metro',
  routes: ['l1'],
  headline: 'L1 Delays',
  alert_id: '1',
  source_url: 'https://www.septa.org/schedules/L1',
  first_seen_ts: NOW - HOUR,
  resolved_ts: NOW,
  active: false,
  ...over,
});

// A standalone bot observation (no headline/alert_id).
const obsInc = (over = {}) => ({
  _incidentId: 'gap-1',
  kind: 'metro',
  line: 'b1',
  detection_source: 'gap',
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
  it('derives a stable tag URI from the incident id', () => {
    expect(entryId({ _incidentId: 'alert-136615' })).toBe(`${TAG}:event/alert-136615`);
  });

  it('is identical for the same incident across feeds (global vs scoped)', () => {
    const inc = alertInc();
    expect(entryId(inc)).toBe(entryId(inc));
  });

  it('falls back to the record id for hand-built records', () => {
    expect(entryId({ id: 'delay-2026-10-05-3556' })).toBe(`${TAG}:event/delay-2026-10-05-3556`);
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
        idPath: 'feed/line/l1',
        title: 'SEPTA Transit Alerts · L1 Market-Frankford Line',
        subtitle: 'L1 disruptions.',
        homePath: '/line/l1',
        selfBase: '/feed/line/l1',
      }),
    ).toEqual({
      id: `${TAG}:feed/line/l1`,
      title: 'SEPTA Transit Alerts · L1 Market-Frankford Line',
      subtitle: 'L1 disruptions.',
      homeUrl: `${SITE_ORIGIN}/line/l1`,
      selfXml: `${SITE_ORIGIN}/feed/line/l1.xml`,
      selfJson: `${SITE_ORIGIN}/feed/line/l1.json`,
    });
  });
});

describe('buildEntryRecord', () => {
  it('carries the stable id, the resolution-bumped updated time, and a cache-busted thumbnail', () => {
    const rec = buildEntryRecord(alertInc(), { now: NOW });
    expect(rec.id).toBe(`${TAG}:event/alert-1`);
    expect(rec.link).toBe(`${SITE_ORIGIN}/event/alert-1`);
    expect(rec.updatedMs).toBe(NOW); // resolved → bumped
    // The OG thumbnail is cache-busted on the same key, so it flips when the
    // entry's <updated> bumps (ongoing → resolved).
    expect(rec.thumb).toContain(`/event/alert-1/og.jpg?v=${NOW}`);
  });

  it('omits the thumbnail once the incident ages out of the prerendered window', () => {
    const rec = buildEntryRecord(alertInc(), { now: NOW + 200 * DAY });
    expect(rec.thumb).toBe(null);
  });

  it("links SEPTA's route page and labels the route", () => {
    const rec = buildEntryRecord(alertInc({ kind: 'bus', routes: ['17'] }), { now: NOW });
    expect(rec.title).toBe('Route 17: L1 Delays');
    expect(rec.contentHtml).toContain('https://www.septa.org/schedules/L1');
    expect(rec.categories).toContainEqual({ term: 'route-17', label: 'Route 17' });
  });

  it("doesn't repeat a route the headline already names", () => {
    const rec = buildEntryRecord(alertInc({ headline: 'L1 Service Suspended' }), { now: NOW });
    expect(rec.title).toBe('L1 Service Suspended');
  });
});

describe('scopedRecords', () => {
  // A pre-sorted (newest-first) pool spanning two lines and a bus route.
  const pool = [
    alertInc({ _incidentId: 'l1-new', first_seen_ts: NOW - 1 * HOUR }),
    alertInc({
      _incidentId: 'l1-b2',
      routes: ['l1', 'b2'],
      first_seen_ts: NOW - 2 * HOUR,
      resolved_ts: NOW - 1 * HOUR,
    }),
    alertInc({
      _incidentId: 'b1',
      routes: ['b1'],
      first_seen_ts: NOW - 3 * HOUR,
      resolved_ts: NOW - 2 * HOUR,
    }),
    alertInc({
      _incidentId: 'bus17',
      kind: 'bus',
      routes: ['17'],
      first_seen_ts: NOW - 4 * HOUR,
      resolved_ts: NOW - 3 * HOUR,
    }),
  ];

  it('selects only incidents on the scoped Metro line and preserves pool order', () => {
    const ids = scopedRecords(pool, 'metro', 'l1').map((r) => r.id);
    expect(ids).toEqual([
      `${TAG}:event/l1-new`,
      `${TAG}:event/l1-b2`, // multi-route L1+B2 still matches
    ]);
  });

  it('matches a multi-route incident from any of its routes', () => {
    const ids = scopedRecords(pool, 'metro', 'b2').map((r) => r.id);
    expect(ids).toEqual([`${TAG}:event/l1-b2`]);
  });

  it('scopes by kind so a bus route never picks up Metro incidents', () => {
    const ids = scopedRecords(pool, 'bus', '17').map((r) => r.id);
    expect(ids).toEqual([`${TAG}:event/bus17`]);
  });
});

describe('emitAtom', () => {
  const meta = feedMeta({
    idPath: 'feed/line/l1',
    title: 'SEPTA Transit Alerts · L1 Market-Frankford Line',
    subtitle: 'L1 disruptions.',
    homePath: '/line/l1',
    selfBase: '/feed/line/l1',
  });

  it('renders the feed id, scoped self link, and one entry per record', () => {
    const xml = emitAtom([buildEntryRecord(alertInc())], '2026-01-01T00:00:00.000Z', meta);
    expect(xml).toContain(`<id>${TAG}:feed/line/l1</id>`);
    expect(xml).toContain(
      `<link rel="self" type="application/atom+xml" href="${SITE_ORIGIN}/feed/line/l1.xml"/>`,
    );
    expect((xml.match(/<entry>/g) || []).length).toBe(1);
  });

  it('produces a valid empty feed (no entries) for a quiet route', () => {
    const xml = emitAtom([], '2026-01-01T00:00:00.000Z', meta);
    expect(xml).toContain(`<id>${TAG}:feed/line/l1</id>`);
    expect((xml.match(/<entry>/g) || []).length).toBe(0);
  });
});

// A Regional Rail cancellation/delay: a zero-duration point event
// (resolved_ts == first_seen_ts).
const railInc = (over = {}) => ({
  kind: 'rail',
  _incidentId: 'delay-2026-10-05-678',
  id: 'delay-2026-10-05-678',
  routes: ['war'],
  detection_source: 'delay',
  from_station: 'Warminster',
  to_station: 'Temple University',
  first_seen_ts: NOW,
  ts: NOW,
  resolved_ts: NOW,
  active: false,
  ...over,
});

describe('Regional Rail incidents in the feed', () => {
  it('links a Regional Rail record to its event page by incident id', () => {
    const rec = buildEntryRecord(railInc(), { now: NOW });
    expect(rec.link).toBe(`${SITE_ORIGIN}/event/delay-2026-10-05-678`);
    expect(rec.id).toBe(`${TAG}:event/delay-2026-10-05-678`);
    expect(rec.thumb).toContain('/event/delay-2026-10-05-678/og.jpg');
  });

  it('is never treated as a detector blip despite zero duration', () => {
    expect(isLikelyDetectorBlip(railInc())).toBe(false);
  });

  it('tags a Regional Rail entry with the mode + line category', () => {
    const rec = buildEntryRecord(railInc());
    expect(rec.categories).toContainEqual({ term: 'rail', label: 'Regional Rail' });
    expect(rec.categories).toContainEqual({ term: 'rail-line-war', label: 'Warminster Line' });
  });

  it('scopes per-line Regional Rail feeds by the lowercase line key', () => {
    const pool = [railInc(), railInc({ _incidentId: 'cancel-1', routes: ['nor'] })];
    expect(scopedRecords(pool, 'rail', 'war')).toHaveLength(1);
    expect(scopedRecords(pool, 'rail', 'nor')).toHaveLength(1);
    expect(scopedRecords(pool, 'rail', 'pao')).toHaveLength(0);
  });
});
