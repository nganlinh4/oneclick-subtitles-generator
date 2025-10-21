import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import './styles/audio-player-dark-theme.css';
import './styles/video-player-dark-theme.css';
import App from './App';
import './i18n/i18n';
import './utils/sliderDragHandler';
import './utils/sliderResetHandler';
import './utils/sliderDefaults';
import { getThemeWithFallback, setupSystemThemeListener } from './utils/systemDetection';

// Suppress harmless ResizeObserver loop error
const suppressResizeObserverError = () => {
  // Handle console errors
  const originalError = console.error;
  console.error = (...args) => {
    if (
      args.length > 0 &&
      typeof args[0] === 'string' &&
      args[0].includes('ResizeObserver loop completed with undelivered notifications')
    ) {
      // Suppress this specific harmless error
      return;
    }
    originalError.apply(console, args);
  };

  // Handle window errors
  window.addEventListener('error', (event) => {
    if (
      event.message &&
      event.message.includes('ResizeObserver loop completed with undelivered notifications')
    ) {
      event.preventDefault();
      event.stopPropagation();
      return false;
    }
  });

  // Handle unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    if (
      event.reason &&
      event.reason.message &&
      event.reason.message.includes('ResizeObserver loop completed with undelivered notifications')
    ) {
      event.preventDefault();
      return false;
    }
  });
};

// Initialize error suppression
suppressResizeObserverError();

// Theme initialization
const initializeTheme = () => {
  const theme = getThemeWithFallback();
  document.documentElement.setAttribute('data-theme', theme);

  // Save to localStorage if not already saved
  if (!localStorage.getItem('theme')) {
    localStorage.setItem('theme', theme);
  }

  // Set up system theme change listener
  setupSystemThemeListener((newTheme) => {
    const currentStoredTheme = localStorage.getItem('theme');
    // Only update if user hasn't manually set a preference
    if (!currentStoredTheme || currentStoredTheme === 'system') {
      document.documentElement.setAttribute('data-theme', newTheme);
      if (!currentStoredTheme) {
        localStorage.setItem('theme', newTheme);
      }
    }
  });
};

// Disable browser scroll restoration to prevent unwanted scrolling on page refresh
if (window.history && window.history.scrollRestoration) {
  window.history.scrollRestoration = 'manual';
}

// Initialize theme
initializeTheme();
// Mark Material Symbols font ready to avoid showing ligature text
const markMaterialSymbolsReady = () => {
  const html = document.documentElement;
  if (html.classList.contains('ms-font-ready')) return;
  html.classList.add('ms-font-ready');
};

const waitForMaterialSymbols = async () => {
  try {
    if (document.fonts && document.fonts.load) {
      // Trigger load for a representative glyph
      await document.fonts.load('24px "Material Symbols Rounded"');
      markMaterialSymbolsReady();
    } else {
      // Fallback: mark ready after a short delay
      setTimeout(markMaterialSymbolsReady, 500);
    }
  } catch (e) {
    // Ensure we don't leave icons hidden if something fails
    setTimeout(markMaterialSymbolsReady, 500);
  }
};

waitForMaterialSymbols();


// Scroll to top on page load to ensure we start at the beginning
window.scrollTo(0, 0);

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);