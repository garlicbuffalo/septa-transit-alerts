import { describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config.js';
import { acquireCooldown, clearCooldown, getMeta, openDb, pruneDb, setMeta } from '../lib/db.js';
import { observationsSince, recordObservations } from '../lib/observations.js';
import { createPoster } from '../lib/poster.js';
import { cronMatcher, easternFields } from '../lib/scheduler.js';
import { fakeLiveClient, NOW } from './helpers.js';

describe('config', () => {
  it('defaults to a dry run that never publishes', () => {
    const c = loadConfig({ GITHUB_TOKEN: 'ambient-token' });
    expect(c.live).toBe(false);
    expect(c.publish).toBe(false);
    expect(c.github.token).toBeNull();
  });

  it('publishes only with PUBLISH=1 and the bot token', () => {
    expect(loadConfig({ PUBLISH: '1' }).publish).toBe(false);
    expect(loadConfig({ BOT_GITHUB_TOKEN: 't' }).publish).toBe(false);
    expect(loadConfig({ PUBLISH: '1', BOT_GITHUB_TOKEN: 't' }).publish).toBe(true);
  });

  it('needs both halves of an account', () => {
    const c = loadConfig({
      BOT_MODE: 'live',
      BLUESKY_ALERTS_IDENTIFIER: 'alerts.example',
      BLUESKY_ALERTS_APP_PASSWORD: 'pw',
      BLUESKY_BUS_IDENTIFIER: 'bus.example',
    });
    expect(c.live).toBe(true);
    expect(c.accounts.alerts).toEqual({ identifier: 'alerts.example', password: 'pw' });
    expect(c.accounts.bus).toBeNull();
  });

  it('turns timelapses on by default, under the daily video cap', () => {
    expect(loadConfig({})).toMatchObject({ videos: true, ffmpegPath: 'ffmpeg', videoDailyCap: 20 });
    expect(loadConfig({ VIDEOS: '0', VIDEO_DAILY_CAP: '10' })).toMatchObject({
      videos: false,
      videoDailyCap: 10,
    });
  });
});

describe('database', () => {
  it('migrates and stores meta', () => {
    const db = openDb(':memory:');
    expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    setMeta(db, 'k', 5);
    expect(getMeta(db, 'k')).toBe('5');
  });

  it('acquires cooldowns all-or-nothing', () => {
    const db = openDb(':memory:');
    expect(acquireCooldown(db, ['a', 'b'], NOW, 60_000)).toBe(true);
    expect(acquireCooldown(db, ['b', 'c'], NOW + 1000, 60_000)).toBe(false);
    expect(acquireCooldown(db, ['c'], NOW + 1000, 60_000)).toBe(true);
    expect(acquireCooldown(db, ['a'], NOW + 61_000, 60_000)).toBe(true);
    clearCooldown(db, ['c']);
    expect(acquireCooldown(db, ['c'], NOW + 2000, 60_000)).toBe(true);
  });

  it('records and prunes observations', () => {
    const db = openDb(':memory:');
    recordObservations(db, NOW - 5 * 86_400_000, {
      vehicles: [{ id: 'v1', mode: 'bus', route: '17', lat: 39.9, lon: -75.1 }],
    });
    recordObservations(db, NOW, {
      vehicles: [{ id: 'v2', mode: 'bus', route: '17', lat: 39.9, lon: -75.1, heading: 90 }],
      trains: [
        {
          trainno: '3556',
          line: 'Lansdale/Doylestown',
          lat: '40.09',
          lon: '-75.13',
          late: 22,
          dest: 'Doylestown',
        },
        { trainno: '1', line: 'Nowhere', lat: '40', lon: '-75' },
      ],
    });
    const rows = observationsSince(db, { since: NOW - 1000 });
    expect(rows.map((r) => [r.mode, r.route, r.vehicle_id])).toEqual([
      ['regional_rail', 'lan', '3556'],
      ['bus', '17', 'v2'],
    ]);
    expect(pruneDb(db, NOW, { observationRetentionDays: 3 }).observations).toBe(1);
  });

  it('remembers when posting began for each mode', () => {
    const db = openDb(':memory:');
    let t = NOW;
    const poster = createPoster({ db, client: fakeLiveClient(), now: () => t });
    expect(poster.since()).toBe(NOW);
    t += 60_000;
    expect(poster.since()).toBe(NOW);
  });
});

describe('scheduler', () => {
  it('reads Philadelphia wall-clock time across DST', () => {
    // 2026-10-06 14:20 UTC = 10:20 EDT (Tuesday); 2026-12-06 15:20 UTC = 10:20 EST (Sunday).
    expect(easternFields(Date.UTC(2026, 9, 6, 14, 20))).toMatchObject({
      hour: 10,
      minute: 20,
      weekday: 2,
    });
    expect(easternFields(Date.UTC(2026, 11, 6, 15, 20))).toMatchObject({
      hour: 10,
      minute: 20,
      weekday: 0,
    });
  });

  it('matches cron specs in Eastern time', () => {
    const sundayRecap = cronMatcher('20 10 * * 0');
    expect(sundayRecap(Date.UTC(2026, 11, 6, 15, 20))).toBe(true);
    expect(sundayRecap(Date.UTC(2026, 11, 6, 14, 20))).toBe(false);
    const everyTwo = cronMatcher('1-59/2 * * * *');
    expect(everyTwo(Date.UTC(2026, 9, 6, 14, 21))).toBe(true);
    expect(everyTwo(Date.UTC(2026, 9, 6, 14, 22))).toBe(false);
    const firstOfMonth = cronMatcher('30 10 1 * *');
    expect(firstOfMonth(Date.UTC(2026, 10, 1, 15, 30))).toBe(true);
  });
});
