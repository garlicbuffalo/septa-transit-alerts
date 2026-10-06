// The bot's SQLite database: what was posted (so restarts never double-post and
// the site can link every post), raw vehicle observations (for timelapses,
// speed maps, and the detectors' short lookbacks), and cooldowns.
//
// Migrations are numbered steps applied in order and tracked with
// PRAGMA user_version; add a step to MIGRATIONS, never edit an old one.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  -- One row per Bluesky post (or dry-run stand-in). subject is the incident id
  -- for incident posts, or a feature key (e.g. "ghosts:bus:2026-10-06T09").
  CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    kind TEXT NOT NULL,
    subject TEXT,
    uri TEXT NOT NULL,
    cid TEXT NOT NULL,
    url TEXT NOT NULL,
    root_uri TEXT,
    root_cid TEXT,
    parent_uri TEXT,
    ts INTEGER NOT NULL,
    text TEXT,
    dry_run INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX posts_subject ON posts (subject, kind);
  CREATE INDEX posts_ts ON posts (ts);

  -- Incidents deliberately not posted (filtered, or already old when seen), so
  -- each is judged once.
  CREATE TABLE skips (
    subject TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    ts INTEGER NOT NULL
  );

  CREATE TABLE observations (
    ts INTEGER NOT NULL,
    mode TEXT NOT NULL,
    route TEXT NOT NULL,
    vehicle_id TEXT NOT NULL,
    trip_id TEXT,
    direction TEXT,
    destination TEXT,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    heading REAL,
    late_min REAL,
    next_stop TEXT,
    report_ts INTEGER
  );
  CREATE INDEX observations_route ON observations (route, ts);
  CREATE INDEX observations_ts ON observations (ts);

  CREATE TABLE cooldowns (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  `,
];

/**
 * Open (creating if needed) and migrate the database.
 * @param {string} path ':memory:' for tests
 */
export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30000');
  const version = db.pragma('user_version', { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value == null ? null : String(value));
}

/**
 * Take every key, or none: true when all were free (and are now held until
 * now + ttlMs). The transaction makes this safe across concurrent jobs.
 */
export function acquireCooldown(db, keys, now, ttlMs) {
  return db.transaction(() => {
    const held = db.prepare('SELECT expires_at FROM cooldowns WHERE key = ?');
    for (const key of keys) {
      const row = held.get(key);
      if (row && row.expires_at > now) return false;
    }
    const put = db.prepare(
      'INSERT INTO cooldowns (key, expires_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at',
    );
    for (const key of keys) put.run(key, now + ttlMs);
    return true;
  })();
}

export function clearCooldown(db, keys) {
  const del = db.prepare('DELETE FROM cooldowns WHERE key = ?');
  for (const key of keys) del.run(key);
}

/** Delete old observations and expired cooldowns. */
export function pruneDb(db, now, { observationRetentionDays }) {
  const cutoff = now - observationRetentionDays * 24 * 60 * 60 * 1000;
  const observations = db.prepare('DELETE FROM observations WHERE ts < ?').run(cutoff).changes;
  const cooldowns = db.prepare('DELETE FROM cooldowns WHERE expires_at < ?').run(now).changes;
  return { observations, cooldowns };
}
