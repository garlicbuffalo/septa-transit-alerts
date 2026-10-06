import { useState } from 'react';
import { formatPhillyDay } from '../lib/format.js';
import { SOURCE_TYPES } from '../lib/incidents.js';
import { METRO_LINES } from '../lib/metroLines.js';
import { RAIL_LINES } from '../lib/railLines.js';
import Filters from './Filters.jsx';

// Default date range — mirrors App's resetFilters(). A range other than this
// (or a pinned day) counts as an active filter.
const DEFAULT_RANGE = 7;
const RANGE_LABELS = { 7: '7 days', 30: '30 days', 60: '60 days', 90: '90 days' };

// Build the read-only chip summary of every non-default filter, so a reader
// can tell at a glance what's narrowing the list while the controls stay
// collapsed. Chips are descriptive only — expanding reveals the real toggles,
// and "Clear" resets everything. Kept deliberately compact: a colored pill
// per selected Metro line, then a short label per other active dimension.
function buildChips({
  selectedLines,
  showBus,
  selectedBusRoutes,
  selectedRailLines = [],
  dateRange,
  selectedDay,
  selectedSignals,
  selectedSources,
  network = 'all',
}) {
  const chips = [];
  // Metro line/bus chips are meaningless when the page is scoped to Regional
  // Rail (and vice-versa), so skip the out-of-scope network's chips entirely.
  const showTransit = network !== 'rail';
  const showRail = network !== 'transit';
  if (showTransit && Array.isArray(selectedLines)) {
    if (selectedLines.length === 0) {
      chips.push({ key: 'no-trains', label: 'Metro hidden' });
    } else {
      for (const line of selectedLines) {
        const info = METRO_LINES[line];
        chips.push({
          key: `line-${line}`,
          label: info?.label ?? line,
          style: info ? { backgroundColor: info.color, color: info.textColor } : undefined,
        });
      }
    }
  }
  // Only flag buses-off when it isn't the implied consequence of a Metro-line
  // selection (App auto-hides buses when a line subset is active). Otherwise
  // every "L1" pick would also sprout a redundant "Buses hidden" chip.
  const metroSubsetActive = Array.isArray(selectedLines) && selectedLines.length > 0;
  if (showTransit && !showBus && !metroSubsetActive) {
    chips.push({ key: 'no-bus', label: 'Buses hidden' });
  }
  if (showTransit && selectedBusRoutes.length > 0) {
    chips.push({ key: 'routes', label: `Routes (${selectedBusRoutes.length})` });
  }
  if (showRail) {
    for (const line of selectedRailLines) {
      const info = RAIL_LINES[line];
      // Short route code (PAO) keeps the chip compact; the popover carries the
      // full name. Matches the colored-code pills shown in the Regional Rail picker.
      chips.push({
        key: `rail-${line}`,
        label: info?.code ?? line.toUpperCase(),
        style: info ? { backgroundColor: info.color, color: info.textColor } : undefined,
      });
    }
  }
  if (selectedDay != null) {
    chips.push({ key: 'day', label: formatPhillyDay(selectedDay) });
  } else if (dateRange !== DEFAULT_RANGE) {
    chips.push({ key: 'range', label: dateRange == null ? 'All time' : RANGE_LABELS[dateRange] });
  }
  if (selectedSignals.length > 0) {
    chips.push({ key: 'signals', label: `Signals (${selectedSignals.length})` });
  }
  if (selectedSources.length < SOURCE_TYPES.length) {
    chips.push({ key: 'sources', label: `Sources (${selectedSources.length})` });
  }
  return chips;
}

// Collapsed-by-default filter entry point for the homepage. Replaces the
// always-on ~16-control bar with a single "Filters" button (badged with the
// active count) plus a chip summary of what's currently narrowing the list.
// The full Filters controls expand below on click. This keeps the dense,
// colorful control row from being the second thing a new visitor sees while
// leaving every filter one tap away — and sits directly above the incident
// list it controls.
export default function HomeFilters(props) {
  const [open, setOpen] = useState(false);
  const { onResetFilters, ...filterProps } = props;
  const chips = buildChips(filterProps);
  const activeCount = chips.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`inline-flex w-full sm:w-auto justify-center sm:justify-start items-center gap-2 px-3.5 py-2 sm:py-1.5 rounded-lg text-sm font-semibold border shadow-sm transition-colors ${
            activeCount > 0
              ? 'bg-slate-800 dark:bg-slate-200 border-slate-800 dark:border-slate-200 text-white dark:text-slate-800'
              : 'bg-white dark:bg-gh-surface border-slate-300 dark:border-gh-border text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-gh-subtle hover:border-slate-400 dark:hover:border-slate-500'
          }`}
        >
          {/* Funnel icon — the universal "filter" affordance, so the control
              reads as filtering at a glance rather than blending into the
              pill row. */}
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5 flex-shrink-0">
            <path
              d="M2 3 L14 3 L9.5 8.5 L9.5 13 L6.5 11 L6.5 8.5 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          Filters
          {activeCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-bold bg-white/25 dark:bg-slate-800/20">
              {activeCount}
            </span>
          )}
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className={`h-3 w-3 flex-shrink-0 opacity-60 transition-transform ${open ? 'rotate-90' : ''}`}
          >
            <path
              d="M4 2.5 L8 6 L4 9.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Chip summary of active filters — shown when collapsed so the
            reader knows the list is narrowed without opening the controls. */}
        {!open &&
          chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-200 dark:bg-gh-subtle text-slate-600 dark:text-slate-300"
              style={chip.style}
            >
              {chip.label}
            </span>
          ))}

        {activeCount > 0 && (
          <button
            type="button"
            onClick={onResetFilters}
            className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline underline-offset-2"
          >
            Clear
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3">
          <Filters {...filterProps} />
        </div>
      )}
    </div>
  );
}
