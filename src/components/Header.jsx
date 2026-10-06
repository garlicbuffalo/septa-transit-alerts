import { useEffect, useRef, useState } from 'react';
import { useNow } from '../hooks/useNow.js';
import { formatRelativeTime } from '../lib/format.js';
import { activeNavKey, LINE_STRIPE, PRIMARY_NAV } from '../lib/nav.js';
import { SITE_NAME } from '../lib/site.js';
import BrandMark from './BrandMark.jsx';
import BrowseMenu from './BrowseMenu.jsx';
import NavIcon from './NavIcon.jsx';

const FRESHNESS_NOTE =
  'When the collector last published data from SEPTA. The page checks for new data every 5 minutes while visible.';

function InfoPopover({ children, label = 'What does this mean?' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [open]);

  return (
    <span ref={ref} className="inline-flex items-center ml-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-expanded={open}
        className="inline-flex items-center justify-center hover:opacity-70 transition-opacity text-xs leading-none"
      >
        ℹ️
      </button>
      {open && (
        <span className="absolute right-0 top-full mt-1 z-20 bg-white dark:bg-gh-surface border border-slate-200 dark:border-gh-border rounded-lg shadow-lg p-3 w-64 max-w-[calc(100vw-2rem)] text-xs text-slate-600 dark:text-slate-300 normal-case font-normal text-left whitespace-normal">
          {children}
        </span>
      )}
    </span>
  );
}

// Thin band of SEPTA line colors along the top edge — the same palette as the
// tile-grid mark, so every page opens on the system's colors.
function LineStripe() {
  return (
    <div className="flex h-1" aria-hidden="true">
      {LINE_STRIPE.map((color) => (
        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
      ))}
    </div>
  );
}

export default function Header({
  generatedAt,
  dark,
  onToggleDark,
  onResetFilters,
  alerts,
  observations,
}) {
  // Tick once a minute so the relative "Nm ago" label stays honest on a tab
  // left open. The absolute Philadelphia time rides along as the hover tooltip.
  const now = useNow();
  const updatedAbs = generatedAt
    ? new Date(generatedAt).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/New_York',
      }) + ' CT'
    : null;
  const updatedRel = generatedAt ? formatRelativeTime(generatedAt, now) : null;
  const active = typeof window !== 'undefined' ? activeNavKey(window.location.pathname) : null;

  return (
    <header className="site-header bg-white dark:bg-gh-surface border-b border-slate-200 dark:border-gh-border">
      <LineStripe />
      <div className="max-w-5xl mx-auto px-4 py-3 sm:py-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0">
            <button
              type="button"
              onClick={onResetFilters}
              className="group flex items-center gap-2.5 text-left"
              aria-label="Reset filters and return to default view"
            >
              <BrandMark className="h-9 w-9 flex-shrink-0 rounded-lg shadow-sm ring-1 ring-black/5 dark:ring-white/10" />
              <span className="min-w-0">
                <span className="block text-lg sm:text-xl font-bold leading-tight tracking-tight text-slate-900 dark:text-slate-100 group-hover:opacity-70 transition-opacity">
                  {SITE_NAME}
                </span>
                <span className="hidden sm:block text-xs font-normal text-slate-500 dark:text-slate-400">
                  SEPTA Metro, bus, and Regional Rail alerts and disruptions
                </span>
              </span>
            </button>
          </h1>
          <div className="relative flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
            <BrowseMenu alerts={alerts} observations={observations} align="responsive" />
            <button
              type="button"
              onClick={onToggleDark}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 dark:bg-gh-subtle text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-gh-border transition-colors"
              aria-label="Toggle dark mode"
              title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              <NavIcon name={dark ? 'sun' : 'moon'} className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>

        {/* Section links on sm+; phones get the same destinations in the
            bottom tab bar (TabBar, rendered by Footer). */}
        <div
          className={`${updatedRel ? 'flex' : 'hidden sm:flex'} mt-2 sm:mt-3 items-center justify-between gap-4`}
        >
          <nav aria-label="Sections" className="hidden sm:block -mx-2">
            <ul className="flex items-center gap-1">
              {PRIMARY_NAV.map((item) => {
                const current = item.key === active;
                return (
                  <li key={item.key}>
                    <a
                      href={item.href}
                      aria-current={current ? 'page' : undefined}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                        current
                          ? 'bg-slate-100 text-slate-900 dark:bg-gh-subtle dark:text-slate-100'
                          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50 dark:text-slate-400 dark:hover:text-slate-100 dark:hover:bg-gh-subtle/60'
                      }`}
                    >
                      <NavIcon name={item.icon} className="h-4 w-4 opacity-80" />
                      {item.desktopLabel ?? item.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
          {updatedRel && (
            <div className="relative flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-green-500" />
              <span title={updatedAbs ?? undefined}>Updated {updatedRel}</span>
              <InfoPopover>{FRESHNESS_NOTE}</InfoPopover>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
