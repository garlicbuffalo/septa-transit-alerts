#!/usr/bin/env node
// Operator commands for the bot service (same configuration as main.js):
//
//   node bot/cli.js check          verify credentials: each Bluesky account,
//                                  the Mapbox token, the GitHub token
//   node bot/cli.js once           one observe + collect tick, then exit
//   node bot/cli.js map <id>       render the alert map for an incident in
//                                  the data directory to the assets folder
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBlueskyClient } from './lib/bluesky.js';
import { loadConfig } from './lib/config.js';
import { createRuntime, log } from './lib/runtime.js';
import { staticMapUrl } from './map/basemap.js';
import { renderAlertMap } from './map/lineMap.js';

const config = loadConfig();
const [command, ...args] = process.argv.slice(2);

async function check() {
  let ok = true;
  const say = (good, msg) => {
    if (!good) ok = false;
    log(`${good ? '✓' : '✗'} ${msg}`);
  };
  log(`mode: ${config.live ? 'live' : 'dry run'} · state: ${config.stateDir}`);
  const client = createBlueskyClient({
    service: config.blueskyService,
    accounts: config.accounts,
    sessionDir: config.sessionDir,
  });
  for (const [name, creds] of Object.entries(config.accounts)) {
    if (!creds) {
      say(
        !config.live,
        `Bluesky ${name}: no credentials${config.live ? '' : ' (fine for a dry run)'}`,
      );
      continue;
    }
    try {
      const me = await client.whoami(name);
      say(true, `Bluesky ${name}: logged in as @${me.handle} (${me.did})`);
    } catch (err) {
      say(false, `Bluesky ${name}: ${err.message}`);
    }
  }
  if (config.mapboxToken) {
    const url = staticMapUrl(
      { lat: 39.9526, lon: -75.1652, zoom: 12, width: 64, height: 64 },
      config.mapboxToken,
    );
    const res = await fetch(url).catch((err) => ({ ok: false, status: err.message }));
    say(res.ok, `Mapbox token: ${res.ok ? 'works' : `HTTP ${res.status}`}`);
  } else {
    say(true, 'Mapbox token: not set (maps use a plain background)');
  }
  if (config.github.token) {
    const res = await fetch(`https://api.github.com/repos/${config.github.repo}`, {
      headers: {
        authorization: `Bearer ${config.github.token}`,
        'user-agent': 'septa-transit-bots',
      },
    }).catch((err) => ({ ok: false, status: err.message }));
    const body = res.ok ? await res.json() : null;
    say(
      res.ok && body?.permissions?.push !== false,
      `GitHub token for ${config.github.repo}: ${res.ok ? 'works' : `HTTP ${res.status}`}`,
    );
  } else {
    say(!config.publish, 'GitHub token: not set (publishing off)');
  }
  process.exit(ok ? 0 : 1);
}

async function once() {
  const { pipeline, publisher, db } = createRuntime(config);
  await publisher.prepare();
  await pipeline.loadShapes();
  log(`observe: ${JSON.stringify(await pipeline.observe())}`);
  const { summary } = await pipeline.collectTick();
  log(JSON.stringify(summary.hook ?? {}, null, 2));
  db.close();
}

async function map(id) {
  const { basemap, db } = createRuntime(config);
  const recent = JSON.parse(await readFile(join(config.dataDir, 'alerts-recent.json'), 'utf8'));
  const incident = recent.incidents.find((i) => i.id === id);
  if (!incident) throw new Error(`no incident ${id} in ${config.dataDir}`);
  const jpg = await renderAlertMap(incident, { basemap });
  if (!jpg) {
    log(`${id}: nothing to map (no named stations on a Metro or Regional Rail line)`);
  } else {
    await mkdir(config.assetsDir, { recursive: true });
    const path = join(config.assetsDir, `map-${id}.jpg`);
    await writeFile(path, jpg);
    log(`wrote ${path}`);
  }
  db.close();
}

if (command === 'check') await check();
else if (command === 'once') await once();
else if (command === 'map' && args[0]) await map(args[0]);
else {
  log('usage: node bot/cli.js check | once | map <incident-id>');
  process.exit(2);
}
