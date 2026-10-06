import { useEffect } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { topLevelTrail } from '../lib/breadcrumbs.js';
import { SITE_NAME } from '../lib/site.js';
import AboutContent from './AboutContent.jsx';
import Breadcrumb from './Breadcrumb.jsx';
import Footer from './Footer.jsx';
import Header from './Header.jsx';

export default function AboutPage() {
  const [dark, toggleDark] = useDarkMode();

  useEffect(() => {
    document.title = `About · ${SITE_NAME}`;
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
          <Breadcrumb items={topLevelTrail('About')} className="mb-3" />
          <h1 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4">About</h1>
          <div className="bg-white dark:bg-gh-surface rounded-lg border border-slate-200 dark:border-gh-border p-6">
            <AboutContent />
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
