// Runtime configuration, read once from the environment. On the server the
// values come from /etc/septa-bots.env via the systemd unit (EnvironmentFile);
// locally, `node --env-file=bot/.env bot/main.js`. Every setting has a safe
// default: with nothing configured the service collects, renders, and logs
// what it would post, but never posts or pushes.
import { join, resolve } from 'node:path';

/**
 * The four Bluesky accounts and what each posts. The alerts account is titled
 * "insights" on Bluesky; its key (and the BLUESKY_ALERTS_* settings) stay.
 */
export const ACCOUNTS = {
  alerts:
    'Insights: SEPTA’s official alerts with a ✅ reply when they clear, system-wide digests ' +
    'and rough-hour callouts, and reposts of the other accounts’ standout posts',
  metro: 'SEPTA Metro detections (subway, trolleys, M1)',
  bus: 'Bus detections',
  rail: 'Regional Rail delays, cancellations, and recaps',
};

const bool = (v, fallback) => {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
};
const num = (v, fallback) => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? fallback : n;
};

/**
 * @param {Record<string, string | undefined>} [env]
 */
export function loadConfig(env = process.env) {
  const stateDir = resolve(env.STATE_DIR || 'bot-state');
  const accounts = {};
  for (const name of Object.keys(ACCOUNTS)) {
    const prefix = `BLUESKY_${name.toUpperCase()}`;
    const identifier = env[`${prefix}_IDENTIFIER`]?.trim();
    const password = env[`${prefix}_APP_PASSWORD`]?.trim();
    accounts[name] = identifier && password ? { identifier, password } : null;
  }
  // A dedicated variable, so a GITHUB_TOKEN that happens to be in the
  // environment (CI runners, dev shells) can never publish by accident.
  const githubToken = env.BOT_GITHUB_TOKEN?.trim() || null;
  return {
    // Posting is off unless BOT_MODE=live. Dry runs still render every post
    // and write it (text, alt text, image or video) to assetsDir.
    live: String(env.BOT_MODE ?? '').trim() === 'live',
    stateDir,
    dbPath: env.BOT_DB_PATH ? resolve(env.BOT_DB_PATH) : join(stateDir, 'bots.sqlite'),
    sessionDir: join(stateDir, 'bluesky-sessions'),
    cacheDir: join(stateDir, 'cache'),
    assetsDir: join(stateDir, 'assets'),
    dataDir: env.DATA_DIR ? resolve(env.DATA_DIR) : join(stateDir, 'data'),
    backupDir: join(stateDir, 'backups'),
    // Read SEPTA's feeds from collector-style fixture files instead of the
    // network (tests and offline development).
    fixturesDir: env.FIXTURES_DIR ? resolve(env.FIXTURES_DIR) : null,
    blueskyService: env.BLUESKY_SERVICE?.trim() || 'https://bsky.social',
    accounts,
    // Map tiles (map/basemap.js): CARTO's dark map through the tracker's relay
    // (TILES_URL) or directly with a key (CARTO_KEY, with CARTO_REFERER for a key
    // limited to a domain); a Mapbox token is the fallback.
    tilesUrl: env.TILES_URL?.trim() || null,
    cartoKey: env.CARTO_KEY?.trim() || null,
    cartoReferer: env.CARTO_REFERER?.trim() || null,
    mapboxToken: env.MAPBOX_TOKEN?.trim() || null,
    github: {
      token: githubToken,
      repo: env.GITHUB_REPO?.trim() || 'garlicbuffalo/septa-transit-alerts',
      dataBranch: env.DATA_BRANCH?.trim() || 'data',
      deployWorkflow: env.DEPLOY_WORKFLOW?.trim() || 'deploy.yml',
      deployRef: env.DEPLOY_REF?.trim() || 'main',
    },
    // Push the data branch and trigger deploys: only with PUBLISH=1 and a
    // BOT_GITHUB_TOKEN. Off by default, so test runs never touch the site.
    publish: bool(env.PUBLISH, false) && githubToken != null,
    healthcheckUrl: env.HEALTHCHECK_URL?.trim() || null,
    intervals: {
      observeMs: num(env.OBSERVE_INTERVAL_S, 60) * 1000,
      collectMs: num(env.COLLECT_INTERVAL_S, 120) * 1000,
    },
    // Deploys: at most one per deployMinGapMs for rider-visible changes; other
    // changes ride the deploy workflow's own 30-minute schedule.
    deployMinGapMs: num(env.DEPLOY_MIN_GAP_MIN, 10) * 60 * 1000,
    observationRetentionDays: num(env.OBSERVATION_RETENTION_DAYS, 3),
    // Timelapse videos (needs ffmpeg): replies under gap, bunching, and
    // cluster posts, and the system snapshots. Bluesky caps video uploads
    // per account per day; VIDEO_DAILY_CAP stays under it.
    videos: bool(env.VIDEOS, true),
    ffmpegPath: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    videoDailyCap: num(env.VIDEO_DAILY_CAP, 20),
    // Never post an incident first seen longer ago than this (covers restarts
    // and the first start, so a backlog never floods the feed).
    postMaxAgeMs: num(env.POST_MAX_AGE_MIN, 30) * 60 * 1000,
  };
}
