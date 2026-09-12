/**
 * Universal slider drag handler to ensure smooth thumb movement
 * Adds/removes 'dragging' class to disable transitions during interaction
 * Updated to support both legacy custom-slider and new StandardSlider components
 */

// Initialize drag handlers for all sliders
export const initializeSliderDragHandlers = () => {
  // Handle all existing sliders (both legacy and new)
  document.querySelectorAll('.custom-slider-container, .standard-slider-container').forEach(addSliderDragHandler);

  // Handle dynamically added sliders using MutationObserver
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.removedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE || node.isConnected) return;
        const sliders = [...node.querySelectorAll('.custom-slider-container, .standard-slider-container')];
        if (node.matches('.custom-slider-container, .standard-slider-container')) sliders.unshift(node);
        sliders.forEach(slider => {
          slider._cleanupDragHandler?.();
          delete slider._cleanupDragHandler;
        });
      });
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if the added node is a slider container (legacy or new)
          if (node.classList && (
            node.classList.contains('custom-slider-container') ||
            node.classList.contains('standard-slider-container')
          )) {
            addSliderDragHandler(node);
          }
          // Check for slider containers within the added node
          if (node.querySelectorAll) {
            node.querySelectorAll('.custom-slider-container, .standard-slider-container').forEach(addSliderDragHandler);
          }
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  return observer;
};

// Add drag handler to a specific slider container (legacy or new)
const addSliderDragHandler = (sliderContainer) => {
  // Support both legacy and new slider input selectors
  const input = sliderContainer.querySelector('.custom-slider-input, .standard-slider-input');
  if (!input || input.hasAttribute('data-drag-handler-added')) return;

  // Mark as handled to avoid duplicate handlers
  input.setAttribute('data-drag-handler-added', 'true');

  const startDragging = () => {
    sliderContainer.classList.add('dragging');
  };

  const stopDragging = () => {
    sliderContainer.classList.remove('dragging');
  };
  
  // Mouse events
  input.addEventListener('mousedown', startDragging);
  
  // Touch events for mobile
  input.addEventListener('touchstart', startDragging);
  
  // Global mouse/touch end events to ensure dragging stops
  const handleGlobalEnd = () => {
    stopDragging();
  };
  
  document.addEventListener('mouseup', handleGlobalEnd);
  document.addEventListener('touchend', handleGlobalEnd);
  
  // Also stop on input change (when user releases)
  input.addEventListener('change', stopDragging);
  
  // Clean up function (store on element for potential cleanup)
  sliderContainer._cleanupDragHandler = () => {
    stopDragging();
    input.removeEventListener('mousedown', startDragging);
    input.removeEventListener('touchstart', startDragging);
    document.removeEventListener('mouseup', handleGlobalEnd);
    document.removeEventListener('touchend', handleGlobalEnd);
    input.removeEventListener('change', stopDragging);
    input.removeAttribute('data-drag-handler-added');
  };
};

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSliderDragHandlers);
} else {
  initializeSliderDragHandlers();
}
