/**
 * Mobile zoom utilities
 * Provides functionality to set page zoom level for mobile devices
 */

import { isMobileDevice } from './systemDetection';

/**
 * Apply zoom level to the page using viewport meta tag (browser-like zoom)
 * @param {number} zoomLevel - Zoom level (e.g., 0.5 for 50% zoom)
 */
export const applyZoom = (zoomLevel) => {
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

    console.log(`Applied browser-like zoom level: ${zoomLevel} (initial-scale: ${initialScale})`);
  } catch (error) {
    console.warn('Error applying zoom:', error);
  }
};

/**
 * Remove zoom from the page (reset viewport to default)
 */
export const removeZoom = () => {
  try {
    const viewportMeta = document.querySelector('meta[name="viewport"]');

    if (viewportMeta) {
      // Reset to default viewport settings
      viewportMeta.setAttribute('content', 'width=device-width, initial-scale=1');
    }

    console.log('Removed zoom (reset viewport)');
  } catch (error) {
    console.warn('Error removing zoom:', error);
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
        console.log('Mobile zoom initialized');
      }, 100);
    } else {
      console.log('Desktop device detected, skipping mobile zoom');
    }
  } catch (error) {
    console.warn('Error initializing mobile zoom:', error);
  }
};

/**
 * Get current zoom level from viewport meta tag
 * @returns {number} Current zoom level (1.0 = 100%)
 */
export const getCurrentZoom = () => {
  try {
    const viewportMeta = document.querySelector('meta[name="viewport"]');

    if (viewportMeta) {
      const content = viewportMeta.getAttribute('content');
      if (content) {
        const initialScaleMatch = content.match(/initial-scale=([0-9.]+)/);
        if (initialScaleMatch) {
          return parseFloat(initialScaleMatch[1]);
        }
      }
    }

    return 1.0; // Default zoom level
  } catch (error) {
    console.warn('Error getting current zoom:', error);
    return 1.0;
  }
};