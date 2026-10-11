import { useId } from 'react';

// The site's mark (same drawing as public/favicon.svg): Philadelphia City
// Hall's tower drawn in transit lines — the L1, B, and T colors rise as the
// shaft and meet at the clock, under the drum, dome, and William Penn.
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
      <path d="M11 57h42" stroke="#4F758B" strokeWidth="4" strokeLinecap="round" />
      {/* The shaft: L1, B, and T lines rising to meet at the clock */}
      <g strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M20 54V40l7.5-5.5" stroke="#5A960A" />
        <path d="M32 54V37" stroke="#F26100" />
        <path d="M44 54V40l-7.5-5.5" stroke="#0097D6" />
      </g>
      {/* Shaft windows */}
      <g fill="#0d1117">
        <rect x="19.3" y="42.5" width="1.4" height="3" rx=".7" />
        <rect x="19.3" y="48" width="1.4" height="3" rx=".7" />
        <rect x="31.3" y="41" width="1.4" height="3" rx=".7" />
        <rect x="31.3" y="46.5" width="1.4" height="3" rx=".7" />
        <rect x="43.3" y="42.5" width="1.4" height="3" rx=".7" />
        <rect x="43.3" y="48" width="1.4" height="3" rx=".7" />
      </g>
      {/* Clock face */}
      <circle cx="32" cy="30" r="6.6" fill="#0d1117" stroke="#FFD700" strokeWidth="3.8" />
      <g stroke="#FFD700" strokeLinecap="round">
        <path d="M32 25.1v1.1M36.9 30h-1.1M32 34.9v-1.1M27.1 30h1.1" strokeWidth="1" />
        <path d="M32 30v-3.2M32 30h2.5" strokeWidth="1.4" />
      </g>
      {/* Drum with arched windows, ribbed dome, lantern */}
      <rect x="26.6" y="17.4" width="10.8" height="3.8" rx=".6" fill="#FFD700" />
      <g fill="#0d1117">
        <rect x="28.4" y="18.1" width="1.4" height="2.4" rx=".7" />
        <rect x="31.3" y="18.1" width="1.4" height="2.4" rx=".7" />
        <rect x="34.2" y="18.1" width="1.4" height="2.4" rx=".7" />
      </g>
      <path
        d="M25.6 16.6C25.6 12.6 29.2 11.4 32 9.4 34.8 11.4 38.4 12.6 38.4 16.6Z"
        fill="#FFD700"
      />
      <path
        d="M32 10.2v6.4M29 16.6c.3-2.4 1.3-3.9 3-5.2M35 16.6c-.3-2.4-1.3-3.9-3-5.2"
        stroke="#0d1117"
        strokeWidth=".75"
        fill="none"
      />
      <rect x="30.8" y="7" width="2.4" height="2.8" rx=".5" fill="#FFD700" />
      {/* William Penn */}
      <g fill="#FFD700">
        <rect x="30.4" y="2.6" width="3.2" height=".85" rx=".42" />
        <rect x="31.05" y="1.3" width="1.9" height="1.7" rx=".5" />
        <circle cx="32" cy="4.3" r=".95" />
        <path d="M30.95 5.2h2.1l.35 2h-2.8z" />
      </g>
      <path d="M32.9 5.6l2.5.6" stroke="#FFD700" strokeWidth=".85" strokeLinecap="round" />
    </svg>
  );
}
