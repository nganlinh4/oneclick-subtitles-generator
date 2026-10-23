import { useState, useEffect } from 'react';

/**
 * Theme-aware colors for the Material 3 WavyProgressIndicator + LoadingIndicator, matching the
 * established download-progress styling (DownloadOnlyModal / VideoQualityModal): white on dark,
 * --md-primary on light. The canvas components need resolved color values, not CSS-var strings.
 */

const detectDarkTheme = () => {
  if (typeof document === 'undefined') return true; // default theme is dark (matches systemDetection)
  const root = document.documentElement;
  const body = document.body;
  const attr = (root.getAttribute('data-theme') || body?.getAttribute('data-theme') || '').toLowerCase();
  if (attr === 'light') return false;
  if (attr === 'dark') return true;
  // No explicit data-theme yet: fall back to the app's default (dark), like themeHook / getThemeWithFallback,
  // unless an explicit `light` class is present. Treating absent-as-light would paint light colors on the
  // dark default surface.
  return !(root.classList.contains('light') || body?.classList.contains('light'));
};

const getCssVar = (name, fallback) => {
  if (typeof window === 'undefined') return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
};

const hexToRgba = (hex, alpha = 1) => {
  if (!hex || hex[0] !== '#') return hex || `rgba(255,255,255,${alpha})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** @returns {{ isDarkTheme: boolean, waveColor: string, waveTrackColor: string }} */
const getWaveColors = () => {
  const isDarkTheme = detectDarkTheme();
  const waveColor = isDarkTheme ? '#FFFFFF' : getCssVar('--md-primary', '#5D5FEF');
  const waveTrackColor = isDarkTheme ? 'rgba(255,255,255,0.35)' : hexToRgba(waveColor, 0.35);
  return { isDarkTheme, waveColor, waveTrackColor };
};

/**
 * Reactive variant: recomputes the wave colors when the theme flips (data-theme attribute / class
 * mutation, or the `storage` event toggleTheme dispatches), so a long-lived panel like the Tools tab
 * doesn't stay stuck on the previous theme's colors while a wavy bar / spinner is on screen.
 */
export const useWaveColors = () => {
  const [colors, setColors] = useState(getWaveColors);
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return undefined;
    const recompute = () => setColors(getWaveColors());
    const observer = new MutationObserver(recompute);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    window.addEventListener('storage', recompute);
    recompute(); // catch any change between first render and effect attach
    return () => { observer.disconnect(); window.removeEventListener('storage', recompute); };
  }, []);
  return colors;
};
