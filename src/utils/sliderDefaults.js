// Central registry for slider factory defaults
// - Keys must match the DOM id of the slider input/container (we use component id prop)
// - Values are the default numeric value for the slider
//
// Usage:
//   1) Ensure components pass a stable id prop to SliderWithValue/StandardSlider
//   2) SliderWithValue and the global reset handler will use these defaults
//
(function initSliderDefaults(){
  if (typeof window === 'undefined') return;
  const registry = {
    // Translation sliders
    'split-duration-slider': 0,
    'rest-time-slider': 0,

    // Video processing modal sliders
    'fps-slider': 0.25,
    'max-duration-slider': 10,
    'outside-context-range': 5,
    'max-words-slider': 12,

    // Download options modal
    'consolidation-split-duration-slider': 0,

    // Narration / Chatterbox sliders
    'chatterbox-exaggeration': 1.0,
    'chatterbox-cfg-weight': 0.5,

    // Narration Advanced Settings
    'speechRate': 1.3,
    'cfgStrength': 2.0,
    'swayCoef': -1.0,

    // Edge TTS Controls
    'edge-tts-rate': 0,
    'edge-tts-volume': 0,
    'edge-tts-pitch': 0,

    // Concurrent clients
    'gemini-concurrent-clients': 5,
    'concurrent-clients-slider': 5,

    // Speed controls
    'gemini-speed-control': 1.0,
    'narration-speed-control': 1.0,

    // Settings tab
    'favorite-max-subtitle-length': 12,
    'thinking-budget-pro': 0,
    'thinking-budget-flash': 0,
    'thinking-budget-lite': 0,

    // Subtitle settings defaults
    'font-size': 24,
    'line-spacing': 1.4,
    'letter-spacing': 0,
    'position': 90,
    'box-width': 80,
    'background-radius': 4,
    'background-padding': 10,
    'opacity': 0.7,

    // Narration menu volumes
    'narration-volume': 1,
    'video-volume': 1,

    // Add more ids below as needed
  };

  // Merge instead of overwrite to allow overrides defined elsewhere
  window.SLIDER_DEFAULTS = Object.assign({}, window.SLIDER_DEFAULTS || {}, registry);
})();

