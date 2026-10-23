/**
 * Mobile zoom utilities
 * Provides functionality to set page zoom level for mobile devices
 */

import { isMobileDevice } from './systemDetection';

/**
 * Apply zoom level to the page using viewport meta tag (browser-like zoom)
 * @param {number} zoomLevel - Zoom level (e.g., 0.5 for 50% zoom)
 */
const applyZoom = (zoomLevel) => {
  try {
    // Find or create viewport meta tag
    let viewportMeta = document.querySelector('meta[name="viewport"]');

    if (!viewportMeta) {
      viewportMeta = document.createElement('meta');
      viewportMeta.name = 'viewport';
      document.head.appendChild(viewportMeta);
    }

    // Calculate the initial scale based on zoom level
    // zoomLevel of 0.5 means 50% zoom, so initial-scale should be 0.5
    const initialScale = zoomLevel;

    // Update viewport content to include the zoom level
    const currentContent = viewportMeta.getAttribute('content') || 'width=device-width, initial-scale=1';
    const contentParts = currentContent.split(',').map(part => part.trim());

    // Remove any existing initial-scale
    const filteredParts = contentParts.filter(part => !part.startsWith('initial-scale'));

    // Add the new initial-scale
    filteredParts.push(`initial-scale=${initialScale}`);

    // Update the meta tag
    viewportMeta.setAttribute('content', filteredParts.join(', '));

  } catch (error) {
    console.warn('Error applying zoom:', error);
  }
};

/**
 * Initialize mobile zoom if device is mobile
 * @param {number} zoomLevel - Zoom level for mobile devices (default: 0.5)
 */
export const initializeMobileZoom = (zoomLevel = 0.5) => {
  try {
    if (isMobileDevice()) {
      // Small delay to ensure DOM is ready
      setTimeout(() => {
        applyZoom(zoomLevel);
      }, 100);
    }
  } catch (error) {
    console.warn('Error initializing mobile zoom:', error);
  }
};
