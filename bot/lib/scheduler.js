// A small in-process scheduler: interval jobs and cron-style jobs in
// Philadelphia time. A job never overlaps itself — a run still going when the
// next is due is skipped — and a failing run is logged, not fatal.

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  minute: 'numeric',
  hour: 'numeric',
  day: 'numeric',
  month: 'numeric',
  weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Philadelphia wall-clock fields of a timestamp. */
export function easternFields(ts) {
  const parts = Object.fromEntries(
    EASTERN.formatToParts(new Date(ts)).map((p) => [p.type, p.value]),
  );
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday],
  };
}

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let lo = min;
    let hi = max;
    if (range !== '*') {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b ?? (stepStr ? max : a);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Matcher for "minute hour day-of-month month day-of-week" (Eastern time). */
export function cronMatcher(spec) {
  const [m, h, dom, mon, dow] = spec.trim().split(/\s+/);
  const sets = {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    day: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    weekday: parseField(dow, 0, 6),
  };
  return (ts) => {
    const f = easternFields(ts);
    return (
      sets.minute.has(f.minute) &&
      sets.hour.has(f.hour) &&
      sets.day.has(f.day) &&
      sets.month.has(f.month) &&
      sets.weekday.has(f.weekday)
    );
  };
}

export function createScheduler({ log = console.log, now = () => Date.now() } = {}) {
  const jobs = [];
  const timers = new Set();
  let stopped = false;

  async function runJob(job) {
    if (job.running) {
      log(`scheduler: ${job.name} still running; skipping this run`);
      return;
    }
    job.running = true;
    const started = now();
    try {
      await job.fn(started);
      job.lastOk = now();
    } catch (err) {
      log(`scheduler: ${job.name} failed: ${err.stack ?? err.message}`);
    } finally {
      job.running = false;
      job.lastRun = started;
    }
  }

  function later(ms, fn) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  }

  return {
    jobs,
    /** Run fn every `ms`, first after `delayMs`. */
    every(name, ms, fn, { delayMs = 0 } = {}) {
      jobs.push({ name, kind: 'every', ms, delayMs, fn, running: false });
    },
    /** Run fn at minutes matching a cron spec in Philadelphia time. */
    cron(name, spec, fn) {
      jobs.push({ name, kind: 'cron', match: cronMatcher(spec), fn, running: false });
    },
    start() {
      for (const job of jobs.filter((j) => j.kind === 'every')) {
        const loop = () => {
          const next = now() + job.ms;
          runJob(job).finally(() => later(Math.max(0, next - now()), loop));
        };
        later(job.delayMs, loop);
      }
      const cronJobs = jobs.filter((j) => j.kind === 'cron');
      if (cronJobs.length) {
        const tick = () => {
          const t = now();
          const minute = Math.floor(t / 60000) * 60000;
          for (const job of cronJobs) if (job.match(minute)) runJob(job);
          later(minute + 60000 - now() + 50, tick);
        };
        later(Math.floor(now() / 60000) * 60000 + 60000 - now() + 50, tick);
      }
    },
    /** Stop scheduling and wait for running jobs to finish. */
    async stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      while (jobs.some((j) => j.running)) await new Promise((r) => setTimeout(r, 200));
    },
  };
}
