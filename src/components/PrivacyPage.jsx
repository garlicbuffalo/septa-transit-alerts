import { useEffect } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { SITE_NAME } from '../lib/site.js';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';

const LINK = 'text-blue-500 hover:text-blue-400 hover:underline';
const H2 = 'font-semibold text-slate-700 dark:text-slate-200 pt-3';

export default function PrivacyPage() {
  const [dark, toggleDark] = useDarkMode();

  useEffect(() => {
    document.title = `Privacy · ${SITE_NAME}`;
    return () => {
      document.title = SITE_NAME;
    };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gh-canvas flex flex-col">
      <Header
        generatedAt={null}
        dark={dark}
        onToggleDark={toggleDark}
        onResetFilters={() => {
          window.location.href = '/';
        }}
        alerts={null}
        observations={null}
      />
      <main id="main" tabIndex={-1} className="max-w-3xl mx-auto px-4 py-6 space-y-4 w-full flex-1">
        <div>
          <Breadcrumb items={topLevelTrail('Privacy')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4">Privacy</h1>
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-6 space-y-3 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
            <p>
              {SITE_NAME} is a static website with no accounts, no backend, and no database of
              visitors. The short version: it doesn't collect personal data about you.
            </p>

            <h2 className={H2}>What we collect</h2>
            <p>
              Nothing. There are no sign-ups, no forms that send anything anywhere, no cookies, no
              analytics, and no advertising. The site never asks for your name, email, or location.
            </p>

            <h2 className={H2}>Stored in your browser</h2>
            <p>
              Two preferences are saved in your browser's{' '}
              <code className="text-xs">localStorage</code> so the site remembers them between
              visits: your light/dark mode choice, and the filters you've applied (selected lines,
              routes, and date range). This data stays on your device, is never transmitted to us or
              anyone else, and you can clear it any time through your browser settings.
            </p>

            <h2 className={H2}>Third parties</h2>
            <p>
              No third-party scripts, trackers, fonts, or embeds run here. The one thing loaded from
              outside is the map tiles behind the maps on event and line pages: your browser fetches
              those images from CARTO's map servers (directly, or through a relay) or, if those
              aren't set up, from OpenStreetMap, so that host sees your IP address, which tiles you
              view, and this site's address. Links out to Bluesky, SEPTA, or GitHub only load when
              you choose to click them, and those sites have their own privacy policies.
            </p>

            <h2 className={H2}>Hosting and server logs</h2>
            <p>
              The site is hosted on{' '}
              <a
                className={LINK}
                href="https://pages.github.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub Pages
              </a>
              . Like any web server, GitHub may process standard request information (such as your
              IP address and browser user-agent) to deliver the page and for security — see{' '}
              <a
                className={LINK}
                href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub's Privacy Statement
              </a>
              . We don't operate those servers and don't have access to or use those logs.
            </p>

            <h2 className={H2}>The data shown on the site</h2>
            <p>
              The incidents shown here are built from SEPTA's public service alerts and real-time
              vehicle, train, elevator, and schedule feeds, and link to the project's own public
              Bluesky posts. None of it is personal information about site visitors.
            </p>

            <h2 className={H2}>Questions</h2>
            <p>
              Questions or concerns? Reach out via the{' '}
              <a
                className={LINK}
                href="https://github.com/garlicbuffalo/septa-transit-alerts"
                target="_blank"
                rel="noopener noreferrer"
              >
                project on GitHub
              </a>
              .
            </p>

            <p className="pt-2 text-xs text-slate-500 dark:text-slate-400">
              Last updated October 6, 2026.
            </p>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
