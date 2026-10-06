import { useMemo } from 'react';
import { formatRoutesLabel, legacyKind } from '../../lib/incidents.js';
import { findIncidentNeighbors } from './callouts.js';
import { describeText, incidentRoutes } from './incidentText.jsx';

// One side of a nav row: a link to the neighbor's event page. The directional
// cue lives on a small "← Previous" / "Next →" caption line, with the
// neighbor's headline on its own line below. Keeping the arrow off the title
// line is deliberate — many titles are station pairs ("Ashland → Clinton"), so
// a leading arrow on the same line read as a second, contradictory arrow.
// Renders an inert spacer when there's no neighbor so the other side stays
// edge-aligned.
function NavLink({ incident, dir }) {
  const isPrev = dir === 'prev';
  if (!incident) return <span className="min-w-0 max-w-[48%]" />;
  const label = describeText(incident);
  return (
    <a
      href={`/event/${incident.id}`}
      className={`group flex min-w-0 max-w-[48%] flex-col gap-0.5 ${
        isPrev ? 'items-start text-left' : 'items-end text-right'
      }`}
      title={label}
    >
      <span className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {isPrev ? '← Previous' : 'Next →'}
      </span>
      <span className="max-w-full truncate text-sm text-blue-500 group-hover:text-blue-400 group-hover:underline">
        {label}
      </span>
    </a>
  );
}

function NavRow({ prev, next }) {
  if (!prev && !next) return null;
  return (
    <div className="flex items-start justify-between gap-4">
      <NavLink incident={prev} dir="prev" />
      <NavLink incident={next} dir="next" />
    </div>
  );
}

// Footer navigation for the event page: two rows of chronological prev/next
// links — one walking the same line/route, one walking every incident
// system-wide. Lets a reader follow a single line's history or scrub the whole
// archive without bouncing back to the homepage. Renders nothing when the
// subject can't be located among `incidents`.
export default function EventNav({ incident, incidents }) {
  const sameLine = useMemo(
    () => findIncidentNeighbors(incident, incidents, { sameRouteOnly: true }),
    [incident, incidents],
  );
  const global = useMemo(() => findIncidentNeighbors(incident, incidents), [incident, incidents]);

  const hasSameLine = sameLine.prev || sameLine.next;
  const hasGlobal = global.prev || global.next;
  if (!hasSameLine && !hasGlobal) return null;

  const routes = incidentRoutes(incident);
  const kind = legacyKind(incident);
  const lineLabel = formatRoutesLabel(kind, routes);
  const listHref =
    routes.length === 1
      ? kind === 'metro'
        ? `/line/${routes[0]}`
        : kind === 'bus'
          ? `/route/${routes[0]}`
          : kind === 'rail'
            ? `/rail/line/${routes[0]}`
            : null
      : null;

  return (
    <nav className="mt-4 bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4 space-y-3">
      {hasSameLine && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              On {lineLabel}
            </p>
            {listHref && (
              <a
                href={listHref}
                className="text-xs text-blue-500 hover:text-blue-400 hover:underline"
              >
                See all →
              </a>
            )}
          </div>
          <NavRow prev={sameLine.prev} next={sameLine.next} />
        </div>
      )}
      {hasGlobal && (
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
            All incidents
          </p>
          <NavRow prev={global.prev} next={global.next} />
        </div>
      )}
    </nav>
  );
}
