import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SITE_ORIGIN } from '../../src/lib/site.js';
import { linkDetectionPosts } from '../features/detections.js';
import {
  composeRailRecap,
  maybePostRailRollup,
  postRailRecap,
  railRecapStats,
  recapWindow,
  recordTrains,
  rollupLines,
} from '../features/rail.js';
import { pruneDb } from '../lib/db.js';
import { graphemeLength } from '../lib/text.js';
import { barChartSvg, renderBarChart } from '../map/chart.js';
import { NOW, testPoster } from './helpers.js';

const HOUR = 3_600_000;
const MIN = 60_000;
// NOW is 11:20 AM in Philadelphia; the hour that just ended is 10–11 AM.
const hourStart = Math.floor(NOW / HOUR) * HOUR;

function railIncident({
  id,
  source = 'delay',
  train = '9531',
  line = 'pao',
  from = 'Thorndale',
  to = 'Temple U',
  dep = hourStart - 50 * MIN,
  late = 20,
  firstSeen = hourStart - 30 * MIN,
}) {
  const lifecycle = {
    first_seen_ts: firstSeen,
    resolved_ts: null,
    active: true,
    duration_ms: null,
  };
  return {
    id,
    agency: 'septa',
    mode: 'regional_rail',
    routes: [line],
    sources: ['bot'],
    lifecycle,
    official_alert: null,
    detections: [
      {
        id,
        source,
        scope: { route: line, from_station: from, to_station: to, stations: [] },
        lifecycle: { ...lifecycle, onset_ts: null },
        post_url: null,
        resolved_post_url: null,
        description: '',
        evidence: {
          train_number: train,
          details: source === 'delay' ? { late_min: late, max_late_min: late } : null,
        },
      },
    ],
    status:
      source === 'delay'
        ? {
            type: 'delay',
            train_number: train,
            delay_min: late,
            origin: from,
            scheduled_departure_ts: dep,
          }
        : {
            type: 'cancellation',
            state: 'upcoming',
            train_number: train,
            origin: from,
            scheduled_departure_ts: dep,
          },
  };
}

const byId = (list) => new Map(list.map((i) => [i.id, i]));

describe('Regional Rail roundups', () => {
  it('lists cancellations by departure, then delays worst first', () => {
    const items = [
      railIncident({ id: 'd1', late: 20, train: '1' }),
      railIncident({ id: 'c1', source: 'cancellation', train: '2', dep: hourStart - 20 * MIN }),
      railIncident({ id: 'd2', late: 45, train: '3', from: 'Trenton', to: 'Chestnut Hill West' }),
      railIncident({ id: 'c2', source: 'cancellation', train: '4', dep: hourStart - 40 * MIN }),
    ].map((inc) => ({ inc, det: inc.detections[0] }));
    expect(rollupLines(items).lines).toEqual([
      '❌ Cancelled: 10:20 AM Thorndale → Temple U (#4)',
      '❌ Cancelled: 10:40 AM Thorndale → Temple U (#2)',
      '🐌 45 min late: 10:10 AM Trenton → Chestnut Hill West (#3)',
      '🐌 20 min late: 10:10 AM Thorndale → Temple U (#1)',
    ]);
  });

  it('caps each list with a count of the rest', () => {
    const items = Array.from({ length: 13 }, (_, i) =>
      railIncident({ id: `d${i}`, late: 15 + i, train: String(i) }),
    ).map((inc) => ({ inc, det: inc.detections[0] }));
    const { lines, listed } = rollupLines(items);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe('…and 3 more delayed trains');
    expect(listed.at(-1)).toBeNull();
  });

  it("posts the last hour's trains once, at 14 past, and links each to the roundup", async () => {
    const t = testPoster();
    const incidents = byId([
      railIncident({ id: 'delay-a', late: 32 }),
      railIncident({ id: 'cancel-b', source: 'cancellation', train: '9264' }),
      railIncident({ id: 'delay-old', firstSeen: hourStart - 2 * HOUR }),
      railIncident({ id: 'delay-new', firstSeen: hourStart + MIN }),
    ]);
    const args = { incidents, poster: t.poster, db: t.db };
    expect(await maybePostRailRollup({ ...args, now: hourStart + 10 * MIN })).toBeNull();
    expect(await maybePostRailRollup({ ...args, now: hourStart + 15 * MIN })).toEqual({
      posts: 1,
      trains: 2,
    });
    const post = t.client.posts[0];
    expect(post.account).toBe('rail');
    expect(post.opts.text).toBe(
      [
        '🚆 Regional Rail · 10:00–11:00 AM',
        '❌ Cancelled: 10:10 AM Thorndale → Temple U (#9264)\n🐌 32 min late: 10:10 AM Thorndale → Temple U (#9531)',
        `Per SEPTA's TrainView · 🔗 ${new URL(SITE_ORIGIN).host}`,
      ].join('\n\n'),
    );
    expect(post.opts.facets).toHaveLength(1);
    expect(await maybePostRailRollup({ ...args, now: hourStart + 20 * MIN })).toBeNull();
    expect(linkDetectionPosts(incidents, t.poster)).toBe(2);
    expect(incidents.get('delay-a').detections[0].post_url).toMatch(/^https:\/\/bsky\.app\//);
    expect(incidents.get('delay-old').detections[0].post_url).toBeNull();
  });

  it('stays quiet when nothing happened, and splits busy hours into a thread', async () => {
    const t = testPoster();
    const now = hourStart + 15 * MIN;
    expect(
      await maybePostRailRollup({ incidents: new Map(), poster: t.poster, db: t.db, now }),
    ).toEqual({ posts: 0, trains: 0 });
    const busy = byId(
      Array.from({ length: 12 }, (_, i) =>
        railIncident({
          id: `x${i}`,
          source: i % 2 ? 'delay' : 'cancellation',
          train: String(9000 + i),
        }),
      ),
    );
    const t2 = testPoster();
    const stats = await maybePostRailRollup({ incidents: busy, poster: t2.poster, db: t2.db, now });
    expect(stats.posts).toBeGreaterThan(1);
    expect(stats.trains).toBe(12);
    expect(t2.client.posts.every((p) => graphemeLength(p.opts.text) <= 300)).toBe(true);
    expect(t2.client.posts[1].opts.reply.parent.uri).toBe(t2.client.posts[0].uri);
  });
});

describe('Regional Rail recaps', () => {
  // A week of trains: Paoli/Thorndale mostly late, Trenton mostly on time.
  function seedWeek(db) {
    for (let d = 1; d <= 7; d++) {
      const ts = Date.UTC(2026, 9, d, 16); // noon in Philadelphia
      const trains = [];
      for (let i = 0; i < 40; i++) {
        const late = i < 30 ? 2 : i < 38 ? 20 : 999;
        trains.push({
          trainno: `5${i}`,
          line: 'Paoli/Thorndale',
          SOURCE: 'Thorndale',
          dest: 'Temple U',
          late,
        });
        trains.push({
          trainno: `7${i}`,
          line: 'Trenton',
          SOURCE: 'Trenton',
          dest: 'Doylestown',
          late: i < 39 ? 1 : 16,
        });
      }
      recordTrains(db, ts, trains);
      // Later the same day, one Trenton train got much later.
      recordTrains(db, ts + HOUR, [
        { trainno: '70', line: 'Trenton', SOURCE: 'Trenton', late: d === 3 ? 48 : 3 },
      ]);
    }
  }

  it('tallies each train once a day, keeping its worst lateness', () => {
    const { db } = testPoster();
    const ts = Date.UTC(2026, 9, 6, 16);
    recordTrains(db, ts, [{ trainno: '9531', line: 'Paoli/Thorndale', late: 999 }]);
    recordTrains(db, ts + MIN, [{ trainno: '9531', line: 'Paoli/Thorndale', late: 12 }]);
    recordTrains(db, ts + 2 * MIN, [{ trainno: '9531', line: 'Paoli/Thorndale', late: 4 }]);
    expect(db.prepare('SELECT * FROM rail_trains').all()).toMatchObject([
      {
        service_date: '2026-10-06',
        train_no: '9531',
        line: 'pao',
        max_late: 12,
        ran: 1,
        cancelled: 1,
      },
    ]);
    // A train SEPTA cancelled but later ran counts as having run.
    expect(railRecapStats(db, { fromKey: '2026-10-06', toKey: '2026-10-06' })).toMatchObject({
      trains: 1,
      cancelled: 0,
      onTime: 1,
    });
  });

  it('computes on-time share, cancellations, the least reliable lines, and the worst delay', () => {
    const { db } = testPoster();
    seedWeek(db);
    const stats = railRecapStats(db, { fromKey: '2026-10-01', toKey: '2026-10-07' });
    expect(stats).toMatchObject({ trains: 560, cancelled: 14, late: 64 });
    expect(stats.lines.map((l) => l.line)).toEqual(['pao', 'tre']);
    expect(stats.worst).toMatchObject({ train_no: '70', max_late: 48 });
    const { text, chart, alt } = composeRailRecap(stats, { label: 'Oct 1 – Oct 7' });
    expect(text.split('\n\n')).toEqual([
      '🚆 Regional Rail recap · Oct 1 – Oct 7',
      'On time (under 15 min late, not cancelled): 86.1% of 560 trains',
      'Least reliable: Paoli/Thorndale 75% · Trenton 97%\nCancelled: 14\nWorst delay: 48 min, #70 from Trenton (Oct 3)',
      "Counts every train on SEPTA's TrainView.",
    ]);
    expect(graphemeLength(text)).toBeLessThanOrEqual(300);
    expect(chart.rows.map((r) => r.display)).toEqual(['75%', '97%']);
    expect(alt).toContain('Paoli/Thorndale 75%, Trenton 97%');
  });

  it('covers the past week on Sundays and the past month on the 1st', () => {
    expect(recapWindow('week', Date.UTC(2026, 9, 11, 14, 40))).toEqual({
      fromKey: '2026-10-04',
      toKey: '2026-10-10',
      label: 'Oct 4 – Oct 10',
    });
    expect(recapWindow('month', Date.UTC(2026, 10, 1, 14, 50))).toEqual({
      fromKey: '2026-10-01',
      toKey: '2026-10-31',
      label: 'October 2026',
    });
    expect(recapWindow('month', Date.UTC(2027, 0, 1, 15, 50))).toMatchObject({
      fromKey: '2026-12-01',
      toKey: '2026-12-31',
    });
  });

  it('posts the recap once with its chart, and skips a window it barely saw', async () => {
    const t = testPoster();
    const sunday = Date.UTC(2026, 9, 11, 14, 40);
    expect(
      await postRailRecap({ db: t.db, poster: t.poster, now: sunday, period: 'week' }),
    ).toMatchObject({
      skipped: 'too-few-trains',
    });
    for (let d = 4; d <= 10; d++) {
      recordTrains(
        t.db,
        Date.UTC(2026, 9, d, 16),
        Array.from({ length: 40 }, (_, i) => ({
          trainno: String(i),
          line: 'Media/Wawa',
          late: i % 8 ? 0 : 25,
        })),
      );
    }
    const r = await postRailRecap({ db: t.db, poster: t.poster, now: sunday, period: 'week' });
    expect(r).toMatchObject({ posted: 'week', trains: 280 });
    const post = t.client.posts[0];
    expect(post.account).toBe('rail');
    expect(post.opts.text).toMatch(/^🚆 Regional Rail recap · Oct 4 – Oct 10/);
    expect(await sharp(post.opts.image.data).metadata()).toMatchObject({
      format: 'jpeg',
      width: 1200,
    });
    expect(
      await postRailRecap({ db: t.db, poster: t.poster, now: sunday, period: 'week' }),
    ).toEqual({
      skipped: 'posted',
    });
  });

  it('keeps a year of tallies', () => {
    const { db } = testPoster();
    recordTrains(db, Date.UTC(2025, 0, 2, 16), [{ trainno: '1', line: 'Trenton', late: 0 }]);
    recordTrains(db, Date.UTC(2026, 9, 2, 16), [{ trainno: '1', line: 'Trenton', late: 0 }]);
    pruneDb(db, Date.UTC(2026, 9, 6), { observationRetentionDays: 3 });
    expect(db.prepare('SELECT service_date FROM rail_trains').all()).toEqual([
      { service_date: '2026-10-02' },
    ]);
  });
});

describe('bar charts', () => {
  it('draws bars from a zero baseline with values at the tips', async () => {
    const { svg, height } = barChartSvg({
      title: 'T',
      subtitle: 'S',
      rows: [
        { label: 'A', value: 50, display: '50%' },
        { label: 'B', value: 100, display: '100%' },
      ],
      max: 100,
      ticks: [0, 50, 100],
      tickFormat: (v) => `${v}%`,
    });
    expect(height).toBe(150 + 2 * 46 + 70);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('>100%</text>');
    const jpg = await renderBarChart({ title: 'T', rows: [{ label: 'A', value: 1 }] });
    expect((await sharp(jpg).metadata()).format).toBe('jpeg');
  });
});
