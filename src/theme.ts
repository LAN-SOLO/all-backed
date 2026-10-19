// Dark is the default and stays pixel-identical; light is opt-in. The choice
// persists in localStorage (same mechanism as the language toggle) and is
// applied to <html> before the first render in main.tsx, so nothing flickers.

export type Theme = 'dark' | 'light';

const THEME_KEY = 'theme';

export function detectTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark'; // storage blocked
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.classList.toggle('light', theme === 'light');
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* storage blocked — applies to this session only */
  }
  applyTheme(theme);
}
