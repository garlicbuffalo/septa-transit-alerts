// SEPTA public API fetchers. Every source is fetched independently and may fail
// on its own; the caller only applies a source's changes when its fetch
// succeeded, so a flaky endpoint can never mass-resolve live incidents.
//
// A `fixturesDir` (CLI --fixtures) swaps every network read for a fixture file
// (FIXTURE_FILES), for tests and offline development.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ENDPOINTS = {
  // Service advisories, alerts, and detours across every mode.
  alerts: 'https://www3.septa.org/api/v2/alerts/',
  // Live Regional Rail trains: position, minutes late (999 = cancelled), origin,
  // destination, and the line the train is currently on.
  trainView: 'https://www3.septa.org/api/TrainView/index.php',
  // Out-of-service elevators across SEPTA Metro and Regional Rail stations.
  elevators: 'https://www3.septa.org/api/elevator/index.php',
  // Live positions for every tracked bus and SEPTA Metro vehicle, with the GTFS
  // trip each is running and its schedule deviation (`late`, minutes).
  transitView: 'https://www3.septa.org/api/TransitViewAll/index.php',
  // GTFS-realtime TripUpdates for buses and SEPTA Metro (protobuf). Cancelled
  // trips carry schedule_relationship CANCELED — the day's cancellations are
  // published ahead of time.
  tripUpdates: 'https://www3.septa.org/gtfsrt/septa-pa-us/Trip/rtTripUpdates.pb',
  // One train's stops for today with scheduled / estimated / actual times.
  railSchedule: (trainNo) =>
    `https://www3.septa.org/api/RRSchedules/index.php?req1=${encodeURIComponent(trainNo)}`,
};

const FIXTURE_FILES = {
  alerts: 'alerts.json',
  trainView: 'trainview.json',
  elevators: 'elevators.json',
  transitView: 'transitview.json',
  tripUpdates: 'trip-updates.pb',
};

async function fetchJson(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json', 'user-agent': 'septa-transit-alerts collector' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Some SEPTA endpoints serve JSON as text/html; parse the body directly.
      return JSON.parse(await res.text());
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr?.message ?? lastErr}`);
}

async function fetchBinary(url, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'septa-transit-alerts collector' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error(`${url}: ${lastErr?.message ?? lastErr}`);
}

/**
 * Build the source readers. Each returns parsed JSON (tripUpdates: raw
 * protobuf bytes) or throws.
 * @param {{ fixturesDir?: string | null }} [opts]
 */
export function createSources({ fixturesDir = null } = {}) {
  const read = (name) => async () => {
    if (fixturesDir)
      return JSON.parse(await readFile(join(fixturesDir, FIXTURE_FILES[name]), 'utf8'));
    return fetchJson(ENDPOINTS[name]);
  };
  return {
    alerts: read('alerts'),
    trainView: read('trainView'),
    elevators: read('elevators'),
    transitView: read('transitView'),
    async tripUpdates() {
      if (fixturesDir) return readFile(join(fixturesDir, FIXTURE_FILES.tripUpdates));
      return fetchBinary(ENDPOINTS.tripUpdates);
    },
    async railSchedule(trainNo) {
      if (fixturesDir) {
        try {
          const all = JSON.parse(await readFile(join(fixturesDir, 'rr-schedules.json'), 'utf8'));
          return all[trainNo] ?? [];
        } catch {
          return [];
        }
      }
      return fetchJson(ENDPOINTS.railSchedule(trainNo), { retries: 1 });
    },
  };
}
