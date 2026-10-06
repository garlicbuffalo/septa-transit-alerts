import { useEffect, useState } from 'react';
import { useDarkMode } from '../hooks/useDarkMode.js';
import { SITE_NAME } from '../lib/site.js';
import Footer from './Footer.jsx';
import Header from './Header.jsx';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-→';

// Cycles each character of `target` through random glyphs before settling, so
// the row arrives with the clack-clack feel of a split-flap board. `delay`
// staggers when this row starts shuffling relative to the others.
function FlapText({ target, delay = 0, className = '' }) {
  const [text, setText] = useState(() => ' '.repeat(target.length));

  useEffect(() => {
    // Respect the OS "reduce motion" setting: skip the split-flap shuffle and
    // land on the final text immediately. The CSS animations elsewhere are
    // gated in index.css, but this rAF-driven effect needs its own check.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setText(target);
      return;
    }

    let frame = 0;
    const totalFrames = 18 + Math.floor(target.length * 1.2);
    let raf;
    let startTimeout;

    function tick() {
      frame += 1;
      const out = target
        .split('')
        .map((finalChar, i) => {
          // Each character locks in once the wave passes its index. Earlier
          // characters settle first, giving the left-to-right cascade.
          const lockFrame = 6 + i * 1.2;
          if (frame >= lockFrame) return finalChar;
          if (finalChar === ' ') return ' ';
          return CHARS[Math.floor(Math.random() * CHARS.length)];
        })
        .join('');
      setText(out);
      if (frame < totalFrames) {
        raf = requestAnimationFrame(tick);
      } else {
        setText(target);
      }
    }

    startTimeout = setTimeout(() => {
      raf = requestAnimationFrame(tick);
    }, delay);

    return () => {
      clearTimeout(startTimeout);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [target, delay]);

  return <span className={className}>{text}</span>;
}

function Row({ label, value, delay, valueClass = 'text-amber-300', href }) {
  const inner = (
    <>
      <FlapText
        target={label.padEnd(10, ' ')}
        delay={delay}
        className="text-amber-500/80 tracking-widest"
      />
      <FlapText
        target={value}
        delay={delay + 120}
        className={`${valueClass} tracking-wider font-semibold`}
      />
    </>
  );
  const base =
    'flex items-baseline gap-4 font-mono text-base sm:text-xl border-b border-amber-900/40 py-2 last:border-b-0';
  if (href) {
    return (
      <a
        href={href}
        className={`${base} hover:bg-amber-900/10 transition-colors -mx-2 px-2 rounded`}
      >
        {inner}
      </a>
    );
  }
  return <div className={base}>{inner}</div>;
}

export default function NotFoundPage() {
  const [dark, toggleDark] = useDarkMode();
  const attemptedPath =
    typeof window !== 'undefined' ? window.location.pathname.slice(0, 24).toUpperCase() : '';

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
      <main
        id="main"
        tabIndex={-1}
        className="max-w-3xl mx-auto px-3 sm:px-4 py-8 sm:py-12 w-full flex-1"
      >
        <div className="bg-black rounded-lg border-2 border-amber-900/60 shadow-[0_0_40px_rgba(252,191,73,0.15)] overflow-hidden">
          <div className="flex items-center justify-between bg-amber-900/30 px-4 py-2 border-b border-amber-900/60 font-mono text-xs text-amber-400/80 uppercase tracking-widest">
            <span>● Departures</span>
            <span className="hidden sm:inline">{SITE_NAME}</span>
            <span>Track 404</span>
          </div>
          <div className="px-4 sm:px-6 py-5 sm:py-7">
            <Row label="TRACK" value="404" delay={0} />
            <Row label="STATUS" value="NO SUCH JAWN" delay={200} valueClass="text-red-400" />
            <Row label="REASON" value="PAGE NOT FOUND" delay={400} />
            <Row label="ROUTE" value={attemptedPath || '/'} delay={600} />
            <Row label="NEXT ARR" value="NEVER" delay={800} valueClass="text-red-400" />
            <Row
              label="ALT ROUTE"
              value="→ HOMEPAGE"
              delay={1000}
              valueClass="text-emerald-300"
              href="/"
            />
          </div>
          <div className="border-t border-amber-900/60 bg-amber-900/20 px-4 py-3 font-mono text-[11px] sm:text-xs text-amber-400/70 uppercase tracking-widest flex items-center justify-between">
            <span className="inline-flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              Service disruption
            </span>
            <a
              href="/"
              className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
            >
              Board the next train home →
            </a>
          </div>
        </div>

        {/* A nod to the city's most persistent overpass tag: unlike this
            page, some things in Philly are forever. */}
        <figure className="mt-8">
          <svg
            viewBox="0 0 600 120"
            className="w-full h-auto"
            role="img"
            aria-label="A concrete overpass spray-painted with BONER 4EVER"
          >
            <rect x="0" y="18" width="600" height="62" fill="#9ca3af" />
            <rect x="0" y="18" width="600" height="8" fill="#6b7280" />
            <rect x="0" y="74" width="600" height="6" fill="#6b7280" />
            <rect x="60" y="80" width="34" height="40" fill="#9ca3af" />
            <rect x="506" y="80" width="34" height="40" fill="#9ca3af" />
            <path d="M120 40l30 20M380 30l-10 40M470 70l40-14" stroke="#6b7280" strokeWidth="1" />
            <text
              x="300"
              y="64"
              textAnchor="middle"
              fontSize="36"
              fontWeight="900"
              fontStyle="italic"
              fontFamily="Impact, 'Arial Black', sans-serif"
              fill="#111827"
              transform="rotate(-3 300 56)"
              letterSpacing="2"
            >
              BONER 4EVER
            </text>
          </svg>
          <figcaption className="mt-3 text-center text-sm text-slate-500 dark:text-slate-400">
            Page not found. Some things in Philly are forever, but this page isn’t one of them.
          </figcaption>
        </figure>
      </main>
      <Footer />
    </div>
  );
}
