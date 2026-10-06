import { describe, expect, it } from 'vitest';
import {
  alertBody,
  alertGate,
  alertPostText,
  clearedPostText,
  linkAlertPosts,
  postAlerts,
} from '../features/alerts.js';
import { createDryRunClient } from '../lib/bluesky.js';
import { graphemeLength } from '../lib/text.js';
import { NOW, officialIncident, testPoster } from './helpers.js';

const asMap = (...incs) => new Map(incs.map((i) => [i.id, i]));

describe('alertGate', () => {
  it('posts every real-time alert', () => {
    expect(alertGate(officialIncident({ type: 'ALERT' })).post).toBe(true);
  });

  it('posts advisories riders must plan around', () => {
    for (const headline of [
      'Shuttle Busing Between Olney and Fern Rock Transit Center',
      '11th St Station Closed',
      'Potential Delays due to Amtrak Infrastructure Project',
    ]) {
      expect(alertGate(officialIncident({ type: 'ADVISORY', headline })).post).toBe(true);
    }
  });

  it('skips platform, boarding, and bus-stop notices', () => {
    for (const headline of [
      'Westbound Platform Boarding Baltimore Ave to Drexel Hill Junction Stations',
      'Boarding Location Changes Morton to Media Stations',
      'Notice of Bus Stop Changes',
      'Notice of Bus Detour due to Construction',
    ]) {
      const gate = alertGate(officialIncident({ type: 'ADVISORY', headline }));
      expect(gate).toEqual({ post: false, reason: 'minor-advisory' });
    }
  });

  it('posts unplanned detours only', () => {
    const detour = (headline, cause) =>
      officialIncident({
        id: 'detour-d1',
        mode: 'bus',
        routes: ['17'],
        type: 'DETOUR',
        headline,
        cause,
      });
    expect(alertGate(detour('Detour: Construction', 'CONSTRUCTION')).post).toBe(false);
    expect(alertGate(detour('Detour: Police Activity', 'UNKNOWN_CAUSE')).post).toBe(true);
    expect(alertGate(detour('Detour: Peco', 'ACCIDENT')).post).toBe(true);
  });
});

describe('alert post text', () => {
  it('prefixes the route and drops a description that repeats the headline', () => {
    const inc = officialIncident({
      headline: 'Westbound trains are on the move with residual delays.',
      description: 'Westbound trains are on the move with residual delays.',
    });
    const { text } = alertPostText(inc);
    expect(text.split('\n')[0]).toBe(
      '🚇⚠️ L1: Westbound trains are on the move with residual delays.',
    );
    expect(text).not.toMatch(/delays\.\n\nWestbound/);
    expect(text).toMatch(/\n\nPer SEPTA · septa\.org · /);
  });

  it("doesn't repeat a route the headline already names", () => {
    const inc = officialIncident({
      mode: 'regional_rail',
      routes: ['wil'],
      headline: 'Wilmington/Newark Line trains are delayed',
    });
    expect(alertPostText(inc).text.split('\n')[0]).toBe(
      '🚆⚠️ Wilmington/Newark Line trains are delayed',
    );
  });

  it('strips SEPTA boilerplate and links septa.org and the event page', () => {
    const inc = officialIncident({
      id: 'alert-136615',
      routes: ['b1', 'b2', 'b3'],
      type: 'ADVISORY',
      headline: 'Shuttle Busing Between Olney and Fern Rock Transit Center',
      description:
        'Bus service replaces trains from Olney to Fern Rock Transit Center. For details and schedules, visit SEPTA.org.',
    });
    expect(alertBody(inc.official_alert)).toBe(
      'Bus service replaces trains from Olney to Fern Rock Transit Center.',
    );
    const { text, facets } = alertPostText(inc);
    expect(text.startsWith('🚇⚠️ B1/B2/B3: Shuttle Busing')).toBe(true);
    const uris = facets.map((f) => f.features[0].uri);
    expect(uris[0]).toBe('https://www.septa.org/schedules/b1');
    expect(uris[1]).toMatch(/\/event\/alert-136615$/);
  });

  it('stays within 300 graphemes', () => {
    const inc = officialIncident({
      headline: 'Delays '.repeat(30),
      description: 'Word '.repeat(200),
    });
    expect(graphemeLength(alertPostText(inc).text)).toBeLessThanOrEqual(300);
    expect(graphemeLength(clearedPostText(inc).text)).toBeLessThanOrEqual(300);
  });
});

describe('postAlerts', () => {
  it('posts a new alert once, with a map when one renders', async () => {
    const { poster, client } = testPoster();
    const inc = officialIncident();
    const renderMap = async () => Buffer.from('jpeg');
    const first = await postAlerts({
      incidents: asMap(inc),
      poster,
      now: NOW,
      maxAgeMs: 1_800_000,
      renderMap,
    });
    expect(first.posted).toBe(1);
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].account).toBe('alerts');
    expect(client.posts[0].opts.image.data.toString()).toBe('jpeg');
    const again = await postAlerts({
      incidents: asMap(inc),
      poster,
      now: NOW + 120_000,
      maxAgeMs: 1_800_000,
      renderMap,
    });
    expect(again.posted).toBe(0);
    expect(client.posts).toHaveLength(1);
  });

  it('attaches a link card to the event page when there is no map', async () => {
    const { poster, client } = testPoster();
    await postAlerts({
      incidents: asMap(officialIncident()),
      poster,
      now: NOW,
      maxAgeMs: 1_800_000,
    });
    expect(client.posts[0].opts.link.url).toMatch(/\/event\/alert-1$/);
  });

  it('never posts backlog: alerts seen before posting began, stale, filtered, or already over', async () => {
    const { poster, client } = testPoster(undefined, { since: NOW - 10 * 60_000 });
    const incidents = asMap(
      officialIncident({ id: 'alert-old', firstSeen: NOW - 20 * 60_000 }),
      officialIncident({ id: 'alert-gone', resolvedTs: NOW - 1000 }),
      officialIncident({
        id: 'alert-minor',
        type: 'ADVISORY',
        headline: 'Notice of Bus Stop Changes',
      }),
    );
    const stats = await postAlerts({ incidents, poster, now: NOW, maxAgeMs: 30 * 60_000 });
    expect(stats).toMatchObject({ posted: 0, skipped: 3 });
    expect(client.posts).toHaveLength(0);
    expect(poster.skipped('septa-alert:old')).toBe('before-posting-started');
    expect(poster.skipped('septa-alert:gone')).toBe('resolved-before-post');
    expect(poster.skipped('septa-alert:minor')).toBe('minor-advisory');
  });

  it('replies ✅ in the thread when the alert clears, once', async () => {
    const { poster, client } = testPoster();
    const inc = officialIncident();
    await postAlerts({ incidents: asMap(inc), poster, now: NOW, maxAgeMs: 1_800_000 });
    const cleared = officialIncident({ resolvedTs: NOW + 600_000 });
    const stats = await postAlerts({
      incidents: asMap(cleared),
      poster,
      now: NOW + 700_000,
      maxAgeMs: 1_800_000,
    });
    expect(stats.cleared).toBe(1);
    const reply = client.posts[1];
    expect(reply.opts.text).toMatch(/^🚇✅ SEPTA has cleared this L1 alert: /);
    expect(reply.opts.reply.root.uri).toBe(client.posts[0].uri);
    expect(reply.opts.link.url).toMatch(/\/event\/alert-1\/resolved$/);
    await postAlerts({
      incidents: asMap(cleared),
      poster,
      now: NOW + 900_000,
      maxAgeMs: 1_800_000,
    });
    expect(client.posts).toHaveLength(2);
  });

  it('posts an alert that spans networks once', async () => {
    const { poster, client } = testPoster();
    const metro = officialIncident({ id: 'alert-9', routes: ['l1'] });
    const bus = officialIncident({
      id: 'alert-9-bus',
      alertId: '9',
      mode: 'bus',
      routes: ['L1-OWL'],
    });
    await postAlerts({ incidents: asMap(bus, metro), poster, now: NOW, maxAgeMs: 1_800_000 });
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0].opts.text).toMatch(/^🚇⚠️ L1:/);
  });
});

describe('linkAlertPosts', () => {
  it('writes post and cleared-reply URLs into every part of the alert', async () => {
    const { poster } = testPoster();
    const metro = officialIncident({ id: 'alert-9', routes: ['l1'] });
    const bus = officialIncident({
      id: 'alert-9-bus',
      alertId: '9',
      mode: 'bus',
      routes: ['L1-OWL'],
    });
    const incidents = asMap(metro, bus);
    await postAlerts({ incidents, poster, now: NOW, maxAgeMs: 1_800_000 });
    expect(linkAlertPosts(incidents, poster)).toBe(2);
    expect(incidents.get('alert-9').official_alert.post_url).toBe(
      'https://bsky.app/profile/did:plc:alerts/post/p1',
    );
    expect(incidents.get('alert-9-bus').official_alert.post_url).toBe(
      incidents.get('alert-9').official_alert.post_url,
    );
    expect(linkAlertPosts(incidents, poster)).toBe(0);
  });

  it('never links dry-run posts', async () => {
    const { poster } = testPoster(createDryRunClient({ assetsDir: '/nonexistent' }));
    const incidents = asMap(officialIncident());
    await postAlerts({ incidents, poster, now: NOW, maxAgeMs: 1_800_000 });
    expect(linkAlertPosts(incidents, poster)).toBe(0);
    expect(incidents.get('alert-1').official_alert.post_url).toBeNull();
  });
});
