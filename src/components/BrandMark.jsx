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
      {/* The tower shaft, one narrow line up to the clock */}
      <path d="M32 43V35" stroke="#FFD700" strokeWidth="3" strokeLinecap="round" />
      {/* Clock face */}
      <circle cx="32" cy="28" r="6.2" fill="#0d1117" stroke="#FFD700" strokeWidth="3.6" />
      <g stroke="#FFD700" strokeLinecap="round">
        <path d="M32 23.4v1M36.6 28h-1M32 32.6v-1M27.4 28h1" strokeWidth=".95" />
        <path d="M32 28v-3M32 28h2.4" strokeWidth="1.3" />
      </g>
      {/* Drum with arched windows, ribbed dome, lantern */}
      <rect x="27" y="16" width="10" height="3.6" rx=".6" fill="#FFD700" />
      <g fill="#0d1117">
        <rect x="28.7" y="16.6" width="1.3" height="2.3" rx=".65" />
        <rect x="31.35" y="16.6" width="1.3" height="2.3" rx=".65" />
        <rect x="34" y="16.6" width="1.3" height="2.3" rx=".65" />
      </g>
      <path d="M26 15.2C26 11.4 29.4 10.2 32 8.2 34.6 10.2 38 11.4 38 15.2Z" fill="#FFD700" />
      <path
        d="M32 9v6.2M29.2 15.2c.3-2.3 1.2-3.7 2.8-5M34.8 15.2c-.3-2.3-1.2-3.7-2.8-5"
        stroke="#0d1117"
        strokeWidth=".7"
        fill="none"
      />
      <rect x="30.85" y="6.2" width="2.3" height="2.5" rx=".5" fill="#FFD700" />
      {/* William Penn */}
      <g fill="#FFD700">
        <rect x="30.45" y="2.15" width="3.1" height=".8" rx=".4" />
        <rect x="31.1" y=".9" width="1.8" height="1.6" rx=".5" />
        <circle cx="32" cy="3.75" r=".9" />
        <path d="M31 4.6h2l.35 1.8h-2.7z" />
      </g>
      <path d="M32.85 5l2.4.6" stroke="#FFD700" strokeWidth=".8" strokeLinecap="round" />
    </svg>
  );
}
