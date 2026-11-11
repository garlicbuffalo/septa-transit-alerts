// The optional files the collector and the bot server publish beside the
// archive, read by the pages that show them:
//
//   schedule-changes.json  what SEPTA's timetable says is coming (collector)
//   scorecards.json        each route's weekly score and the measures behind it
//                          (bot server; bot/features/scorecards.js)
//   rail-trains.json       each Regional Rail train number's four-week record
//                          (bot server)
//   slow-zones.json        the slowest stretches of the past week, for the
//                          system map (bot server; bot/features/slowzones.js)
//
// Any of them can be missing: the bot server's aren't there when only the
// GitHub Actions collector runs, and a page then says so instead of failing.
import { dataUrl } from './dataSource.js';

const SUPPORTED_VERSION = 1;
const cache = new Map();

async function fetchOptional(file) {
  try {
    const res = await fetch(dataUrl(file), { cache: 'no-cache' });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.schema_version === SUPPORTED_VERSION ? body : null;
  } catch {
    // A missing file can come back as the site's HTML page, or as nothing.
    return null;
  }
}

/** A published file's contents, or null when it isn't there. One fetch per page load. */
export function loadPublished(file) {
  if (!cache.has(file)) cache.set(file, fetchOptional(file));
  return cache.get(file);
}

export const loadScheduleChanges = () => loadPublished('schedule-changes.json');
export const loadScorecards = () => loadPublished('scorecards.json');
export const loadRailTrains = () => loadPublished('rail-trains.json');
export const loadSlowZones = () => loadPublished('slow-zones.json');

/** For tests: forget what has been fetched. */
export function __resetPublishedFiles() {
  cache.clear();
}
