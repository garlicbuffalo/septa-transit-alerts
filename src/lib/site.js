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
