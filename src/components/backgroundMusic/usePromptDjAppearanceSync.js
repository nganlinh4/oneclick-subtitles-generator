/**
 * Forwards the main app's theme and font to the embedded PromptDJ frame, now and on every change
 * (the `data-theme` attribute, the system color scheme, and the `app_font` storage key).
 */
import { useEffect } from 'react';

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
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'app_font') {
        const font = e.newValue || 'google-sans';
        postToPromptDj({ type: 'pm-dj-set-font', font });
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [postToPromptDj]);
};

export default usePromptDjAppearanceSync;
