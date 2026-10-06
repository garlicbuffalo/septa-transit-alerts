// Publishing from the server: the collector writes into a clone of the repo's
// `data` branch (config.dataDir); this pushes it as a single parentless commit
// (the branch is always one snapshot, as collect.yml does it) and asks GitHub
// Actions to redeploy the site.
//
// Commits from here carry SERVER_MARK in their message: collect.yml's fallback
// run sees a fresh server commit and stands down.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getMeta, setMeta } from './db.js';

const run = promisify(execFile);
export const SERVER_MARK = '· server';
// Push at least this often even without rider-visible changes, so the branch
// (and the collector state the fallback would resume from) stays fresh.
const MAX_PUSH_GAP_MS = 10 * 60 * 1000;

function gitEnv(token) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    // Auth header via environment-only git config, so the token never shows
    // in process arguments or on disk.
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
  }
  return env;
}

/**
 * @param {{ dataDir: string, github: ReturnType<typeof import('./config.js').loadConfig>['github'],
 *   db: import('better-sqlite3').Database, enabled: boolean, deployMinGapMs: number,
 *   log?: (m: string) => void, fetchFn?: typeof fetch, now?: () => number,
 *   git?: (args: string[]) => Promise<string> }} opts
 */
export function createPublisher({
  dataDir,
  github,
  db,
  enabled,
  deployMinGapMs,
  log = () => {},
  fetchFn = fetch,
  now = () => Date.now(),
  git: gitOverride = null,
  remoteUrl = null,
}) {
  const remote = remoteUrl ?? `https://github.com/${github.repo}.git`;
  const env = gitEnv(github.token);
  const git =
    gitOverride ??
    (async (args) => {
      const { stdout } = await run('git', ['-C', dataDir, ...args], {
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout.trim();
    });

  async function api(path, init = {}) {
    const res = await fetchFn(`https://api.github.com/repos/${github.repo}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${github.token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'septa-transit-bots',
        ...(init.body && { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: HTTP ${res.status}`);
    }
    return res.status === 204 ? null : res.json();
  }

  // Whether dataDir is known to hold the published snapshot (or the branch
  // doesn't exist yet). Until it does, nothing is pushed: an archive built
  // from an empty directory must never replace the real one.
  let synced = false;

  async function sync() {
    await mkdir(dataDir, { recursive: true });
    if (!existsSync(join(dataDir, '.git'))) {
      await git(['init', '-q', '-b', github.dataBranch]);
      await git(['config', 'user.name', 'septa-transit-bots']);
      await git(['config', 'user.email', 'septa-transit-bots@users.noreply.github.com']);
    }
    // Reading the published branch needs no token (the repo is public), so
    // dry runs start from the same data the live service would.
    const listed = await git(['ls-remote', '--heads', remote, github.dataBranch]);
    if (!listed) {
      log(`publish: no ${github.dataBranch} branch yet; starting a new archive`);
      synced = true;
      return { fetched: false };
    }
    await git(['fetch', '-q', '--depth', '1', remote, github.dataBranch]);
    await git(['reset', '-q', '--hard', 'FETCH_HEAD']);
    synced = true;
    return { fetched: true };
  }

  return {
    /**
     * Make dataDir a checkout of the data branch at its latest published
     * snapshot (picking up anything the fallback collector wrote while the
     * server was away).
     */
    async prepare() {
      try {
        return await sync();
      } catch (err) {
        log(`publish: can't read the ${github.dataBranch} branch: ${err.message.split('\n')[0]}`);
        return { fetched: false, error: err.message };
      }
    },

    /**
     * Push the snapshot if anything changed (rider-visible changes at once,
     * the rest at most every MAX_PUSH_GAP_MS), then trigger a deploy if a
     * rider-visible change is waiting and the last one was long enough ago.
     * @param {{ changed: number }} summary the collector's tick summary
     */
    async publish(summary) {
      if (!enabled) return { pushed: false, deployed: false, reason: 'disabled' };
      if (!synced) {
        // Startup couldn't read the published branch. Sync now; this tick's
        // local result is discarded and the next tick rebuilds on top.
        const r = await this.prepare();
        return { pushed: false, deployed: false, reason: r.error ? 'unsynced' : 'resynced' };
      }
      const t = now();
      if (summary.changed > 0) setMeta(db, 'deploy_pending', '1');
      await git(['add', '-A']);
      const dirty = (await git(['status', '--porcelain'])).length > 0;
      const lastPush = Number(getMeta(db, 'last_push_ts') ?? 0);
      let pushed = false;
      if (dirty && (summary.changed > 0 || t - lastPush >= MAX_PUSH_GAP_MS)) {
        const tree = await git(['write-tree']);
        const stamp = new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');
        const commit = await git([
          'commit-tree',
          tree,
          '-m',
          `Data snapshot ${stamp} ${SERVER_MARK}`,
        ]);
        await git(['update-ref', 'HEAD', commit]);
        await git(['push', '-q', '--force', remote, `${commit}:refs/heads/${github.dataBranch}`]);
        setMeta(db, 'last_push_ts', t);
        pushed = true;
      }

      let deployed = false;
      const lastDeploy = Number(getMeta(db, 'last_deploy_ts') ?? 0);
      if (getMeta(db, 'deploy_pending') === '1' && t - lastDeploy >= deployMinGapMs) {
        if (!pushed && dirty) return { pushed, deployed, reason: 'waiting-for-push' };
        const runs = await api(
          `/actions/workflows/${github.deployWorkflow}/runs?per_page=5&branch=${github.deployRef}`,
        ).catch(() => null);
        const busy = runs?.workflow_runs?.some(
          (r) => r.status === 'queued' || r.status === 'in_progress',
        );
        if (!busy) {
          await api(`/actions/workflows/${github.deployWorkflow}/dispatches`, {
            method: 'POST',
            body: JSON.stringify({ ref: github.deployRef }),
          });
          setMeta(db, 'last_deploy_ts', t);
          setMeta(db, 'deploy_pending', '0');
          deployed = true;
          log('publish: deploy triggered');
        }
      }
      return { pushed, deployed };
    },
  };
}
