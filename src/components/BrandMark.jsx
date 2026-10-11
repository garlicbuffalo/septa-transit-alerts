import { useId } from 'react';

// The site's mark (same drawing as public/favicon.svg): Philadelphia City
// Hall drawn in transit lines — the L1, B, and T colors form the building and
// converge into the tower's shaft, up to the clock, drum, dome, and Penn.
// Decorative — the site name always sits beside it.
export default function BrandMark({ className = 'h-8 w-8' }) {
  // The header and footer both render a mark, so the gradient id must be unique
  // (and a plain name: url(#…) can't take every character useId may emit).
  const bg = `brand-bg${useId().replace(/[^\w-]/g, '')}`;
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1c2330" />
          <stop offset="1" stopColor="#0d1117" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill={`url(#${bg})`} />
      {/* City Hall's roofline, in the Regional Rail slate */}
      <path d="M10 58h44" stroke="#4F758B" strokeWidth="4" strokeLinecap="round" />
      {/* The building: L1, B, and T lines rising and converging under the tower */}
      <g strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M17 55v-6l15-6" stroke="#5A960A" />
        <path d="M47 55v-6l-15-6" stroke="#0097D6" />
        <path d="M32 55V43" stroke="#F26100" />
      </g>
      {/* Windows */}
      <g fill="#0d1117">
        <rect x="16.3" y="50.5" width="1.4" height="3" rx=".7" />
        <rect x="31.3" y="48.5" width="1.4" height="3" rx=".7" />
        <rect x="46.3" y="50.5" width="1.4" height="3" rx=".7" />
      </g>
      {/* The tower shaft, one yellow line up to the clock */}
      <path d="M32 41V27.7" stroke="#FFD700" strokeWidth="6" strokeLinecap="round" />
      <rect x="31.4" y="29.3" width="1.2" height="2.6" rx=".6" fill="#0d1117" />
      {/* Interchange: a station dot where the four lines meet */}
      <circle cx="32" cy="43" r="3.2" fill="#fff" stroke="#0d1117" strokeWidth="1.3" />
      {/* Clock face */}
      <circle cx="32" cy="24.7" r="3" fill="#0d1117" stroke="#FFD700" strokeWidth="2" />
      <g stroke="#FFD700" strokeLinecap="round">
        <path d="M32 24.7v-1.8M32 24.7h1.4" strokeWidth="0.75" />
      </g>
      {/* Drum with arched windows, ribbed dome, lantern */}
      <rect x="29" y="16.9" width="6" height="3.4" rx=".6" fill="#FFD700" />
      <g fill="#0d1117">
        <rect x="30.2" y="17.5" width="1.2" height="2.2" rx=".6" />
        <rect x="32.6" y="17.5" width="1.2" height="2.2" rx=".6" />
      </g>
      <path d="M29 16.1C29 12.5 30.7 11.2 32 9.5 33.3 11.2 35 12.5 35 16.1Z" fill="#FFD700" />
      <path d="M32 10.3V16.1" stroke="#0d1117" strokeWidth=".65" fill="none" />
      <rect x="30.9" y="7.5" width="2.2" height="2.4" rx=".5" fill="#FFD700" />
      {/* William Penn */}
      <g fill="#FFD700">
        <rect x="30.5" y="3.45" width="3" height=".8" rx=".4" />
        <rect x="31.1" y="2.2" width="1.8" height="1.6" rx=".5" />
        <circle cx="32" cy="5.05" r=".9" />
        <path d="M31 5.9h2l.35 1.8h-2.7z" />
      </g>
      <path d="M32.85 6.3l1.75.95" stroke="#FFD700" strokeWidth=".8" strokeLinecap="round" />
    </svg>
  );
}
