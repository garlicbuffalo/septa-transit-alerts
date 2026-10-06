import { useMemo } from 'react';
import {
  formatRoutesLabel,
  incidentLifecycle,
  legacyKind,
  officialAlert,
  splitObservations,
} from '../lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 24 * HOUR_MS;
const BUS_COLOR = '#64748b';
const BUS_ROW_KEY = '__bus__';

// 24-hour incident strip. One fixed row per SEPTA train line and per Regional Rail line,
// plus a Bus row, drawn against a shared time axis (now - 24h → now). A
// multi-line incident renders a bar on every affected line's row, so you can
// read "Green's day" at a glance even when Green shared an incident with Red
// earlier. Train and Regional Rail line keys don't collide, so they share one row map.
//
// Hidden when the last 24 hours had fewer than 3 incidents — a quiet day's
// strip of mostly-empty tracks is just noise.
export default function RecentActivityGantt({ incidents, now }) {
  const data = useMemo(() => {
    const windowStart = now - WINDOW_MS;
    const all = (incidents ?? []).map((inc) => {
      const { primary } = splitObservations(inc);
      const kind = legacyKind(inc);
      const lifecycle = incidentLifecycle(inc);
      const alert = officialAlert(inc);
      const scope = alert?.scope ?? {};
      return {
        kind,
        routes: inc.routes ?? [],
        startTs: lifecycle.first_seen_ts,
        endTs: lifecycle.resolved_ts ?? null,
        active: lifecycle.active,
        headline: alert?.headline ?? null,
        // Merged/bot incidents surface the primary observation's stretch; a
        // official-only alerts falls back to its own affected_* segment.
        from: primary?.from_station ?? scope.from_station ?? null,
        to: primary?.to_station ?? scope.to_station ?? null,
        eventId: inc.id,
      };
    });

    // Keep incidents that overlap the window: either started inside it OR
    // are still active (extends to now). A 6-day planned reroute won't
    // dominate the strip because we clamp the bar to the window below.
    const relevant = all.filter((i) => {
      if (i.startTs == null) return false;
      const end = i.endTs ?? now;
      return end >= windowStart && i.startTs <= now;
    });

    relevant.sort((a, b) => a.startTs - b.startTs);

    // Bucket each incident into every line-row it affects. Train incidents
    // with no routes (rare, but possible from upstream) get dropped here —
    // they have no row to land on. Bus incidents go on a single Bus row.
    const rows = new Map();
    for (const key of METRO_LINE_ORDER) rows.set(key, []);
    for (const key of RAIL_LINE_ORDER) rows.set(key, []);
    rows.set(BUS_ROW_KEY, []);

    for (const i of relevant) {
      if (i.kind === 'metro' || i.kind === 'rail') {
        const routes = (i.routes ?? []).filter((r) => rows.has(r));
        for (const r of routes) rows.get(r).push(i);
      } else {
        rows.get(BUS_ROW_KEY).push(i);
      }
    }

    return { rows, totalCount: relevant.length };
  }, [incidents, now]);

  if (!data || data.totalCount < 3) return null;

  const windowStart = now - WINDOW_MS;
  const rowDefs = [
    ...METRO_LINE_ORDER.map((key) => ({
      key,
      label: METRO_LINES[key].label,
      color: METRO_LINES[key].color,
    })),
    // Regional Rail's full labels ("Union Pacific Northwest") won't fit the narrow row
    // gutter, so use the uppercased route code (UP-NW, BNSF, ME) as the label.
    ...RAIL_LINE_ORDER.map((key) => ({
      key,
      label: key.toUpperCase(),
      color: RAIL_LINES[key].color,
    })),
    { key: BUS_ROW_KEY, label: 'Bus', color: BUS_COLOR },
  ].filter(({ key }) => (data.rows.get(key) ?? []).length > 0);

  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <h2 className="text-sm font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
          Last 24 hours
        </h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {data.totalCount} incident{data.totalCount === 1 ? '' : 's'}
        </span>
      </div>
      <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-4">
        <div className="space-y-[3px]">
          {rowDefs.map(({ key, label, color }) => {
            const items = data.rows.get(key) ?? [];
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {label}
                </span>
                <div className="relative flex-1 h-2.5 rounded-sm bg-slate-100 dark:bg-gh-subtle">
                  {items.map((i) => {
                    const startClamped = Math.max(i.startTs, windowStart);
                    const endClamped = Math.min(i.endTs ?? now, now);
                    const leftPct = ((startClamped - windowStart) / WINDOW_MS) * 100;
                    const widthPct = Math.max(((endClamped - startClamped) / WINDOW_MS) * 100, 0.5);
                    const routeLabel = formatRoutesLabel(i.kind, i.routes);
                    const headlineLabel =
                      i.headline ?? (i.from && i.to ? `${i.from} → ${i.to}` : 'Service disruption');
                    const tooltip = `${routeLabel}: ${headlineLabel}${i.active ? ' · ongoing' : ''}`;
                    const barStyle = {
                      left: `${leftPct}%`,
                      width: `${widthPct}%`,
                      backgroundColor: color,
                      opacity: i.active ? 1 : 0.7,
                    };
                    const barKey = i.eventId ? `${i.eventId}-${i.startTs}` : `${i.startTs}-${key}`;
                    return i.eventId ? (
                      <a
                        key={barKey}
                        href={`/event/${i.eventId}`}
                        title={tooltip}
                        aria-label={tooltip}
                        className="absolute top-0 bottom-0 rounded-sm hover:opacity-80 transition-opacity"
                        style={barStyle}
                      >
                        <span className="sr-only">{tooltip}</span>
                      </a>
                    ) : (
                      <div
                        key={barKey}
                        role="img"
                        title={tooltip}
                        aria-label={tooltip}
                        className="absolute top-0 bottom-0 rounded-sm"
                        style={barStyle}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400 mt-2 pl-14">
          <span>24h ago</span>
          <span>12h ago</span>
          <span>now</span>
        </div>
      </div>
    </section>
  );
}
