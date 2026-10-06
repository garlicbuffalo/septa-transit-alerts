import { useCallback, useEffect, useState } from 'react';

export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    const stored = localStorage.getItem('darkMode');
    if (stored !== null) return stored === 'true';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    // Keep `color-scheme` in sync with the in-app choice so native UI (form
    // controls, scrollbars, the overscroll background) re-themes on toggle —
    // not just the OS-driven default the inline boot script seeds at load.
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    localStorage.setItem('darkMode', String(dark));
    // Keep the browser chrome (theme-color) in sync with the in-app toggle,
    // which can diverge from the OS preference the media-scoped metas track.
    // Dropping `media` lets the resolved choice win over the OS-based pair.
    const color = dark ? '#161b22' : '#ffffff';
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.setAttribute('content', color);
      meta.removeAttribute('media');
    }
  }, [dark]);

  const toggle = useCallback(() => setDark((d) => !d), []);
  return [dark, toggle];
}
