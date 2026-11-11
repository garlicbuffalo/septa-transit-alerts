import { useEffect, useState } from 'react';
import { loadScorecards } from '../lib/publishedFiles.js';
import { MEASURES, measureCell, measureKeys, routeScore, weekLabel } from '../lib/scorecards.js';

// A route's or line's score for the last full week, on its own page: the
// number, where that put it, and the measures behind it, with a link to every
// route's on the scorecards page. Nothing is drawn for a route that wasn't
// ranked (the Broad Street Line, a route with too few readings) or when the
// bot server's file isn't there.
export default function RouteScorecard({ mode, route }) {
  const [file, setFile] = useState(null);
  useEffect(() => {
    let alive = true;
    loadScorecards().then((f) => {
      if (alive) setFile(f);
    });
    return () => {
      alive = false;
    };
  }, []);
  const score = routeScore(file, mode, route);
  if (!score) return null;
  const keys = measureKeys(file, mode);
  return (
    <section
      aria-labelledby="route-scorecard-heading"
      className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="route-scorecard-heading"
          className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider"
        >
          Scorecard · week of {weekLabel(score.from, score.to)}
        </h2>
        <a
          href={`/scorecards${mode === 'bus' ? '' : `?mode=${mode}`}`}
          className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
        >
          All {mode === 'bus' ? 'routes' : 'lines'} →
        </a>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-3">
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Score</dt>
          <dd className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
            {Math.round(score.score)}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400"> / 100</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500 dark:text-slate-400">Rank</dt>
          <dd className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100">
            {score.rank}
            <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
              {' '}
              of {score.ranked}
            </span>
          </dd>
        </div>
        {keys.map((key) => (
          <div key={key}>
            <dt className="text-xs text-slate-500 dark:text-slate-400">{MEASURES[key].heading}</dt>
            <dd className="text-lg font-semibold tabular-nums text-slate-700 dark:text-slate-200 leading-8">
              {measureCell(score, key, mode)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
