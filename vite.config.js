import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';
import { SITE_ORIGIN } from './src/lib/site.js';

// Copy `index.html` to `404.html` after build. GitHub Pages serves `404.html`
// for any path it can't match (e.g. `/event/abc`); making it identical to
// `index.html` boots the SPA so client-side routing can take over.
function spaFallback() {
  return {
    name: 'spa-fallback',
    apply: 'build',
    closeBundle() {
      const out = this.environment?.config?.build?.outDir ?? 'dist';
      copyFileSync(resolve(out, 'index.html'), resolve(out, '404.html'));
    },
  };
}

// Static files that carry absolute URLs (canonical/OG tags, robots.txt, the
// llms.txt index, the API catalog) are written with a `__SITE_ORIGIN__`
// placeholder; substitute the configured origin (src/lib/site.js — set via the
// SITE_URL env var) so the domain is configured in exactly one place.
const ORIGIN_TOKEN = /__SITE_ORIGIN__/g;
const ORIGIN_TEMPLATED_FILES = [
  'robots.txt',
  'llms.txt',
  'llms-full.txt',
  '.well-known/security.txt',
  '.well-known/api-catalog',
];
function siteOrigin() {
  return {
    name: 'site-origin',
    transformIndexHtml(html) {
      return html.replace(ORIGIN_TOKEN, SITE_ORIGIN);
    },
    closeBundle() {
      const out = this.environment?.config?.build?.outDir ?? 'dist';
      for (const file of ORIGIN_TEMPLATED_FILES) {
        const path = resolve(out, file);
        if (!existsSync(path)) continue;
        writeFileSync(path, readFileSync(path, 'utf8').replace(ORIGIN_TOKEN, SITE_ORIGIN));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), siteOrigin(), spaFallback()],
  base: '/',
  test: {
    // The bot service is its own package with its own dependencies; its tests
    // run with `npm run test:bot`.
    exclude: [...configDefaults.exclude, 'bot/**'],
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
});
