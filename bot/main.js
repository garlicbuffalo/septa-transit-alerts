#!/usr/bin/env node
// SEPTA Transit Alerts bot service: the always-on collector and Bluesky
// poster. Runs under systemd on the project's server (see bot/README.md);
// configuration comes from the environment (see bot/lib/config.js and
// bot/deploy/septa-bots.env.example).
import { loadConfig } from './lib/config.js';
import { createRuntime, log } from './lib/runtime.js';
import { createScheduler } from './lib/scheduler.js';

const config = loadConfig();
const { db, publisher, pipeline } = createRuntime(config);

log(
  `septa-bots starting: ${config.live ? 'LIVE posting' : 'dry run (BOT_MODE=live to post)'}, ` +
    `publishing ${config.publish ? `to ${config.github.repo}@${config.github.dataBranch}` : 'off'}, ` +
    `state in ${config.stateDir}`,
);
const prepared = await publisher.prepare();
log(`data: ${prepared.fetched ? 'resumed from the published branch' : 'local only'}`);
const shapes = await pipeline.loadShapes();
log(
  `maps: ${shapes ? 'route shapes loaded' : 'no route shapes; detection posts will be text-only'}`,
);
const video = await pipeline.checkVideo();
log(
  `video: ${video ? 'timelapses on' : config.videos ? `no ffmpeg at "${config.ffmpegPath}"; timelapses off` : 'timelapses off (VIDEOS=0)'}`,
);

const scheduler = createScheduler({ log });
scheduler.every('observe', config.intervals.observeMs, () => pipeline.observe());
scheduler.every('collect', config.intervals.collectMs, () => pipeline.collectTick(), {
  delayMs: 15_000,
});
scheduler.every('sample', 15_000, () => pipeline.sampleCaptures());
scheduler.every('render', 30_000, () => pipeline.renderCaptures(), { delayMs: 20_000 });
scheduler.cron('snapshot', '0 8,11,14,17,20 * * *', () => pipeline.startSnapshots());
scheduler.cron('rail-recap-week', '40 10 * * 0', async () =>
  log(`rail recap: ${JSON.stringify(await pipeline.railRecap('week'))}`),
);
scheduler.cron('rail-recap-month', '50 10 1 * *', async () =>
  log(`rail recap: ${JSON.stringify(await pipeline.railRecap('month'))}`),
);
scheduler.cron('housekeeping', '7 * * * *', async () => {
  const r = await pipeline.housekeeping();
  log(
    `housekeeping: pruned ${r.observations} observations, ${r.samples} timelapse samples, ${r.assetDays} asset days`,
  );
});
scheduler.cron('backup', '17 4 * * *', async () => log(`backup: ${await pipeline.backup()}`));
// The collector rebuilds the shapes with its daily schedule; pick them up.
scheduler.cron('shapes', '40 4 * * *', () => pipeline.loadShapes());
scheduler.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`septa-bots: ${signal}, finishing running jobs…`);
  await scheduler.stop();
  db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
