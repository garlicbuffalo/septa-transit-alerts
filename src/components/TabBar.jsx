import { activeNavKey, PRIMARY_NAV } from '../lib/nav.js';
import NavIcon from './NavIcon.jsx';

// App-style bottom tab bar for phones (hidden from `sm` up, where the header
// carries the same links). Fixed to the bottom edge above the home indicator;
// Footer reserves matching space so it never covers the end of a page.
export default function TabBar() {
  const active = typeof window !== 'undefined' ? activeNavKey(window.location.pathname) : null;
  return (
    <nav
      aria-label="Primary"
      className="tab-bar sm:hidden fixed inset-x-0 bottom-0 z-40 border-t border-slate-200/80 dark:border-gh-border bg-white/90 dark:bg-gh-surface/90 backdrop-blur-md"
    >
      <ul className="grid grid-cols-5">
        {PRIMARY_NAV.map((item) => {
          const current = item.key === active;
          return (
            <li key={item.key}>
              <a
                href={item.href}
                aria-current={current ? 'page' : undefined}
                className={`flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px] font-medium transition-colors active:opacity-60 ${
                  current
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${
                    current ? 'bg-blue-50 dark:bg-blue-500/15' : ''
                  }`}
                >
                  <NavIcon name={item.icon} className="h-[22px] w-[22px]" />
                </span>
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
