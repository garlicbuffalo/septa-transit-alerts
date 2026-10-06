import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadSite(env) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import('../lib/site.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Bluesky bot accounts', () => {
  it('lists none until handles are configured', async () => {
    const site = await loadSite({
      SITE_URL: 'https://philly-transit-alerts.fyi',
      BLUESKY_HANDLES: '',
      VITE_BLUESKY_HANDLES: '',
    });
    expect(site.BLUESKY_ACCOUNTS).toEqual([]);
  });

  it('takes explicit handles, in account order', async () => {
    const site = await loadSite({
      SITE_URL: 'https://philly-transit-alerts.fyi',
      BLUESKY_HANDLES: 'bus=@septabus.bsky.social, alerts=septaalerts.bsky.social',
    });
    expect(site.BLUESKY_ACCOUNTS.map((a) => [a.key, a.handle])).toEqual([
      ['alerts', 'septaalerts.bsky.social'],
      ['bus', 'septabus.bsky.social'],
    ]);
    expect(site.BLUESKY_ACCOUNTS[0].url).toBe('https://bsky.app/profile/septaalerts.bsky.social');
  });
});
