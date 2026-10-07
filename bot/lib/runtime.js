// Wiring shared by the service (main.js) and the CLI (cli.js): open the
// database and build the Bluesky client, basemap, poster, publisher, and
// pipeline from the config.
import { createBasemap } from '../map/basemap.js';
import { createBlueskyClient, createDryRunClient } from './bluesky.js';
import { openDb } from './db.js';
import { createPipeline } from './pipeline.js';
import { createPoster } from './poster.js';
import { createPublisher } from './publish.js';

export function log(msg) {
  console.log(msg);
}

export function createRuntime(config, { logFn = log } = {}) {
  const db = openDb(config.dbPath);
  const missing = Object.entries(config.accounts)
    .filter(([, creds]) => !creds)
    .map(([name]) => name);
  if (config.live && missing.length === Object.keys(config.accounts).length) {
    throw new Error(
      'BOT_MODE=live but no Bluesky account has credentials. Set ' +
        'BLUESKY_<ACCOUNT>_IDENTIFIER and BLUESKY_<ACCOUNT>_APP_PASSWORD, or use dry-run mode.',
    );
  }
  if (config.live && missing.length) {
    logFn(`bluesky: not posting as ${missing.join(', ')} (no credentials yet)`);
  }
  const client = config.live
    ? createBlueskyClient({
        service: config.blueskyService,
        accounts: config.accounts,
        sessionDir: config.sessionDir,
        log: logFn,
      })
    : createDryRunClient({ assetsDir: config.assetsDir, log: logFn });
  const carto = config.tilesUrl ? 'the relay' : config.cartoKey ? 'a key' : null;
  if (carto) {
    logFn(
      `maps: CARTO tiles through ${carto}${config.mapboxToken ? ', Mapbox as a fallback' : ''}`,
    );
  } else if (config.mapboxToken) {
    logFn('maps: Mapbox (set TILES_URL or CARTO_KEY for the CARTO map the site uses)');
  } else {
    logFn('maps: no TILES_URL, CARTO_KEY, or MAPBOX_TOKEN — maps render on a plain background');
  }
  const basemap = createBasemap({
    token: config.mapboxToken,
    tilesUrl: config.tilesUrl,
    cartoKey: config.cartoKey,
    cartoReferer: config.cartoReferer,
    log: logFn,
  });
  const poster = createPoster({ db, client, log: logFn });
  const publisher = createPublisher({
    dataDir: config.dataDir,
    github: config.github,
    db,
    enabled: config.publish,
    deployMinGapMs: config.deployMinGapMs,
    log: logFn,
  });
  const pipeline = createPipeline({ config, db, poster, basemap, publisher, log: logFn });
  return { db, client, basemap, poster, publisher, pipeline };
}
