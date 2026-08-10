// Pure theme-detection and CSS-variable helpers for the Video Quality modal.
// No React, no closures — safe to import anywhere.

// Robust theme detection: look at <html>, <body>, and 'dark' class
export const detectDarkTheme = () => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  try {
    const root = document.documentElement;
    const body = document.body;
    const attr = (root.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
    if (attr === 'dark') return true;
    if (root.classList.contains('dark') || body?.classList.contains('dark')) return true;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
    // Fallback: infer from --md-surface luminance
    const surface = getComputedStyle(root).getPropertyValue('--md-surface').trim();
    const c = surface.startsWith('#') ? surface.slice(1) : surface;
    if (c && (c.length === 6 || c.length === 3)) {
      const hex = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
      const r = parseInt(hex.slice(0,2),16)/255;
      const g = parseInt(hex.slice(2,4),16)/255;
      const b = parseInt(hex.slice(4,6),16)/255;
      const toLin = (u) => (u <= 0.03928 ? u/12.92 : Math.pow((u+0.055)/1.055, 2.4));
      const L = 0.2126*toLin(r) + 0.7152*toLin(g) + 0.0722*toLin(b);
      if (L < 0.5) return true; // dark surface
    }
  } catch {
    // Invalid or unavailable theme metadata falls back to light mode.
  }
  return false;
};

// Helpers to read CSS variables
export const getCssVar = (name, fallback) => {
  if (typeof window === 'undefined') return fallback;
  const styles = getComputedStyle(document.documentElement);
  const val = styles.getPropertyValue(name).trim();
  return val || fallback;
};

// Resolve spinner/wavy-progress colors for the current theme (invert variants per theme).
export const getThemeColors = (isDarkTheme) => ({
  waveColor: isDarkTheme ? '#FFFFFF' : getCssVar('--md-primary', '#5D5FEF'),
  waveTrackColor: isDarkTheme ? 'rgba(255,255,255,0.35)' : '#404659',
});
