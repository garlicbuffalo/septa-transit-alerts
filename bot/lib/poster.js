// Posting with a memory: every post (or dry-run stand-in) is recorded in the
// posts table under a subject and kind, so restarts never double-post, threads
// can be continued, and the published data can link each incident to its post.
import { getMeta, setMeta } from './db.js';

/**
 * @param {{ db: import('better-sqlite3').Database, client: object, log?: (m: string) => void,
 *   now?: () => number }} opts
 */
export function createPoster({ db, client, log = () => {}, now = () => Date.now() }) {
  const insert = db.prepare(`
    INSERT INTO posts (account, kind, subject, uri, cid, url, root_uri, root_cid, parent_uri, ts, text, dry_run)
    VALUES (@account, @kind, @subject, @uri, @cid, @url, @root_uri, @root_cid, @parent_uri, @ts, @text, @dry_run)
  `);
  const latest = db.prepare(
    'SELECT * FROM posts WHERE subject = ? AND kind = ? AND dry_run = ? ORDER BY ts DESC, id DESC LIMIT 1',
  );
  const skipGet = db.prepare('SELECT reason FROM skips WHERE subject = ?');
  const skipPut = db.prepare('INSERT OR IGNORE INTO skips (subject, reason, ts) VALUES (?, ?, ?)');
  const dry = client.dryRun ? 1 : 0;

  return {
    client,
    dryRun: client.dryRun,

    /**
     * Post and record it. `reply` may be a reply ref or an at:// URI to
     * continue that post's thread.
     * @returns {Promise<{ uri: string, cid: string, url: string } | null>}
     */
    async post({ account, kind, subject = null, reply = null, ...opts }) {
      let replyRef = reply;
      if (typeof reply === 'string') {
        replyRef = await client.replyRef(account, reply);
        if (!replyRef) log(`poster: ${reply} is gone; posting ${kind} ${subject} unthreaded`);
      }
      const res = await client.post(account, { ...opts, ...(replyRef && { reply: replyRef }) });
      insert.run({
        account,
        kind,
        subject,
        uri: res.uri,
        cid: res.cid,
        url: res.url,
        root_uri: replyRef?.root?.uri ?? res.uri,
        root_cid: replyRef?.root?.cid ?? res.cid,
        parent_uri: replyRef?.parent?.uri ?? null,
        ts: now(),
        text: opts.text,
        dry_run: dry,
      });
      return res;
    },

    /** The most recent post of this kind about this subject (this mode only). */
    find(subject, kind) {
      return latest.get(subject, kind, dry) ?? null;
    },

    skipped(subject) {
      return skipGet.get(subject)?.reason ?? null;
    },

    skip(subject, reason) {
      skipPut.run(subject, reason, now());
    },

    /**
     * When this database started posting in the current mode. Incidents first
     * seen before it are never posted, so going live doesn't flood the feed.
     */
    since() {
      const key = dry ? 'dry_run_since' : 'live_since';
      let value = Number(getMeta(db, key));
      if (!value) {
        value = now();
        setMeta(db, key, value);
      }
      return value;
    },
  };
}
