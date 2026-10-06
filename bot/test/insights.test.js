import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { easternToEpoch } from '../../collector/lib/time.js';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { postDetections } from '../features/detections.js';
import { recordEvent, startOfEasternDay } from '../features/history.js';
import {
  comparisonLine,
  composeDigest,
  composeRoughHour,
  digestStats,
  disruptionEvents,
  fitSections,
  maybePostDigests,
  maybePostRoughHour,
  REPOST_LIMITS,
  repostHighlights,
  roughHour,
} from '../features/insights.js';
import { recordTrains } from '../features/rail.js';
import { createDryRunClient } from '../lib/bluesky.js';
import { addDays } from '../lib/clock.js';
import { graphemeLength } from '../lib/text.js';
import { createBasemap } from '../map/basemap.js';
import {
  byLabel,
  detectionIncident,
  fakeShapes,
  NOW,
  officialIncident,
  testPoster,
  vehicle,
} from './helpers.js';

const MIN = 60_000;
const TODAY = '2026-10-06'; // a Tuesday; NOW is 11:20 AM that day

/** Epoch ms of a Philadelphia wall-clock time on a date key. */
function at(key, hour = 0, minute = 0) {
  const [y, m, d] = key.split('-').map(Number);
  return easternToEpoch(y, m, d, hour, minute);
}
const isWeekday = (key) => ![0, 6].includes(new Date(`${key}T12:00:00Z`).getUTCDay());
const asMap = (list) => new Map(list.map((i) => [i.id, i]));

let seq = 0;
function det(source, ts, { mode = 'bus', route = '23' } = {}) {
  return detectionIncident({ id: `${source}-${++seq}`, source, mode, route, firstSeen: ts });
}
function alert(ts, over = {}) {
  const id = over.id ?? `alert-${++seq}`;
  return officialIncident({ id, mode: 'bus', routes: ['47'], firstSeen: ts, ...over });
}
function trips(date, cancelled, route = '23') {
  const ts = at(date, 5);
  return {
    id: `trip-cancellations-${date}-${route}`,
    agency: 'septa',
    mode: 'bus',
    routes: [route],
    sources: ['bot'],
    lifecycle: { first_seen_ts: ts, resolved_ts: null, active: false, duration_ms: null },
    official_alert: null,
    detections: [
      {
        id: `trip-cancellations-${date}-${route}`,
        source: 'trip-cancellations',
        scope: { route },
        lifecycle: { first_seen_ts: ts, active: false },
        evidence: { details: { service_date: date, cancelled, scheduled: 200 } },
      },
    ],
    status: null,
  };
}

describe('reposts', () => {
  it('reposts the other accounts’ highlighted posts once each, oldest first, one a tick', async () => {
    const t = testPoster();
    // The first run marks the start; nothing earlier is reposted.
    t.setNow(NOW - 10 * MIN);
    await t.poster.post({ account: 'bus', kind: 'recap', text: 'old', highlight: 'recap' });
    expect(await repostHighlights({ db: t.db, poster: t.poster, now: NOW - 9 * MIN })).toEqual({
      reposted: 0,
    });

    t.setNow(NOW);
    const recap = await t.poster.post({
      account: 'bus',
      kind: 'recap',
      text: 'bus recap',
      highlight: 'recap',
    });
    await t.poster.post({ account: 'metro', kind: 'speedmap', text: 'plain' });
    await t.poster.post({ account: 'alerts', kind: 'digest', text: 'own', highlight: 'recap' });
    t.setNow(NOW + MIN);
    const rail = await t.poster.post({
      account: 'rail',
      kind: 'rail-recap',
      text: 'rail recap',
      highlight: 'recap',
    });

    const run = (now) => {
      t.setNow(now);
      return repostHighlights({ db: t.db, poster: t.poster, now });
    };
    expect(await run(NOW + 2 * MIN)).toEqual({ reposted: 1, waiting: 1 });
    expect(await run(NOW + 4 * MIN)).toEqual({ reposted: 1 });
    expect(await run(NOW + 6 * MIN)).toEqual({ reposted: 0 });
    expect(t.client.reposts.map((r) => [r.account, r.subject.uri])).toEqual([
      ['alerts', recap.uri],
      ['alerts', rail.uri],
    ]);
    const row = t.poster.find(`repost:${recap.uri}`, 'repost');
    expect(row).toMatchObject({ account: 'alerts', url: recap.url });
  });

  it('stays within the hourly cap and lets stale highlights go', async () => {
    const t = testPoster();
    await repostHighlights({ db: t.db, poster: t.poster, now: NOW - MIN });
    for (let i = 0; i < 5; i++) {
      await t.poster.post({
        account: 'bus',
        kind: 'cross-bunching',
        text: `c${i}`,
        highlight: 'x',
      });
    }
    const run = (now) => {
      t.setNow(now);
      return repostHighlights({ db: t.db, poster: t.poster, now });
    };
    for (let i = 1; i <= 4; i++) await run(NOW + i * 2 * MIN);
    expect(t.client.reposts).toHaveLength(REPOST_LIMITS.perHour);
    await run(NOW + 70 * MIN);
    expect(t.client.reposts).toHaveLength(4);
    // The fifth is past maxAgeMs by the time the hour allows it.
    await run(NOW + REPOST_LIMITS.maxAgeMs + MIN);
    expect(t.client.reposts).toHaveLength(4);
  });

  it('gives up on a post it can’t repost, and does nothing without the account', async () => {
    const t = testPoster();
    await repostHighlights({ db: t.db, poster: t.poster, now: NOW - MIN });
    await t.poster.post({ account: 'bus', kind: 'recap', text: 'gone', highlight: 'recap' });
    let calls = 0;
    t.client.repost = async () => {
      calls++;
      throw new Error('not found');
    };
    await repostHighlights({ db: t.db, poster: t.poster, now: NOW + MIN });
    await repostHighlights({ db: t.db, poster: t.poster, now: NOW + 3 * MIN });
    expect(calls).toBe(1);

    const off = testPoster();
    off.client.hasAccount = (a) => a !== 'alerts';
    expect(await repostHighlights({ db: off.db, poster: off.poster, now: NOW })).toBeNull();
  });

  it('highlights a detection that is the route’s worst in 30 days', async () => {
    const t = testPoster();
    const day = startOfEasternDay(NOW);
    for (const [i, ratio] of [2.1, 2.4, 2.2].entries()) {
      recordEvent(t.db, {
        subject: `old${i}`,
        source: 'gap',
        mode: 'bus',
        route: '23',
        metric: 20,
        ratio,
        ts: day - (i + 1) * 86_400_000,
        posted: 1,
      });
    }
    await repostHighlights({ db: t.db, poster: t.poster, now: NOW - MIN });
    const gap = detectionIncident({
      details: { direction_id: 0, gap_min: 30, headway_min: 10, vehicles: ['3787', '3314'] },
    });
    await postDetections({
      incidents: asMap([gap]),
      poster: t.poster,
      db: t.db,
      vehicles: byLabel([
        vehicle({ label: '3787', lat: 39.97 }),
        vehicle({ label: '3314', lat: 40.03 }),
      ]),
      shapes: fakeShapes(),
      basemap: createBasemap(),
      now: NOW,
      maxAgeMs: 30 * MIN,
    });
    expect(t.poster.find(`det:${gap.detections[0].id}`, 'detection').highlight).toBe('record');
    expect((await repostHighlights({ db: t.db, poster: t.poster, now: NOW + MIN })).reposted).toBe(
      1,
    );
  });

  it('writes dry-run reposts to the assets folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'insights-'));
    try {
      const client = createDryRunClient({ assetsDir: dir, now: () => NOW });
      const post = await client.post('bus', { text: 'A recap' });
      const res = await client.repost('alerts', { uri: post.uri, cid: post.cid });
      expect(res.uri).toMatch(/app\.bsky\.feed\.repost/);
      const [day] = await readdir(dir);
      const files = (await readdir(join(dir, day))).filter((f) => f.includes('-alerts-'));
      const record = JSON.parse(await readFile(join(dir, day, files[0]), 'utf8'));
      expect(record).toEqual({ account: 'alerts', repost: { uri: post.uri, cid: post.cid } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('rough hours', () => {
  // Five gaps between 4 and 5 PM on every earlier weekday for four weeks.
  function history(todayCount, { days = 28 } = {}) {
    const list = [];
    for (let i = 1; i <= days; i++) {
      const key = addDays(TODAY, -i);
      if (!isWeekday(key)) continue;
      for (let n = 0; n < 5; n++) list.push(det('gap', at(key, 16, 5 + n * 10)));
    }
    for (let n = 0; n < todayCount; n++) {
      const route = n < 3 ? '47' : String(100 + n);
      list.push(det(n % 4 === 0 ? 'bunching' : 'gap', at(TODAY, 16, 1 + n), { route }));
    }
    list.push(det('delay', at(TODAY, 16, 30), { mode: 'regional_rail', route: 'pao' }));
    list.push(det('pulse-held', at(TODAY, 16, 40), { route: '47' }));
    return asMap(list);
  }
  const end = at(TODAY, 17);

  it('flags an hour well over the usual and the most in the lookback', () => {
    const found = roughHour({
      incidents: history(18),
      end,
      dataStartTs: at(TODAY) - 40 * 86_400_000,
    });
    expect(found).toMatchObject({ type: 'weekday', usual: 5, weeks: 4 });
    expect(found.current.total).toBe(20);
    const { text, facets } = composeRoughHour(found);
    expect(text.split('\n\n')).toEqual([
      '🔥 A rough hour on SEPTA · 4:00–5:00 PM',
      [
        '20 new disruptions, the most at this hour on a weekday in 4 weeks (usually ~5):',
        '· 13 long gaps, 5 bunches',
        '· 1 route with vehicles stuck',
        '· Regional Rail: 1 train 15+ min late',
      ].join('\n'),
      `Hardest hit: Route 47 (4)\n🔗 ${new URL(SITE_ORIGIN).host}`,
    ]);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(facets).toHaveLength(1);
  });

  it('stays quiet for an ordinary hour or without enough history', () => {
    expect(roughHour({ incidents: history(8), end })).toBeNull();
    expect(roughHour({ incidents: history(18, { days: 7 }), end })).toBeNull();
  });

  it('posts once an hour at most, then cools down', async () => {
    const t = testPoster();
    const incidents = history(18);
    const tick = (now) => {
      t.setNow(now);
      return maybePostRoughHour({ incidents, db: t.db, poster: t.poster, now });
    };
    expect(await tick(end + 5 * MIN)).toBeNull();
    expect(await tick(end + 10 * MIN)).toMatchObject({ posted: 20 });
    expect(await tick(end + 30 * MIN)).toBeNull();
    expect(t.client.posts.map((p) => [p.account, p.opts.text.split('\n')[0]])).toEqual([
      ['alerts', '🔥 A rough hour on SEPTA · 4:00–5:00 PM'],
    ]);
    // The next hour would qualify too, but it's inside the cooldown.
    for (let n = 0; n < 20; n++) incidents.set(`late-${n}`, det('gap', at(TODAY, 17, 2 + n)));
    for (let i = 1; i <= 28; i++) {
      const key = addDays(TODAY, -i);
      if (isWeekday(key)) incidents.set(`h-${key}`, det('gap', at(key, 17, 30)));
    }
    expect(await tick(end + 70 * MIN)).toEqual({ skipped: 'cooldown' });
  });
});

describe('digests', () => {
  // Thirty quiet days, then a Tuesday with three times the usual cancellations.
  function archive() {
    const list = [];
    for (let i = 1; i <= 30; i++) {
      const key = addDays(TODAY, -i);
      list.push(alert(at(key, 9)), alert(at(key, 15)), trips(key, 20));
      for (let n = 0; n < 3; n++) list.push(det('gap', at(key, 10, n)));
      for (let n = 0; n < 4; n++) list.push(det('bunching', at(key, 11, n)));
    }
    list.push(
      alert(at(TODAY, 7)),
      alert(at(TODAY, 8), { id: 'alert-90', alertId: '90' }),
      // The same SEPTA alert on a second network counts once.
      alert(at(TODAY, 8), { id: 'alert-90-metro', alertId: '90', mode: 'metro' }),
      alert(at(TODAY, 9), {
        headline: 'Track construction on the L1 this weekend',
        type: 'ADVISORY',
        cause: 'CONSTRUCTION',
      }),
      // Road work: the alerts account wouldn't post it, so it isn't counted.
      alert(at(TODAY, 10), { id: 'detour-d1', headline: 'Detour: PGW', type: 'DETOUR' }),
      trips(TODAY, 45),
      trips(TODAY, 15, '47'),
      det('gap', at(TODAY, 10)),
      det('gap', at(TODAY, 12)),
      det('bunching', at(TODAY, 13)),
      det('delay', at(TODAY, 17), { mode: 'regional_rail', route: 'pao' }),
      det('cancellation', at(TODAY, 18), { mode: 'regional_rail', route: 'pao' }),
      // After the digest's time: not counted yet.
      det('gap', at(TODAY, 23)),
    );
    return asMap(list);
  }
  const outages = new Map([
    [
      'e1',
      {
        id: 'e1',
        station: { name: '30th Street' },
        lifecycle: { first_seen_ts: at(TODAY) - 10 * 86_400_000, active: true },
      },
    ],
    [
      'e2',
      { id: 'e2', station: { name: 'Erie' }, lifecycle: { first_seen_ts: NOW, active: true } },
    ],
    ['e3', { id: 'e3', station: { name: 'Fern Rock' }, lifecycle: { active: false } }],
  ]);
  const evening = at(TODAY, 21, 45);

  function railDay(db) {
    const trains = Array.from({ length: 150 }, (_, i) => ({
      trainno: String(1000 + i),
      line: 'Paoli/Thorndale',
      late: i < 10 ? 20 : i < 12 ? 999 : 2,
    }));
    recordTrains(db, at(TODAY, 12), trains);
  }

  it('counts unplanned alerts once, cancelled trips, detections, and trains', () => {
    const { db } = testPoster();
    railDay(db);
    const stats = digestStats({ period: 'day', incidents: archive(), outages, db, now: evening });
    expect(stats.current).toMatchObject({
      key: TODAY,
      type: 'weekday',
      alert: 2,
      trips: 60,
      gap: 2,
      bunch: 1,
      late: 1,
      cancelled: 1,
    });
    const trips = stats.results.find((r) => r.metric.more === 'cancelled trips');
    expect(trips).toMatchObject({ value: 60, usual: 20, record: true });
    expect(stats.rail).toMatchObject({ trains: 150, cancelled: 2 });
    expect(stats.elevators.map((e) => e.id)).toEqual(['e1', 'e2']);

    const { text, link } = composeDigest(stats);
    // The elevator line, ranked last, doesn't fit today.
    expect(text).toBe(
      [
        '📊 SEPTA today · Tuesday, Oct 6',
        '📈 Most cancelled trips in 30 days, 3× a usual weekday',
        [
          '⚠️ 2 unplanned SEPTA alerts',
          '🚫 60 bus and Metro trips cancelled',
          '🕳️ 2 long gaps and 1 bunch on buses and trolleys',
          '🚆 Regional Rail: 92% on time (under 15 min late), 2 cancelled',
        ].join('\n'),
        'Hardest hit: Route 23 (3)',
      ].join('\n\n'),
    );
    // With room, it shows: here in its short form; in full on a quieter day.
    expect(composeDigest({ ...stats, hardest: [] }).text).toMatch(/\n♿ 2 elevators out$/);
    const quiet = { ...stats, current: { ...stats.current, gap: 0, bunch: 0 }, hardest: [] };
    expect(composeDigest(quiet).text).toMatch(
      /\n♿ 2 elevators out, longest at 30th Street \(10\+ days\)$/,
    );
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(link).toMatchObject({
      url: `${SITE_ORIGIN}/day/${TODAY}`,
      title: 'SEPTA on Tuesday, Oct 6',
      thumbUrl: `${SITE_ORIGIN}/day/${TODAY}/og.png`,
    });
  });

  it('leaves out planned work and judges only from when a source started', () => {
    const events = disruptionEvents(archive(), at(TODAY));
    expect(events.filter((e) => e.kind === 'alert')).toHaveLength(2);
    // Gaps only since yesterday: no usual and no record to compare with.
    const incidents = asMap([
      det('gap', at(addDays(TODAY, -1), 10)),
      det('gap', at(TODAY, 10)),
      det('gap', at(TODAY, 11)),
      det('gap', at(TODAY, 12)),
    ]);
    const { db } = testPoster();
    const stats = digestStats({ period: 'day', incidents, db, now: evening });
    const gaps = stats.results.find((r) => r.metric.more === 'long gaps');
    expect(gaps).toMatchObject({ value: 3, usual: null, record: false });
  });

  it('keeps the most important lines when space runs out', () => {
    const head = 'Head';
    const long = 'x'.repeat(120);
    const text = fitSections(
      head,
      [
        [
          { rank: 2, text: `a${long}` },
          { rank: 1, text: `b${long}` },
          { rank: 3, text: 'c' },
        ],
        [{ rank: 0, text: `d${long}` }],
      ],
      300,
    );
    expect(text).toBe(`Head\n\nb${long}\nc\n\nd${long}`);
    // A line with versions takes the longest that fits.
    const versions = { rank: 0, text: [`e${long}${long}`, 'e short'] };
    expect(fitSections(head, [[versions, { rank: 1, text: `b${long}` }]], 200)).toBe(
      `Head\n\ne short\nb${long}`,
    );
  });

  it('names up to two standouts, or a calm day', () => {
    const r = (name, value, usual, record = false) => ({
      metric: { more: name, most: `most ${name}` },
      value,
      usual,
      record,
    });
    const opts = { span: '30 days', usualName: 'Saturday' };
    expect(comparisonLine([r('gaps', 30, 10, true), r('alerts', 4, 3)], opts)).toBe(
      '📈 Most gaps in 30 days, 3× a usual Saturday',
    );
    expect(
      comparisonLine([r('alerts', 8, 4), r('gaps', 30, 10, true), r('trips', 9, 3)], opts),
    ).toBe('📈 Most gaps in 30 days · trips 3× a usual Saturday');
    // Small numbers aren't a standout: 2 alerts against a usual 1.
    expect(comparisonLine([r('alerts', 2, 1)], opts)).toBeNull();
    expect(comparisonLine([r('a', 1, 5), r('b', 2, 6), r('c', 0, 4)], opts)).toBe(
      '📉 Calmer than a usual Saturday',
    );
    expect(comparisonLine([r('a', 1, 5), r('b', 5, 6), r('c', 0, 4)], opts)).toBeNull();
  });

  it('posts the day’s digest after 9:30 PM, and last week’s on Sunday morning', async () => {
    const t = testPoster();
    railDay(t.db);
    const opts = { incidents: archive(), outages, db: t.db, poster: t.poster };
    expect(await maybePostDigests({ ...opts, now: at(TODAY, 21, 20) })).toBeNull();
    expect(await maybePostDigests({ ...opts, now: at(TODAY, 21, 31) })).toMatchObject({
      day: { posted: 'day' },
    });
    expect(await maybePostDigests({ ...opts, now: at(TODAY, 21, 50) })).toBeNull();

    // Sunday, Oct 11: the week of Oct 4–10, the site's /week/2026-10-04.
    expect(await maybePostDigests({ ...opts, now: at('2026-10-11', 10, 55) })).toBeNull();
    expect(await maybePostDigests({ ...opts, now: at('2026-10-11', 11, 5) })).toMatchObject({
      week: { posted: 'week' },
    });
    const [day, week] = t.client.posts;
    expect(day.account).toBe('alerts');
    expect(day.opts.link.url).toBe(`${SITE_ORIGIN}/day/${TODAY}`);
    expect(week.opts.text.split('\n')[0]).toBe('📊 SEPTA last week · Oct 4 – Oct 10');
    expect(week.opts.link.url).toBe(`${SITE_ORIGIN}/week/2026-10-04`);
    // The archive stops on Oct 6, so the week is missing days: no comparison.
    expect(week.opts.text).not.toMatch(/📈|📉/);
    expect(t.client.posts.every((p) => graphemeLength(p.opts.text) <= 300)).toBe(true);
  });

  it('skips a digest with nothing recorded', async () => {
    const t = testPoster();
    const res = await maybePostDigests({
      incidents: new Map(),
      db: t.db,
      poster: t.poster,
      now: at(TODAY, 21, 40),
    });
    expect(res).toEqual({ day: { skipped: 'no-data' } });
    expect(t.client.posts).toHaveLength(0);
  });
});
