import { describe, expect, it } from 'vitest';
import {
  composeCancellations,
  currentSlot,
  dayCancellations,
  maybePostCancellationRoundups,
} from '../features/cancellations.js';
import { linkDetectionPosts } from '../features/detections.js';
import { graphemeLength } from '../lib/text.js';
import { testPoster } from './helpers.js';

// Tuesday, Oct 6, 2026, in Philadelphia (UTC−4).
const at = (h, m) => Date.UTC(2026, 9, 6, h + 4, m);
const MORNING = at(6, 50);

function cancellations({ route, mode = 'bus', cancelled, scheduled = null, date = '2026-10-06' }) {
  const id = `trip-cancellations-${date}-${route}`;
  const lifecycle = { first_seen_ts: at(4, 0), resolved_ts: null, active: true, duration_ms: null };
  return {
    id,
    agency: 'septa',
    mode,
    routes: [route],
    sources: ['bot'],
    lifecycle,
    official_alert: null,
    detections: [
      {
        id,
        source: 'trip-cancellations',
        scope: { route },
        lifecycle: { ...lifecycle, onset_ts: null },
        post_url: null,
        resolved_post_url: null,
        description: '',
        evidence: {
          details: {
            kind: 'trip-cancellations',
            service_date: date,
            cancelled,
            scheduled,
            trips: [],
          },
        },
      },
    ],
    status: null,
  };
}

const incidents = () =>
  new Map(
    [
      cancellations({ route: '16', cancelled: 14, scheduled: 120 }),
      cancellations({ route: '7', cancelled: 3 }),
      cancellations({ route: '108', cancelled: 1 }),
      cancellations({ route: 't3', mode: 'metro', cancelled: 2, scheduled: 90 }),
      cancellations({ route: '47', cancelled: 9, date: '2026-10-05' }),
    ].map((i) => [i.id, i]),
  );

describe('cancelled-trip roundups', () => {
  it('runs at 6:45 AM and 2:45 PM', () => {
    expect(currentSlot(at(6, 44))).toBe(-1);
    expect(currentSlot(at(6, 45))).toBe(0);
    expect(currentSlot(at(14, 44))).toBe(0);
    expect(currentSlot(at(23, 0))).toBe(1);
  });

  it("lists today's routes for the account's mode, most cancelled first", () => {
    const items = dayCancellations(incidents(), { mode: 'bus', serviceDate: '2026-10-06' });
    expect(items.map((x) => x.inc.routes[0])).toEqual(['16', '7', '108']);
    const { header, lines } = composeCancellations('bus', items, {
      serviceDate: '2026-10-06',
      now: MORNING,
      slot: 0,
    });
    expect(header).toBe('🚫 Cancelled bus trips · Tue, Oct 6');
    expect(lines).toEqual([
      'SEPTA has cancelled 18 trips on 3 routes today:',
      '· Route 16: 14 of 120 trips',
      '· Route 7: 3 trips',
      '· Route 108: 1 trip',
    ]);
    const later = composeCancellations('bus', items, {
      serviceDate: '2026-10-06',
      now: at(14, 45),
      slot: 1,
    });
    expect(later.lines[0]).toBe('As of 2:45 PM, SEPTA has cancelled 18 trips on 3 routes today:');
  });

  it('posts each slot once per account, links the routes, and skips quiet days', async () => {
    const t = testPoster();
    const incs = incidents();
    const args = { incidents: incs, poster: t.poster, db: t.db };
    expect(await maybePostCancellationRoundups({ ...args, now: at(6, 0) })).toBeNull();
    // Bus has 18 trips; Metro's 2 are under the minimum.
    expect(await maybePostCancellationRoundups({ ...args, now: MORNING })).toEqual({
      posts: 1,
      routes: 3,
    });
    expect(t.client.posts[0].account).toBe('bus');
    expect(t.client.posts[0].opts.text).toMatch(
      /^🚫 Cancelled bus trips · Tue, Oct 6\n\nSEPTA has cancelled 18 trips on 3 routes today:\n· Route 16: 14 of 120 trips/,
    );
    expect(await maybePostCancellationRoundups({ ...args, now: MORNING + 60_000 })).toEqual({
      posts: 0,
      routes: 0,
    });
    expect(linkDetectionPosts(incs, t.poster)).toBe(3);
    // The afternoon roundup posts again.
    expect((await maybePostCancellationRoundups({ ...args, now: at(14, 50) })).posts).toBe(1);
  });

  it('threads a long day, the title repeated on each post', async () => {
    const t = testPoster();
    const many = new Map(
      Array.from({ length: 30 }, (_, i) =>
        cancellations({ route: String(i + 1), cancelled: 40 - i, scheduled: 100 }),
      ).map((i) => [i.id, i]),
    );
    const stats = await maybePostCancellationRoundups({
      incidents: many,
      poster: t.poster,
      db: t.db,
      now: MORNING,
    });
    // All 30 routes link to the roundup; 12 are listed, the rest summed.
    expect(stats.routes).toBe(30);
    expect(stats.posts).toBe(2);
    expect(t.client.posts.at(-1).opts.text).toMatch(/· …and 18 more routes, 351 trips$/);
    expect(t.client.posts.every((p) => graphemeLength(p.opts.text) <= 300)).toBe(true);
    expect(t.client.posts[1].opts.text.split('\n')[0]).toBe(
      '🚫 Cancelled bus trips · Tue, Oct 6 (cont.)',
    );
  });
});
