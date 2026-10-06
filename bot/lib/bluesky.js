// Bluesky client for the four bot accounts, plus a dry-run stand-in with the
// same interface that writes each post to disk instead.
//
// Adapted from cta-insights (https://github.com/cailinpitt/cta-insights, ISC):
// sessions are cached on disk because Bluesky caps createSession (~300/day,
// 30 per 5 min) — logging in on every post would lock the accounts out — and
// replies thread onto the newest post in a thread so it stays one linear
// chain. Additions here: one post() for every embed type, images recompressed
// under Bluesky's blob limit with their aspect ratio set, and retries on
// rate limits and server errors.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AtpAgent } from '@atproto/api';
import sharp from 'sharp';

export const MAX_IMAGE_BYTES = 950_000;
const VIDEO_SERVICE = 'https://video.bsky.app';
const VIDEO_POLL_MS = 2000;
const VIDEO_MAX_POLLS = 150;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** https://bsky.app URL for a post's at:// URI. */
export function postUrl(uri) {
  const [, , did, , rkey] = uri.split('/');
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

/** Retry rate limits, server errors, and network failures. */
export async function withRetry(fn, { attempts = 3, baseMs = 1000, sleepFn = sleep } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.statusCode ?? null;
      const retryable = status == null || status === 429 || status >= 500;
      if (!retryable || i === attempts - 1) break;
      const reset = Number(err?.headers?.['ratelimit-reset']);
      const wait =
        status === 429 && Number.isFinite(reset)
          ? Math.min(60_000, Math.max(1000, reset * 1000 - Date.now()))
          : baseMs * 2 ** i;
      await sleepFn(wait);
    }
  }
  throw lastErr;
}

/**
 * JPEG under MAX_IMAGE_BYTES, with its pixel size for the embed's aspectRatio.
 * @param {Buffer} input any image sharp reads
 */
export async function prepareImage(input) {
  const meta = await sharp(input).metadata();
  let width = meta.width;
  let height = meta.height;
  for (const scale of [1, 0.85, 0.7, 0.5]) {
    const w = Math.round(meta.width * scale);
    for (const quality of [88, 80, 72, 64]) {
      const { data, info } = await sharp(input)
        .resize({ width: w, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      width = info.width;
      height = info.height;
      if (data.length <= MAX_IMAGE_BYTES) return { data, width, height, mime: 'image/jpeg' };
    }
  }
  throw new Error(`image still over ${MAX_IMAGE_BYTES} bytes at ${width}×${height}`);
}

function sessionStore(sessionDir, identifier) {
  const key = createHash('sha1').update(identifier).digest('hex').slice(0, 16);
  const path = join(sessionDir, `${key}.json`);
  return {
    load() {
      try {
        return JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        return null;
      }
    },
    save(session) {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(path, JSON.stringify(session), { mode: 0o600 });
    },
    clear() {
      try {
        unlinkSync(path);
      } catch {}
    },
  };
}

/**
 * Build the post record's embed from the post options (at most one kind).
 */
async function buildEmbed(agent, opts, { fetchFn }) {
  if (opts.image) {
    const img = await prepareImage(opts.image.data);
    const up = await withRetry(() => agent.uploadBlob(img.data, { encoding: img.mime }));
    return {
      $type: 'app.bsky.embed.images',
      images: [
        {
          image: up.data.blob,
          alt: opts.image.alt ?? '',
          aspectRatio: { width: img.width, height: img.height },
        },
      ],
    };
  }
  if (opts.video) {
    const blob = await uploadVideo(agent, opts.video.data, { fetchFn });
    return {
      $type: 'app.bsky.embed.video',
      video: blob,
      alt: opts.video.alt ?? '',
      ...(opts.video.width &&
        opts.video.height && {
          aspectRatio: { width: opts.video.width, height: opts.video.height },
        }),
    };
  }
  if (opts.link) {
    let thumb;
    for (const source of [opts.link.thumb, opts.link.thumbUrl, opts.link.fallbackThumbUrl]) {
      if (!source) continue;
      try {
        const raw = Buffer.isBuffer(source)
          ? source
          : Buffer.from(
              await (await fetchFn(source, { signal: AbortSignal.timeout(15000) })).arrayBuffer(),
            );
        const img = await prepareImage(raw);
        thumb = (await withRetry(() => agent.uploadBlob(img.data, { encoding: img.mime }))).data
          .blob;
        break;
      } catch {}
    }
    return {
      $type: 'app.bsky.embed.external',
      external: {
        uri: opts.link.url,
        title: opts.link.title ?? '',
        description: opts.link.description ?? '',
        ...(thumb && { thumb }),
      },
    };
  }
  if (opts.quote) {
    return { $type: 'app.bsky.embed.record', record: { uri: opts.quote.uri, cid: opts.quote.cid } };
  }
  return undefined;
}

async function uploadVideo(agent, data, { fetchFn }) {
  const { data: auth } = await withRetry(() =>
    agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${agent.dispatchUrl.host}`,
      lxm: 'com.atproto.repo.uploadBlob',
      exp: Math.floor(Date.now() / 1000) + 30 * 60,
    }),
  );
  const url = new URL(`${VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  url.searchParams.set('did', agent.session.did);
  url.searchParams.set('name', `septa-${Date.now()}.mp4`);
  const res = await withRetry(async () => {
    const r = await fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'video/mp4' },
      body: data,
    });
    if (!r.ok && r.status !== 409) {
      const err = new Error(`video upload HTTP ${r.status}: ${await r.text().catch(() => '')}`);
      err.status = r.status;
      throw err;
    }
    return r;
  });
  const job = await res.json();
  if (job.blob) return job.blob;
  const videoAgent = new AtpAgent({ service: VIDEO_SERVICE });
  for (let i = 0; i < VIDEO_MAX_POLLS; i++) {
    await sleep(VIDEO_POLL_MS);
    const { data: status } = await videoAgent.app.bsky.video.getJobStatus({ jobId: job.jobId });
    if (status.jobStatus.blob) return status.jobStatus.blob;
    if (status.jobStatus.state === 'JOB_STATE_FAILED') {
      throw new Error(`video processing failed: ${status.jobStatus.error ?? 'unknown'}`);
    }
  }
  throw new Error('video processing timed out');
}

/**
 * Live client.
 * @param {{ service: string, accounts: Record<string, {identifier: string, password: string} | null>,
 *   sessionDir: string, log?: (msg: string) => void, fetchFn?: typeof fetch,
 *   agentFactory?: (opts: object) => object }} opts
 */
export function createBlueskyClient({
  service,
  accounts,
  sessionDir,
  log = () => {},
  fetchFn = fetch,
  agentFactory = (opts) => new AtpAgent(opts),
}) {
  const agents = new Map();

  async function agent(account) {
    if (agents.has(account)) return agents.get(account);
    const creds = accounts[account];
    if (!creds) throw new Error(`no credentials for the ${account} account`);
    const store = sessionStore(sessionDir, creds.identifier);
    const a = agentFactory({
      service,
      persistSession: (evt, session) => {
        if ((evt === 'create' || evt === 'update') && session) store.save(session);
        else if (evt === 'expired') store.clear();
      },
    });
    const cached = store.load();
    let resumed = false;
    if (cached) {
      try {
        await a.resumeSession(cached);
        resumed = !!a.session?.accessJwt;
      } catch {
        store.clear();
      }
    }
    if (!resumed) {
      await withRetry(() => a.login({ identifier: creds.identifier, password: creds.password }));
      log(`bluesky: logged in as ${creds.identifier}`);
    }
    agents.set(account, a);
    return a;
  }

  return {
    dryRun: false,
    hasAccount: (account) => !!accounts[account],

    /**
     * @param {string} account
     * @param {{ text: string, facets?: object[], reply?: {root: {uri,cid}, parent: {uri,cid}},
     *   image?: {data: Buffer, alt: string}, video?: {data: Buffer, alt: string, width?: number, height?: number},
     *   link?: {url: string, title?: string, description?: string, thumb?: Buffer, thumbUrl?: string, fallbackThumbUrl?: string},
     *   quote?: {uri: string, cid: string}, langs?: string[] }} opts
     * @returns {Promise<{ uri: string, cid: string, url: string }>}
     */
    async post(account, opts) {
      const a = await agent(account);
      const embed = await buildEmbed(a, opts, { fetchFn });
      const record = {
        text: opts.text,
        langs: opts.langs ?? ['en'],
        ...(opts.facets?.length && { facets: opts.facets }),
        ...(opts.reply && { reply: opts.reply }),
        ...(embed && { embed }),
      };
      const res = await withRetry(() => a.post(record));
      return { uri: res.uri, cid: res.cid, url: postUrl(res.uri) };
    },

    /** The post record, or null if it's gone. */
    async getPost(account, uri) {
      const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri ?? '');
      if (!m) return null;
      const a = await agent(account);
      try {
        const { data } = await a.com.atproto.repo.getRecord({
          repo: m[1],
          collection: m[2],
          rkey: m[3],
        });
        return { uri, cid: data.cid, value: data.value };
      } catch {
        return null;
      }
    },

    /**
     * Reply ref that continues the thread containing `uri` from its newest
     * post, so later replies stay one linear chain. Null if the post is gone.
     */
    async replyRef(account, uri) {
      const rec = await this.getPost(account, uri);
      if (!rec) return null;
      const root = rec.value?.reply?.root ?? { uri: rec.uri, cid: rec.cid };
      let parent = { uri: rec.uri, cid: rec.cid };
      try {
        const a = await agent(account);
        const { data } = await a.getPostThread({ uri, depth: 100 });
        let best = data.thread?.post;
        let bestTs = Date.parse(best?.indexedAt ?? '') || 0;
        const visit = (node) => {
          if (!node?.post) return;
          if (!node.replies?.length) {
            const t = Date.parse(node.post.indexedAt ?? '') || 0;
            if (t >= bestTs) {
              bestTs = t;
              best = node.post;
            }
            return;
          }
          for (const r of node.replies) visit(r);
        };
        visit(data.thread);
        if (best) parent = { uri: best.uri, cid: best.cid };
      } catch {}
      return { root, parent };
    },

    /** Repost a post as `account`. */
    async repost(account, { uri, cid }) {
      const a = await agent(account);
      const res = await withRetry(() => a.repost(uri, cid));
      return { uri: res.uri, cid: res.cid };
    },

    async deletePost(account, uri) {
      const a = await agent(account);
      await withRetry(() => a.deletePost(uri));
    },

    /** Log in (or resume) and return the account's handle and DID. */
    async whoami(account) {
      const a = await agent(account);
      return { did: a.session?.did ?? null, handle: a.session?.handle ?? null };
    },
  };
}

let dryRunSeq = 0;

/**
 * Dry-run client: same interface, posts nothing. Each "post" (or repost) is
 * written to `<assetsDir>/<date>/<time>-<account>-<n>.json` with its media
 * beside it.
 */
export function createDryRunClient({ assetsDir, log = () => {}, now = () => Date.now() }) {
  const posts = new Map();
  return {
    dryRun: true,
    hasAccount: () => true,
    posts,
    async post(account, opts) {
      const ts = now();
      const rkey = `dry${ts.toString(36)}${(dryRunSeq++).toString(36)}`;
      const uri = `at://did:plc:dry-run-${account}/app.bsky.feed.post/${rkey}`;
      const cid = `dry-${rkey}`;
      const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
      const dir = join(assetsDir, stamp.slice(0, 10));
      const base = `${stamp.slice(11, 19)}-${account}-${rkey}`;
      const media = opts.image ?? opts.video ?? null;
      const record = {
        account,
        uri,
        text: opts.text,
        reply: opts.reply ?? null,
        link: opts.link ? { ...opts.link, thumb: opts.link.thumb ? '<buffer>' : null } : null,
        quote: opts.quote ?? null,
        alt: media?.alt ?? null,
        media: opts.image ? `${base}.jpg` : opts.video ? `${base}.mp4` : null,
      };
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`);
        if (opts.image) await writeFile(join(dir, `${base}.jpg`), opts.image.data);
        if (opts.video) await writeFile(join(dir, `${base}.mp4`), opts.video.data);
      } catch (err) {
        log(`dry-run: could not write ${base}: ${err.message}`);
      }
      log(`[dry run] ${account}: ${opts.text.replace(/\n+/g, ' ⏎ ')}`);
      posts.set(uri, { uri, cid, value: { text: opts.text, reply: opts.reply ?? undefined } });
      return { uri, cid, url: postUrl(uri) };
    },
    async repost(account, subject) {
      const ts = now();
      const rkey = `dry${ts.toString(36)}${(dryRunSeq++).toString(36)}`;
      const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-');
      const dir = join(assetsDir, stamp.slice(0, 10));
      const base = `${stamp.slice(11, 19)}-${account}-${rkey}`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(
          join(dir, `${base}.json`),
          `${JSON.stringify({ account, repost: subject }, null, 2)}\n`,
        );
      } catch (err) {
        log(`dry-run: could not write ${base}: ${err.message}`);
      }
      const text = posts.get(subject.uri)?.value.text ?? subject.uri;
      log(`[dry run] ${account} reposts: ${text.replace(/\n+/g, ' ⏎ ')}`);
      return {
        uri: `at://did:plc:dry-run-${account}/app.bsky.feed.repost/${rkey}`,
        cid: `dry-${rkey}`,
      };
    },
    async getPost(_account, uri) {
      return posts.get(uri) ?? null;
    },
    async replyRef(_account, uri) {
      const rec = posts.get(uri);
      if (!rec) return null;
      const root = rec.value.reply?.root ?? { uri: rec.uri, cid: rec.cid };
      // Newest post in the thread, mirroring the live client.
      let parent = { uri: rec.uri, cid: rec.cid };
      for (const p of posts.values()) {
        if (p.value.reply?.root?.uri === root.uri) parent = { uri: p.uri, cid: p.cid };
      }
      return { root, parent };
    },
    async deletePost(_account, uri) {
      posts.delete(uri);
    },
  };
}
