import { useEffect, useRef, useState } from 'react';
import { busRouteDisplayId, formatBusRoute } from '../lib/busRoutes.js';
import { formatPhillyDay } from '../lib/format.js';
import { SIGNAL_LABELS, SIGNAL_TYPES, SOURCE_LABELS, SOURCE_TYPES } from '../lib/incidents.js';
import { METRO_LINE_ORDER, METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINE_ORDER, RAIL_LINES } from '../lib/railLines.js';

const DATE_OPTIONS = [
  { label: '7d', value: 7 },
  { label: '30d', value: 30 },
  { label: '60d', value: 60 },
  { label: '90d', value: 90 },
  { label: 'All', value: null },
];

// Thin vertical rule between control groups (sm+ only). Rendered between groups
// rather than after each one, so a hidden group doesn't leave an orphan divider.
function Divider() {
  return <div className="hidden sm:block w-px h-4 bg-slate-200 dark:bg-slate-600" />;
}

function BusRoutePopover({ availableBusRoutes, selectedBusRoutes, onBusRoutesChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleRoute = (route) => {
    onBusRoutesChange((prev) =>
      prev.includes(route) ? prev.filter((r) => r !== route) : [...prev, route],
    );
  };

  const selectedCount = selectedBusRoutes.length;
  const label = selectedCount > 0 ? `Routes (${selectedCount})` : 'Routes';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors flex items-center gap-1 ${
          selectedCount > 0
            ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
            : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
        }`}
      >
        {label}
        <span className="opacity-60">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-20 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 min-w-[160px] max-w-[calc(100vw-1rem)]">
          <div className="flex flex-wrap gap-1.5">
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => onBusRoutesChange([])}
                className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800 hover:opacity-80 transition-opacity"
              >
                All routes
              </button>
            )}
            {availableBusRoutes.map((route) => {
              const active = selectedBusRoutes.includes(route);
              const label = formatBusRoute(route);
              return (
                <button
                  type="button"
                  key={route}
                  onClick={() => toggleRoute(route)}
                  title={label}
                  aria-label={label}
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                      : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                  }`}
                >
                  {busRouteDisplayId(route)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Regional Rail line filter — a popover of line-code pills, mirroring the bus
// routes popover. Empty selection means "all Regional Rail lines" (no
// narrowing); a non-empty selection restricts Regional Rail incidents to those
// lines. A popover (vs the inline Metro pills) keeps the 13 lines from
// overflowing the filter row.
function RailLinesPopover({ selectedRailLines, onRailLinesChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (line) => {
    onRailLinesChange((prev) =>
      prev.includes(line) ? prev.filter((l) => l !== line) : [...prev, line],
    );
  };

  const selectedCount = selectedRailLines.length;
  const label = selectedCount > 0 ? `Regional Rail (${selectedCount})` : 'Regional Rail';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors flex items-center gap-1 ${
          selectedCount > 0
            ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
            : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
        }`}
      >
        {label}
        <span className="opacity-60">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-20 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 min-w-[180px] max-w-[calc(100vw-1rem)]">
          <div className="flex flex-wrap gap-1.5">
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => onRailLinesChange([])}
                className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800 hover:opacity-80 transition-opacity"
              >
                All lines
              </button>
            )}
            {RAIL_LINE_ORDER.map((line) => {
              const info = RAIL_LINES[line];
              const active = selectedRailLines.includes(line);
              const dimmed = selectedCount > 0 && !active;
              // Full line names ("Lansdale/Doylestown") wrap and look ragged as
              // pills, so show SEPTA's route code (LAN) and keep the full name
              // as the hover/screen-reader label.
              const name = info ? `${info.label} Line` : line;
              return (
                <button
                  type="button"
                  key={line}
                  onClick={() => toggle(line)}
                  title={name}
                  aria-label={name}
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                    dimmed
                      ? 'bg-slate-200 dark:bg-gh-subtle text-slate-500 dark:text-slate-400'
                      : ''
                  }`}
                  style={dimmed ? {} : { backgroundColor: info.color, color: info.textColor }}
                >
                  {info?.code ?? line.toUpperCase()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SignalsPopover({ selectedSignals, onSignalsChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (sig) => {
    onSignalsChange((prev) =>
      prev.includes(sig) ? prev.filter((s) => s !== sig) : [...prev, sig],
    );
  };

  const selectedCount = selectedSignals.length;
  const label = selectedCount > 0 ? `Signals (${selectedCount})` : 'Signals';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors flex items-center gap-1 ${
          selectedCount > 0
            ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
            : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
        }`}
      >
        {label}
        <span className="opacity-60">▾</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-20 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 min-w-[200px] max-w-[calc(100vw-1rem)]">
          <div className="flex flex-wrap gap-1.5">
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => onSignalsChange([])}
                className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800 hover:opacity-80 transition-opacity"
              >
                All signals
              </button>
            )}
            {SIGNAL_TYPES.map((sig) => {
              const active = selectedSignals.includes(sig);
              return (
                <button
                  type="button"
                  key={sig}
                  onClick={() => toggle(sig)}
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors capitalize ${
                    active
                      ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                      : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                  }`}
                >
                  {SIGNAL_LABELS[sig]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Source-type popover — three pills (SEPTA reported, Bot observation, Both)
// for narrowing the incident list by where the detection came from. Mirrors
// SignalsPopover's structure so the affordance feels the same across the
// filter row. Empty selection means "no narrowing" (show all three buckets).
function SourcesPopover({ selectedSources, onSourcesChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggle = (src) => {
    onSourcesChange((prev) =>
      prev.includes(src) ? prev.filter((s) => s !== src) : [...prev, src],
    );
  };

  // "Selected = shown" model: a fully-selected list is the default (no
  // narrowing), so the chip reads neutrally as "Sources" then. Partial
  // selections show "Sources (N)" and pop the chip into the active style.
  const selectedCount = selectedSources.length;
  const isDefault = selectedCount === SOURCE_TYPES.length;
  const label = isDefault ? 'Sources' : `Sources (${selectedCount})`;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors flex items-center gap-1 ${
          isDefault
            ? 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
            : 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
        }`}
      >
        {label}
        <span className="opacity-60">▾</span>
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1.5 z-20 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 min-w-[200px] max-w-[calc(100vw-1rem)]">
          <div className="flex flex-wrap gap-1.5">
            {!isDefault && (
              <button
                type="button"
                onClick={() => onSourcesChange([...SOURCE_TYPES])}
                title="Re-select every source category"
                className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
              >
                Reset
              </button>
            )}
            {SOURCE_TYPES.map((src) => {
              const active = selectedSources.includes(src);
              return (
                <button
                  type="button"
                  key={src}
                  onClick={() => toggle(src)}
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                      : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                  }`}
                >
                  {SOURCE_LABELS[src]}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Filters({
  selectedLines,
  onLinesChange,
  showBus,
  onShowBusChange,
  availableBusRoutes,
  selectedBusRoutes,
  onBusRoutesChange,
  selectedRailLines = [],
  onRailLinesChange,
  dateRange,
  onDateRangeChange,
  selectedDay = null,
  onClearSelectedDay,
  selectedSignals = [],
  onSignalsChange,
  selectedSources = [],
  onSourcesChange,
  // Hide the date-range / pinned-day chips. Used by pages with a fixed time
  // scope (calendar = 12 months) where a "7d / 30d / 60d / 90d / All" pill
  // group would be inert and confusing.
  hideDateRange = false,
  // Page-level network scope ('all' | 'transit' | 'rail'). Hides the controls
  // that can't affect the current scope — Metro line/bus chips when scoped to
  // Regional Rail, the Regional Rail line picker when scoped to Metro & Bus —
  // so no inert filters are shown.
  network = 'all',
}) {
  const toggleLine = (line) => {
    onLinesChange((prev) => {
      if (prev === null) return [line];
      return prev.includes(line) ? prev.filter((l) => l !== line) : [...prev, line];
    });
  };

  const showTransit = network !== 'rail';
  const showRail = network !== 'transit' && !!onRailLinesChange;

  return (
    <div className="flex flex-wrap gap-3 items-center">
      {showTransit && (
        <>
          {/* Line filter */}
          <div className="flex flex-wrap gap-1.5 items-center">
            <button
              type="button"
              onClick={() =>
                onLinesChange(selectedLines !== null && selectedLines.length === 0 ? null : [])
              }
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                selectedLines === null || selectedLines.length > 0
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                  : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
              }`}
            >
              Metro
            </button>
            {METRO_LINE_ORDER.map((key) => {
              const info = METRO_LINES[key];
              const active = selectedLines?.includes(key);
              const dimmed = selectedLines !== null && !active;
              return (
                <button
                  type="button"
                  key={key}
                  onClick={() => toggleLine(key)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                    dimmed
                      ? 'bg-slate-200 dark:bg-gh-subtle text-slate-500 dark:text-slate-400'
                      : ''
                  }`}
                  style={dimmed ? {} : { backgroundColor: info.color, color: info.textColor }}
                  title={info.name}
                >
                  {info.label}
                </button>
              );
            })}
          </div>

          <Divider />

          {/* Bus toggle + route popover */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onShowBusChange(!showBus)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                showBus
                  ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                  : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
              }`}
            >
              Buses
            </button>
            {showBus && availableBusRoutes.length > 0 && (
              <BusRoutePopover
                availableBusRoutes={availableBusRoutes}
                selectedBusRoutes={selectedBusRoutes}
                onBusRoutesChange={onBusRoutesChange}
              />
            )}
          </div>
        </>
      )}

      {/* Regional Rail line filter — only when the host wires it up (the
          homepage) and the scope isn't Metro & Bus only. */}
      {showRail && (
        <>
          {showTransit && <Divider />}
          <RailLinesPopover
            selectedRailLines={selectedRailLines}
            onRailLinesChange={onRailLinesChange}
          />
        </>
      )}

      {/* Date range filter — replaced by a day chip when a single day is pinned. */}
      {!hideDateRange && (
        <>
          {(showTransit || showRail) && <Divider />}
          <div className="flex gap-1">
            {selectedDay != null ? (
              <button
                type="button"
                onClick={onClearSelectedDay}
                className="px-3 py-1 rounded-full text-xs font-semibold inline-flex items-center gap-1.5 bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800 hover:opacity-80 transition-opacity"
                aria-label={`Clear day filter: ${formatPhillyDay(selectedDay)}`}
              >
                <span>Showing {formatPhillyDay(selectedDay)}</span>
                <span aria-hidden="true" className="opacity-70">
                  ×
                </span>
              </button>
            ) : (
              DATE_OPTIONS.map(({ label, value }) => (
                <button
                  type="button"
                  key={label}
                  onClick={() => onDateRangeChange(value)}
                  className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${
                    dateRange === value
                      ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-800'
                      : 'bg-slate-100 dark:bg-gh-subtle text-slate-500 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border'
                  }`}
                >
                  {label}
                </button>
              ))
            )}
          </div>
        </>
      )}

      {(showTransit || showRail || !hideDateRange) && <Divider />}

      {/* Signal-type filter — collapses into a single popover chip at every
          breakpoint to keep the filter row from wrapping. Mirrors the
          bus-routes popover pattern. */}
      <SignalsPopover selectedSignals={selectedSignals} onSignalsChange={onSignalsChange} />
      <SourcesPopover selectedSources={selectedSources} onSourcesChange={onSourcesChange} />
    </div>
  );
}
