/**
 * Global reset-on-hover handler for slider-with-value components.
 * - On hover of .slider-value-display, a reset icon button is shown above
 * - Clicking the reset icon resets the slider to its default value
 *
 * Default value resolution:
 * - If container (.slider-with-value) has data-default-value, use it
 * - Else, capture the current input value on first initialization and store it
 *
 * Works with both StandardSlider (.standard-slider-*) and legacy custom slider.
 */

const SELECTOR_CONTAINER = '.slider-with-value';
const SELECTOR_VALUE = '.slider-value-display';
const SELECTOR_INPUT = '.standard-slider-input, .custom-slider-input';
const SELECTOR_SLIDER_CONTAINER = '.standard-slider-container, .custom-slider-container';

function getGlobalDefaultById(inputEl, container, sliderContainer) {
  try {
    const id = (inputEl && inputEl.id) || (sliderContainer && sliderContainer.id) || (container && container.id);
    if (!id) return null;
    const registry = (window && window.SLIDER_DEFAULTS) || null;
    if (registry && Object.prototype.hasOwnProperty.call(registry, id)) {
      return registry[id];
    }
  } catch (_) { /* noop */ }
  return null;
}

function resolveDefault(container, inputEl, sliderContainer) {
  // Priority: explicit data attr on wrapper -> slider -> input -> global registry -> input.defaultValue -> current value
  const attrs = ['data-default-value', 'data-reset-value'];
  for (const attr of attrs) {
    const c = container.getAttribute(attr);
    if (c != null) return c;
  }
  if (sliderContainer) {
    for (const attr of attrs) {
      const s = sliderContainer.getAttribute(attr);
      if (s != null) return s;
    }
  }
  if (inputEl) {
    for (const attr of attrs) {
      const i = inputEl.getAttribute(attr);
      if (i != null) return i;
    }
  }
  const globalDefault = getGlobalDefaultById(inputEl, container, sliderContainer);
  if (globalDefault != null) return String(globalDefault);
  if (inputEl && inputEl.defaultValue != null && inputEl.defaultValue !== '') return String(inputEl.defaultValue);
  return inputEl ? String(inputEl.value) : null;
}

function addResetBehavior(container) {
  try {
    if (!container || container.getAttribute('data-reset-handler-added') === 'true') return;
    // If a React/Component wrapper is managing reset behavior, skip wiring
    if (container.getAttribute('data-reset-handler-managed') === 'true') {
      container.setAttribute('data-reset-handler-added', 'true');
      return;
    }

    const valueEl = container.querySelector(SELECTOR_VALUE);
    const inputEl = container.querySelector(SELECTOR_INPUT);
    const sliderContainer = container.querySelector(SELECTOR_SLIDER_CONTAINER);

    if (!valueEl || !inputEl || !sliderContainer) return;

    // Establish default value once (prefer explicit data attribute if provided)
    if (!container.dataset.defaultValue) {
      const initial = resolveDefault(container, inputEl, sliderContainer);
      if (initial != null) container.dataset.defaultValue = String(initial);
    }

    // Add an accessible tooltip if none exists
    if (!valueEl.getAttribute('title')) {
      valueEl.setAttribute('title', 'Reset to default');
    }

    // Click handler to reset
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      // Respect disabled state
      if (inputEl.disabled || sliderContainer.classList.contains('disabled')) return;

      const def = container.dataset.defaultValue;
      if (def == null) return;

      // Update the underlying input and dispatch events so React handlers run
      inputEl.value = def;
      const opts = { bubbles: true, cancelable: true };
      inputEl.dispatchEvent(new Event('input', opts));
      inputEl.dispatchEvent(new Event('change', opts));
    };

    // Ensure a real clickable reset button exists inside the value element
    let resetBtn = valueEl.querySelector('.slider-reset-btn');
    if (!resetBtn) {
      resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'slider-reset-btn';
      resetBtn.setAttribute('aria-label', 'Reset to default');
      resetBtn.setAttribute('title', 'Reset to default');
      resetBtn.textContent = '↺';
      valueEl.appendChild(resetBtn);
    }

    if (!resetBtn.getAttribute('data-reset-click-added')) {
      resetBtn.addEventListener('click', onClick);
      resetBtn.setAttribute('data-reset-click-added', 'true');
    }

    container.setAttribute('data-reset-handler-added', 'true');
  } catch (_) {
    // Fail silently to avoid impacting UX
  }
}

function initializeSliderResetHandlers() {
  // Initialize existing instances
  document.querySelectorAll(SELECTOR_CONTAINER).forEach(addResetBehavior);

  // Observe for dynamically added sliders
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches && node.matches(SELECTOR_CONTAINER)) {
          addResetBehavior(node);
        }
        if (node.querySelectorAll) {
          node.querySelectorAll(SELECTOR_CONTAINER).forEach(addResetBehavior);
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}

// Auto-initialize on load (same pattern as sliderDragHandler)
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSliderResetHandlers);
  } else {
    initializeSliderResetHandlers();
  }
}

