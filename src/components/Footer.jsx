import { useState } from 'react';
import { SITE_NAME } from '../lib/site.js';
import BrandMark from './BrandMark.jsx';
import PhillySkyline from './PhillySkyline.jsx';
import TabBar from './TabBar.jsx';

// One of these rides under the site name, picked fresh on each page load.
export const FOOTER_TAGLINES = [
  'Still calling it the El.',
  'It’s the Broad Street Line, whatever the signs say.',
  'BONER 4EVER.',
  'Philly Elmo would’ve danced through this delay.',
  'Chicken Man approved.',
  'Wooder ice not included.',
  'Go Birds. Mind the gap.',
  'The city has greased the poles.',
  'Delays measured in jawns.',
  'Wit’ wiz, wit’out delays.',
  'Gritty-tested, Billy Penn-approved.',
  'Down the shore traffic not included.',
];

export default function Footer() {
  const [tagline] = useState(
    () => FOOTER_TAGLINES[Math.floor(Math.random() * FOOTER_TAGLINES.length)],
  );
  return (
    <>
      <PhillySkyline className="block w-full h-20 sm:h-auto sm:aspect-[1000/140] sm:max-w-5xl sm:mx-auto mt-10 -mb-px text-slate-200 dark:text-gh-subtle" />
      {/* `site-footer` pads for the safe-area insets and, on phones, for the
          fixed bottom tab bar (index.css). */}
      <footer className="site-footer border-t border-slate-200 dark:border-gh-border bg-white/60 dark:bg-gh-surface/40">
        <div className="max-w-5xl mx-auto px-4 pt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <BrandMark className="h-6 w-6 rounded-md" />
          {SITE_NAME}
          <span className="basis-full sm:basis-auto font-normal italic text-slate-500 dark:text-slate-400">
            <span className="hidden sm:inline">· </span>
            {tagline}
          </span>
        </div>
        <div className="max-w-5xl mx-auto px-4 pt-2 text-xs text-slate-500 dark:text-slate-400">
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
      <TabBar />
    </>
  );
}
