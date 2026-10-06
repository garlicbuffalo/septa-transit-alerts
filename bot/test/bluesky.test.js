import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  createBlueskyClient,
  createDryRunClient,
  MAX_IMAGE_BYTES,
  postUrl,
  prepareImage,
  withRetry,
} from '../lib/bluesky.js';

function fakeAgent({ failLogin = false } = {}) {
  const calls = { login: 0, resume: 0, posts: [], uploads: [] };
  let persist;
  const agent = {
    calls,
    session: null,
    set persist(fn) {
      persist = fn;
    },
    async resumeSession(s) {
      calls.resume++;
      agent.session = s;
    },
    async login({ identifier }) {
      calls.login++;
      if (failLogin) throw Object.assign(new Error('bad password'), { status: 401 });
      agent.session = { did: 'did:plc:abc', handle: identifier, accessJwt: 'jwt', refreshJwt: 'r' };
      persist?.('create', agent.session);
    },
    async uploadBlob(data, { encoding }) {
      calls.uploads.push({ bytes: data.length, encoding });
      return { data: { blob: { ref: `blob${calls.uploads.length}`, mimeType: encoding } } };
    },
    async post(record) {
      calls.posts.push(record);
      return { uri: `at://did:plc:abc/app.bsky.feed.post/r${calls.posts.length}`, cid: 'cid' };
    },
  };
  return agent;
}

function clientWith(agent, sessionDir) {
  return createBlueskyClient({
    service: 'https://example.invalid',
    accounts: { alerts: { identifier: 'alerts.example', password: 'pw' }, bus: null },
    sessionDir,
    agentFactory: ({ persistSession }) => {
      agent.persist = persistSession;
      return agent;
    },
  });
}

describe('Bluesky client', () => {
  it('maps at:// URIs to bsky.app URLs', () => {
    expect(postUrl('at://did:plc:abc/app.bsky.feed.post/3k2j')).toBe(
      'https://bsky.app/profile/did:plc:abc/post/3k2j',
    );
  });

  it('logs in once, caches the session on disk, and resumes it next time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsky-'));
    const a1 = fakeAgent();
    await clientWith(a1, dir).post('alerts', { text: 'hi' });
    expect(a1.calls.login).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);
    const a2 = fakeAgent();
    await clientWith(a2, dir).post('alerts', { text: 'again' });
    expect(a2.calls.resume).toBe(1);
    expect(a2.calls.login).toBe(0);
  });

  it('refuses accounts without credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsky-'));
    await expect(clientWith(fakeAgent(), dir).post('bus', { text: 'x' })).rejects.toThrow(
      /no credentials for the bus account/,
    );
  });

  it('posts text with facets, language, and reply refs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsky-'));
    const agent = fakeAgent();
    const reply = { root: { uri: 'at://r', cid: 'c' }, parent: { uri: 'at://p', cid: 'c2' } };
    const res = await clientWith(agent, dir).post('alerts', {
      text: 'x',
      facets: [{ f: 1 }],
      reply,
    });
    expect(res.url).toBe('https://bsky.app/profile/did:plc:abc/post/r1');
    expect(agent.calls.posts[0]).toMatchObject({
      text: 'x',
      langs: ['en'],
      facets: [{ f: 1 }],
      reply,
    });
  });

  it('uploads images as JPEG under the blob limit with their aspect ratio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsky-'));
    const agent = fakeAgent();
    const png = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    await clientWith(agent, dir).post('alerts', {
      text: 'map',
      image: { data: png, alt: 'a map' },
    });
    const embed = agent.calls.posts[0].embed;
    expect(embed.$type).toBe('app.bsky.embed.images');
    expect(embed.images[0]).toMatchObject({
      alt: 'a map',
      aspectRatio: { width: 1200, height: 900 },
    });
    expect(agent.calls.uploads[0].encoding).toBe('image/jpeg');
  });

  it('builds link cards with an uploaded thumbnail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsky-'));
    const agent = fakeAgent();
    const thumb = await sharp({
      create: { width: 600, height: 315, channels: 3, background: '#000' },
    })
      .png()
      .toBuffer();
    await clientWith(agent, dir).post('alerts', {
      text: 'cleared',
      link: { url: 'https://site/event/a', title: 'T', description: 'D', thumb },
    });
    const { external } = agent.calls.posts[0].embed;
    expect(external).toMatchObject({ uri: 'https://site/event/a', title: 'T', description: 'D' });
    expect(external.thumb).toBeTruthy();
  });

  it('recompresses large images below the limit', async () => {
    const noise = Buffer.alloc(2400 * 2400 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 251;
    const big = await sharp(noise, { raw: { width: 2400, height: 2400, channels: 3 } })
      .png()
      .toBuffer();
    const out = await prepareImage(big);
    expect(out.data.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(out.width / out.height).toBeCloseTo(1, 2);
  });
});

describe('withRetry', () => {
  it('retries server errors and gives up on client errors', async () => {
    let n = 0;
    const flaky = async () => {
      n++;
      if (n < 3) throw Object.assign(new Error('busy'), { status: 503 });
      return 'ok';
    };
    expect(await withRetry(flaky, { sleepFn: async () => {} })).toBe('ok');
    let m = 0;
    const bad = async () => {
      m++;
      throw Object.assign(new Error('nope'), { status: 400 });
    };
    await expect(withRetry(bad, { sleepFn: async () => {} })).rejects.toThrow('nope');
    expect(m).toBe(1);
  });
});

describe('dry-run client', () => {
  it('writes each post and its media to disk and threads replies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dry-'));
    const client = createDryRunClient({ assetsDir: dir, now: () => 1_791_300_000_000 });
    const root = await client.post('alerts', {
      text: 'first',
      image: { data: Buffer.from('img'), alt: 'alt' },
    });
    const ref = await client.replyRef('alerts', root.uri);
    expect(ref.root.uri).toBe(root.uri);
    const reply = await client.post('alerts', { text: 'second', reply: ref });
    expect((await client.replyRef('alerts', root.uri)).parent.uri).toBe(reply.uri);
    const [day] = readdirSync(dir);
    const files = readdirSync(join(dir, day)).sort();
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
    expect(files.filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
    const first = JSON.parse(
      readFileSync(
        join(
          dir,
          day,
          files.find((f) => f.endsWith('.json')),
        ),
        'utf8',
      ),
    );
    expect(['first', 'second']).toContain(first.text);
  });
});
