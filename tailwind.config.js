/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        // Overpass is an open-source take on Highway Gothic, the lettering on
        // US road signs — a transit-signage voice for the wordmark and headings.
        display: ['"Overpass Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        gh: {
          canvas: '#0d1117', // main background
          subtle: '#21262d', // button / interactive bg
          surface: '#161b22', // card / panel background
          border: '#30363d', // borders
          muted: '#8b949e', // muted text
        },
      },
      keyframes: {
        // Brief blue tint that fades to transparent. Applied to incident
        // rows that just appeared after a poll, so returning visitors
        // notice what's new without a hard-to-miss flash.
        'fade-highlight': {
          '0%': { backgroundColor: 'rgba(59, 130, 246, 0.18)' },
          '100%': { backgroundColor: 'rgba(59, 130, 246, 0)' },
        },
      },
      animation: {
        'fade-highlight': 'fade-highlight 5s ease-out',
      },
    },
  },
  plugins: [],
};
