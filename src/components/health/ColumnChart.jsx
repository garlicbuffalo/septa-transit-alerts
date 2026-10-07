import { useId, useRef, useState } from 'react';

// Compact column chart for the health dashboard, built from plain divs so it
// sizes to its container (phones included) without measuring. Columns may be
// stacked; segments are separated by a 2px surface gap and only the top one
// gets the rounded data-end.
//
// Interaction: the whole plot is the hit target — the pointer snaps to the
// nearest column (so a 1px-tall bar is as easy to hover as a tall one), and
// the plot is a single tab stop whose ←/→ keys step through columns, showing
// the same tooltip as hover. A visually hidden table carries every value for
// screen readers, so the tooltip never gates a number.
//
// bins: [{ key, label?, tipTitle, segments: [{ key, label, value, className }], noData? }]
export default function ColumnChart({
  bins,
  height = 40,
  ariaLabel,
  // Column + value headers for the hidden data table.
  tableHeaders = ['Bucket', 'Count'],
  // Label every column under the axis (few columns), or just the two ends.
  showBinLabels = false,
  axisStart = null,
  axisEnd = null,
  // Print each column's total on its cap (few columns only).
  capLabels = false,
  // Optional per-column class override, e.g. accent the current hour.
  columnClassName = null,
  noDataTip = 'No data collected yet',
}) {
  const [active, setActive] = useState(null);
  const plotRef = useRef(null);
  const tableId = useId();
  const n = bins.length;
  const totals = bins.map((b) => b.segments.reduce((s, seg) => s + seg.value, 0));
  const max = Math.max(1, ...totals);
  // Headroom for cap labels so the tallest column's number isn't clipped.
  const capRoom = capLabels ? 14 : 0;
  const plotHeight = height;
  if (n === 0) return null;

  function indexFromPointer(e) {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width - 1);
    return Math.floor((x / rect.width) * n);
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? (step > 0 ? -1 : n)) + step)));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === 'Escape') {
      setActive(null);
    }
  }

  const activeBin = active != null ? bins[active] : null;
  // Anchor the tooltip over the column, sliding it so it never leaves the
  // plot: at the left edge it hangs right, at the right edge it hangs left.
  const leftPct = active != null ? ((active + 0.5) / n) * 100 : 0;

  return (
    <div className="relative">
      <div
        ref={plotRef}
        role="img"
        aria-label={ariaLabel}
        aria-describedby={tableId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: arrow-key stepping through columns mirrors hover
        tabIndex={0}
        onPointerMove={(e) => setActive(indexFromPointer(e))}
        onPointerDown={(e) => setActive(indexFromPointer(e))}
        onPointerLeave={(e) => {
          if (e.pointerType === 'mouse') setActive(null);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        className="relative flex items-end border-b border-slate-200 dark:border-gh-border rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gh-surface touch-pan-y"
        style={{ height: plotHeight + capRoom }}
      >
        {bins.map((bin, i) => {
          const total = totals[i];
          const colPx = total > 0 ? Math.max(2, Math.round((total / max) * plotHeight)) : 0;
          const visible = bin.segments.filter((s) => s.value > 0);
          const gaps = Math.max(0, visible.length - 1) * 2;
          const usable = Math.max(visible.length * 2, colPx - gaps);
          // Top-to-bottom DOM order; the stack's first segment sits on the baseline.
          const ordered = [...visible].reverse();
          return (
            <div
              key={bin.key}
              className={`relative flex h-full flex-1 min-w-0 flex-col items-center justify-end ${
                active === i ? 'bg-slate-100 dark:bg-white/5' : ''
              }`}
            >
              {capLabels && total > 0 && (
                <span className="mb-0.5 text-[10px] font-medium leading-none tabular-nums text-slate-500 dark:text-slate-400">
                  {total}
                </span>
              )}
              <div
                className="flex w-full max-w-[24px] flex-col gap-[2px] px-[1px]"
                style={{ height: colPx > 0 ? colPx : undefined }}
              >
                {ordered.map((seg, j) => (
                  <div
                    key={seg.key}
                    className={`w-full ${j === 0 ? 'rounded-t-[4px]' : ''} ${
                      columnClassName?.(bin, i, seg) ?? seg.className
                    }`}
                    style={{ height: Math.max(2, Math.round((seg.value / total) * usable)) }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {showBinLabels ? (
        <div className="mt-1 flex" aria-hidden="true">
          {bins.map((bin) => (
            <span
              key={bin.key}
              className="flex-1 min-w-0 truncate text-center text-[10px] text-slate-500 dark:text-slate-400"
            >
              {bin.label}
            </span>
          ))}
        </div>
      ) : (
        (axisStart || axisEnd) && (
          <div
            className="mt-1 flex justify-between text-[10px] text-slate-500 dark:text-slate-400"
            aria-hidden="true"
          >
            <span>{axisStart}</span>
            <span>{axisEnd}</span>
          </div>
        )
      )}

      {activeBin && (
        <div
          className="pointer-events-none absolute z-20 w-max max-w-[14rem] rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs shadow-lg dark:border-gh-border dark:bg-gh-canvas"
          style={{
            left: `${leftPct}%`,
            bottom: 'calc(100% + 4px)',
            transform: `translateX(-${leftPct}%)`,
          }}
          role="tooltip"
        >
          <div className="font-medium text-slate-500 dark:text-slate-400">{activeBin.tipTitle}</div>
          {activeBin.noData ? (
            <div className="text-slate-500 dark:text-slate-400">{noDataTip}</div>
          ) : activeBin.segments.length === 1 ? (
            <div className="text-slate-900 dark:text-slate-100">
              <strong className="text-sm font-semibold">{activeBin.segments[0].value}</strong>{' '}
              <span className="text-slate-500 dark:text-slate-400">
                {activeBin.segments[0].label}
              </span>
            </div>
          ) : (
            <ul className="mt-0.5 space-y-0.5">
              {activeBin.segments.map((seg) => (
                <li key={seg.key} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className={`inline-block h-0.5 w-2.5 rounded-full ${seg.className}`}
                  />
                  <strong className="tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                    {seg.value}
                  </strong>
                  <span className="text-slate-500 dark:text-slate-400">{seg.label}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* sr-only goes on a wrapper: a table ignores the 1px width and would
          widen the page on phones. */}
      <div className="sr-only">
        <table id={tableId}>
          <thead>
            <tr>
              <th scope="col">{tableHeaders[0]}</th>
              {bins[0]?.segments.length > 1 ? (
                bins[0].segments.map((seg) => (
                  <th key={seg.key} scope="col">
                    {seg.label}
                  </th>
                ))
              ) : (
                <th scope="col">{tableHeaders[1]}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {bins.map((bin) => (
              <tr key={bin.key}>
                <th scope="row">{bin.tipTitle}</th>
                {bin.noData ? (
                  <td colSpan={Math.max(1, bin.segments.length)}>{noDataTip}</td>
                ) : (
                  bin.segments.map((seg) => <td key={seg.key}>{seg.value}</td>)
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
