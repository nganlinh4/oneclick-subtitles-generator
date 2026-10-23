/**
 * Forwards the main app's theme and font to the embedded PromptDJ frame, now and on every change
 * (the `data-theme` attribute, the system color scheme, and the `app_font` preference).
 */
import { useEffect } from 'react';
import { APP_FONT_PREFERENCE } from '../../platform/nativeUiPreferences';
import { subscribePreference } from '../../platform/preferences/store';

/** Posts the app's current font; advisory, so a failure is ignored. */
export const postCurrentFont = (postToPromptDj) => {
  try {
    postToPromptDj({ type: 'pm-dj-set-font', font: APP_FONT_PREFERENCE.readMirror('google-sans') });
  } catch {
    // Font synchronization is advisory for the isolated iframe.
  }
};

/** Posts the app's current theme; advisory, so a failure is ignored. */
export const postCurrentTheme = (postToPromptDj) => {
  try {
    const theme = document.documentElement.getAttribute('data-theme')
      || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    postToPromptDj({ type: 'pm-dj-set-theme', theme });
  } catch {
    // Theme synchronization is advisory for the isolated iframe.
  }
};

const usePromptDjAppearanceSync = (postToPromptDj) => {
  // Watch main app theme changes and forward to iframe
  useEffect(() => {
    const el = document.documentElement;
    const sendTheme = () => postCurrentTheme(postToPromptDj);

    // Initial
    sendTheme();

    // Observe attribute changes
    const observer = new MutationObserver((mutList) => {
      for (const m of mutList) {
        if (m.type === 'attributes' && m.attributeName === 'data-theme') {
          sendTheme();
          break;
        }
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });

    // Also respond to prefers-color-scheme changes if app relies on system theme
    const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const onMql = () => sendTheme();
    try { mql?.addEventListener('change', onMql); } catch {
      try { mql?.addListener(onMql); } catch {
        // Older WebViews may expose neither media-query listener API.
      }
    }

    return () => {
      try { observer.disconnect(); } catch {
        // Cleanup remains idempotent when the document is already gone.
      }
      try { mql?.removeEventListener('change', onMql); } catch {
        try { mql?.removeListener(onMql); } catch {
          // Older WebViews may expose neither media-query listener API.
        }
      }
    };
  }, [postToPromptDj]);

  // Watch main app font changes and forward to iframe
  useEffect(
    () => subscribePreference('app_font', () => postCurrentFont(postToPromptDj)),
    [postToPromptDj],
  );
};

export default usePromptDjAppearanceSync;
