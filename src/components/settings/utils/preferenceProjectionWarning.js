const preferenceProjectionToastKey = 'settings-preference-projection-warning';

/** A durable preference was saved, but this WebView could not mirror every part of it. */
export const showPreferenceProjectionWarning = (t) => {
  window.addToast?.(
    t(
      'settings.projectionWarning',
      'The setting was saved, but this window could not fully apply it. Restart OSG if it still looks unchanged.',
    ),
    'warning',
    8000,
    preferenceProjectionToastKey,
  );
};

