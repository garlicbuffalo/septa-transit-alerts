// Site identity shared by the SPA and the Node build scripts (prerender, feeds,
// sitemap). The public origin is configured once, at build time:
//
//   SITE_URL=https://your.domain npm run build      (Node scripts)
//   VITE_SITE_URL=https://your.domain               (baked into the SPA)
//
// deploy.yml sets both from the repository variable SITE_URL. The default is a
// reserved `.example` placeholder so an unconfigured build never points links,
// feeds, or share cards at a domain someone else owns.
const viteEnv = import.meta.env ?? {};
const nodeEnv = globalThis.process?.env ?? {};

export const SITE_ORIGIN = String(
  nodeEnv.SITE_URL || viteEnv.VITE_SITE_URL || 'https://septa-transit-alerts.example',
).replace(/\/+$/, '');

export const SITE_NAME = 'SEPTA Transit Alerts';
export const SITE_TAGLINE = 'SEPTA Metro, bus, and Regional Rail service alerts and disruptions.';
export const SITE_DESCRIPTION =
  'A public archive of SEPTA service alerts and detected disruptions across SEPTA Metro, buses, and Regional Rail, with a 90-day heatmap of incident frequency.';

// The project's Bluesky bots, one account per stream, listed once their
// handles are configured: BLUESKY_HANDLES="alerts=handle,metro=handle,…"
// (VITE_BLUESKY_HANDLES for the SPA), set from the repository variable of the
// same name. Until then the site shows no follow links.
const BOT_ACCOUNTS = [
  {
    key: 'alerts',
    label: 'Alerts',
    emoji: '⚠️',
    description: 'SEPTA’s significant service alerts, with a ✅ reply when they clear.',
  },
  {
    key: 'metro',
    label: 'Metro',
    emoji: '🚇',
    description: 'Gaps, bunching, and stuck trains on SEPTA Metro, from live vehicle positions.',
  },
  {
    key: 'bus',
    label: 'Bus',
    emoji: '🚌',
    description: 'Gaps, bunching, stuck buses, and cancelled trips across SEPTA’s bus routes.',
  },
  {
    key: 'rail',
    label: 'Regional Rail',
    emoji: '🚆',
    description: 'Regional Rail delays and cancellations, speed maps, and on-time recaps.',
  },
];

function blueskyHandles() {
  const raw = String(nodeEnv.BLUESKY_HANDLES || viteEnv.VITE_BLUESKY_HANDLES || '').trim();
  return Object.fromEntries(
    raw
      .split(',')
      .map((pair) => pair.split('=').map((s) => s.trim().replace(/^@/, '')))
      .filter(([key, handle]) => key && handle),
  );
}

const HANDLES = blueskyHandles();

/** Bot accounts with handles and profile URLs; empty when none are configured. */
export const BLUESKY_ACCOUNTS = BOT_ACCOUNTS.filter((a) => HANDLES[a.key]).map((a) => ({
  ...a,
  handle: HANDLES[a.key],
  url: `https://bsky.app/profile/${HANDLES[a.key]}`,
}));
