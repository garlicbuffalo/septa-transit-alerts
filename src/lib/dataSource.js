// Single source of truth for where the client fetches the published data files
// (alerts-recent.json, the monthly shards, accessibility.json, …).
//
// By default the data is served from the site's own origin under /data — the
// deploy workflow copies the collector's `data` branch into the build, so the
// site works with no other infrastructure. Point VITE_DATA_BASE_URL at a live
// data origin to decouple data freshness from site deploys, e.g. the `data`
// branch on raw.githubusercontent.com (public repos) or an object-storage
// bucket the collector syncs to. The origin must allow CORS for the site.
export const DATA_ORIGIN = String(import.meta.env.VITE_DATA_BASE_URL || '/data').replace(
  /\/+$/,
  '',
);

/** URL for a published data file, e.g. dataUrl('alerts-recent.json'). */
export const dataUrl = (file) => `${DATA_ORIGIN}/${file}`;
