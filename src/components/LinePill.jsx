import { busRouteName, formatBusRoute } from '../lib/busRoutes.js';
import { METRO_LINES, metroLineFullName, normalizeMetroLine } from '../lib/metroLines.js';
import { normalizeRailLine, railLineFullName, railLineInfo } from '../lib/railLines.js';

// Each pill is a link to the relevant /line/:id, /rail/line/:id, or /route/:id
// page. Brand colors stay loud, so we lean on subtle hover affordance (cursor +
// slight dim) rather than a competing visual cue. Multi-route alerts render one
// pill per route, each with its own destination.
const PILL_BASE =
  'inline-flex items-center min-w-0 max-w-full min-h-[24px] px-2 py-0.5 rounded-full text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity';
// Tighter chip for dense lists (e.g. the accessibility outage rows), where a
// transfer station's several pills crowd the row.
const PILL_COMPACT =
  'inline-flex items-center min-w-0 max-w-full min-h-[18px] px-1.5 py-px rounded-full text-[11px] font-semibold leading-none cursor-pointer hover:opacity-80 transition-opacity';

export default function LinePill({ kind, line, routes, linked = true, compact = false }) {
  const keys = routes?.length > 0 ? routes : [line];
  const base = compact ? PILL_COMPACT : PILL_BASE;
  const chipClass = linked ? base : base.replace('cursor-pointer hover:opacity-80', '');
  // Every pill caps at its container width and truncates its label — a long
  // line name ("Lansdale/Doylestown") otherwise blows the compact row's width
  // and pushes the elapsed-time chip off a phone screen. `title` carries the
  // full name for hover and screen readers.
  const renderChip = (key, href, className, label, title, props = {}) =>
    linked ? (
      <a key={key} href={href} className={className} title={title} {...props}>
        <span className="min-w-0 truncate">{label}</span>
      </a>
    ) : (
      <span key={key} className={className} title={title} {...props}>
        <span className="min-w-0 truncate">{label}</span>
      </span>
    );
  return (
    <>
      {keys.map((key) => {
        if (kind === 'rail') {
          // Regional Rail pills show the line name ("Paoli/Thorndale"), or
          // SEPTA's three-letter code in compact rows.
          const info = railLineInfo(key);
          if (info) {
            const railKey = normalizeRailLine(key);
            return renderChip(
              key,
              `/rail/line/${railKey}`,
              chipClass,
              compact ? info.code : info.label,
              railLineFullName(railKey),
              { style: { backgroundColor: info.color, color: info.textColor } },
            );
          }
          // System-wide Regional Rail alert with no resolvable line (routes:
          // []) — render a neutral "Regional Rail" pill rather than an empty chip.
          return (
            <span
              key={key ?? 'rail'}
              className={PILL_BASE.replace('cursor-pointer hover:opacity-80', '')}
              style={{ backgroundColor: '#64748b', color: '#fff' }}
            >
              Regional Rail
            </span>
          );
        }
        const metroKey = kind === 'metro' ? normalizeMetroLine(key) : key;
        const info = kind === 'metro' ? METRO_LINES[metroKey] : null;
        if (info) {
          // SEPTA Metro pills show the route code riders see on signs ("L1").
          return renderChip(
            key,
            `/line/${metroKey}`,
            chipClass,
            info.label,
            metroLineFullName(metroKey),
            { style: { backgroundColor: info.color, color: info.textColor } },
          );
        }
        const busLabel = kind === 'bus' ? formatBusRoute(key) : key;
        const busTitle =
          kind === 'bus' && busRouteName(key) ? `${busLabel} · ${busRouteName(key)}` : busLabel;
        return renderChip(
          key,
          kind === 'bus' ? `/route/${key}` : '/',
          `${chipClass} bg-slate-700 text-white`,
          busLabel,
          busTitle,
        );
      })}
    </>
  );
}
