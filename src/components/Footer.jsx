export default function Footer() {
  return (
    <footer
      className="border-t border-slate-200 dark:border-gh-border mt-8"
      style={{
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <div className="max-w-5xl mx-auto px-4 pt-6 sm:pt-4 text-xs text-slate-500 dark:text-slate-400">
        Data from SEPTA's public APIs. Unofficial — not affiliated with, endorsed by, or sponsored
        by the Southeastern Pennsylvania Transportation Authority (SEPTA).
      </div>
      <div className="max-w-5xl mx-auto px-4 py-6 sm:py-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
        <span>
          Adapted from{' '}
          <a
            href="https://github.com/cailinpitt/chicago-transit-alerts"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-600 dark:hover:text-slate-300 underline transition-colors"
          >
            Chicago Transit Alerts
          </a>
        </span>
        <a
          href="/about"
          className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          About
        </a>
        <a
          href="/subscribe"
          className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          Subscribe
        </a>
        <a
          href="/accessibility"
          className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          Accessibility
        </a>
        <a
          href="/privacy"
          className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          Privacy
        </a>
        <a
          href="https://github.com/garlicbuffalo/septa-transit-alerts"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
