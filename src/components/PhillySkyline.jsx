// Footer skyline: Boathouse Row, the Art Museum, LOVE, City Hall with Billy
// Penn on top, the Liberty and Comcast towers, and the Ben Franklin Bridge,
// with an L1 train rolling along the El in front. Buildings take
// currentColor so the silhouette follows the theme; the accents (boathouse
// lights, LOVE, the bridge, the train) keep their real colors. Decorative.
const EL_PILLARS = Array.from({ length: 17 }, (_, i) => 10 + i * 60);
const BOATHOUSES = [20, 50, 80, 110, 140, 170];

export default function PhillySkyline({ className = '' }) {
  return (
    <svg
      viewBox="0 0 1000 140"
      preserveAspectRatio="xMidYMax slice"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Boathouse Row, outlined in lights. */}
      {BOATHOUSES.map((x) => (
        <g key={x}>
          <path d={`M${x} 132V110l13-12 13 12v22Z`} fill="currentColor" />
          <path
            d={`M${x} 110l13-12 13 12`}
            fill="none"
            stroke="#facc15"
            strokeWidth="1.2"
            strokeDasharray="1.5 2"
          />
        </g>
      ))}

      {/* Philadelphia Museum of Art, on its steps. */}
      <path d="M212 132v-6h116v6ZM218 126v-4h104v4Z" fill="currentColor" />
      <path d="M222 122V104h96v18Z" fill="currentColor" />
      <path d="M218 104l52-12 52 12Z" fill="currentColor" />
      <path
        d="M230 106v15M240 106v15M250 106v15M260 106v15M280 106v15M290 106v15M300 106v15M310 106v15"
        stroke="var(--skyline-detail)"
        strokeWidth="1.5"
      />

      {/* LOVE, with the tilted O. */}
      <g fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700" fontSize="12">
        <text x="351" y="101" fill="#dc2626">
          L
        </text>
        <text x="362" y="101" fill="#dc2626" transform="rotate(-20 367 97)">
          O
        </text>
        <text x="351" y="113" fill="#dc2626">
          V
        </text>
        <text x="362" y="113" fill="#dc2626">
          E
        </text>
      </g>
      <path d="M354 117v-3h20v3Z" fill="currentColor" />

      {/* City Hall, Billy Penn on top. */}
      <path d="M420 132V92h120v40Z" fill="currentColor" />
      <path d="M466 92V50h28v42ZM470 50V40h20v10Z" fill="currentColor" />
      <ellipse cx="480" cy="34" rx="7" ry="8" fill="currentColor" />
      <path d="M479 26V16h2v10Z" fill="currentColor" />
      <circle cx="480" cy="14" r="1.8" fill="currentColor" />
      <circle cx="480" cy="62" r="5" fill="var(--skyline-detail)" />

      {/* Fillers, One and Two Liberty Place. */}
      <path d="M545 132V78h16v54Z" fill="currentColor" />
      <path
        d="M565 132V32h28v100ZM568 32l3-8h16l3 8ZM572 24l2-7h10l2 7ZM578 17V2h2v15Z"
        fill="currentColor"
      />
      <path
        d="M600 132V52h24v80ZM603 52l3-7h12l3 7ZM608 45l2-6h4l2 6ZM611 39V28h2v11Z"
        fill="currentColor"
      />

      {/* Comcast Center and the Comcast Technology Center. */}
      <path d="M636 132V28l8-8 30 2v110Z" fill="currentColor" />
      <path d="M686 132V22h34v110Z" fill="currentColor" />
      <path d="M686 22V6h34v16h-4V10h-26v12Z" fill="currentColor" />
      <path d="M728 132V72h22v60ZM754 132V92h20v40Z" fill="currentColor" />

      {/* Ben Franklin Bridge. */}
      <g fill="none" stroke="#3b82f6" strokeWidth="2">
        <path d="M790 104h210" strokeWidth="4" />
        <path d="M790 104Q830 80 860 60Q910 104 960 60Q985 76 1000 86" />
        <path
          d="M868 104V68M878 104V78M888 104V87M932 104V87M942 104V78M952 104V68"
          strokeWidth="1"
        />
      </g>
      <path d="M857 132V56h6v76ZM957 132V56h6v76Z" fill="#3b82f6" />

      {/* The El, with an L1 train on it. Someone got to the girder first. */}
      <path d="M0 117h1000v8H0Z" fill="currentColor" />
      {EL_PILLARS.map((x) => (
        <path key={x} d={`M${x} 125h4v7h-4Z`} fill="currentColor" />
      ))}
      <text
        x="384"
        y="123.4"
        fontSize="7"
        fontWeight="700"
        fontStyle="italic"
        fontFamily="Impact, 'Arial Black', sans-serif"
        fill="var(--skyline-detail)"
      >
        BONER 4EVER
      </text>
      <g>
        <rect x="560" y="102" width="74" height="15" rx="3" fill="#0097D6" />
        <rect x="638" y="102" width="74" height="15" rx="3" fill="#0097D6" />
        {[566, 580, 594, 608, 622, 644, 658, 672, 686, 700].map((x) => (
          <rect key={x} x={x} y="105" width="8" height="5" rx="1" fill="#e0f2fe" />
        ))}
      </g>
    </svg>
  );
}
