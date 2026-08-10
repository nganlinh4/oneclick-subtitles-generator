/**
 * Utility functions for StandardSlider positioning based on Figma design
 * Handles positioning for the new Figma-based slider component
 */

/**
 * Calculate the correct position for a StandardSlider handle
 * For Figma design, handle positioning is simpler - direct percentage
 * @param {number} percentage - The percentage value (0-100)
 * @param {string} orientation - 'horizontal' or 'vertical'
 * @returns {string} - CSS percentage value for position
 */
export const calculateStandardSliderHandlePosition = (percentage, _orientation = 'horizontal') => {
  // Figma design uses direct percentage positioning
  return `${percentage}%`;
};

/**
 * Calculate the correct width/height for a StandardSlider active track
 * @param {number} percentage - The percentage value (0-100)
 * @param {string} orientation - 'horizontal' or 'vertical'
 * @returns {string} - CSS percentage value for width/height
 */
export const calculateStandardSliderActiveTrackSize = (percentage, _orientation = 'horizontal') => {
  // Figma design uses direct percentage for active track size
  return `${percentage}%`;
};

/**
 * Legacy function - Calculate the correct left position for a slider thumb accounting for container padding
 * @param {number} percentage - The percentage value (0-100)
 * @param {number} thumbWidth - Width of the thumb in pixels (default: 16)
 * @returns {string} - CSS calc() expression for the left position
 */
export const calculateThumbPosition = (percentage, thumbWidth = 16) => {
  const padding = thumbWidth / 2; // Half thumb width padding on each side
  // Map 0-100% to the available track space (container width - 2*padding)
  // Formula: padding + (percentage * (100% - 2*padding) / 100)
  return `calc(${padding}px + ${percentage}% * (100% - ${padding * 2}px) / 100%)`;
};

/**
 * Legacy function - Calculate the correct width for a slider fill accounting for container padding
 * @param {number} percentage - The percentage value (0-100)
 * @param {number} thumbWidth - Width of the thumb in pixels (default: 16)
 * @returns {string} - CSS calc() expression for the width
 */
export const calculateFillWidth = (percentage, thumbWidth = 16) => {
  const padding = thumbWidth / 2; // Half thumb width padding on each side
  // Fill width should be the distance from track start to thumb center
  // Track starts at padding (8px), thumb center is at calculateThumbPosition()
  // So fill width = thumb center position - track start position
  // = (padding + percentage * (100% - 2*padding) / 100) - padding
  // = percentage * (100% - 2*padding) / 100
  return `calc(${percentage}% * (100% - ${padding * 2}px) / 100%)`;
};

/**
 * Get the padding value for a given thumb width
 * @param {number} thumbWidth - Width of the thumb in pixels
 * @returns {number} - Padding value in pixels
 */
export const getSliderPadding = (thumbWidth = 16) => {
  return thumbWidth; // Full thumb width for complete coverage
};

/**
 * Calculate thumb position for 14px thumbs (advanced settings, speed control)
 * @param {number} percentage - The percentage value (0-100)
 * @returns {string} - CSS calc() expression for the left position
 */
export const calculateThumbPosition14px = (percentage) => {
  return calculateThumbPosition(percentage, 14);
};

/**
 * Calculate fill width for 14px thumbs (advanced settings, speed control)
 * @param {number} percentage - The percentage value (0-100)
 * @returns {string} - CSS calc() expression for the width
 */
export const calculateFillWidth14px = (percentage) => {
  return calculateFillWidth(percentage, 14);
};

/**
 * Convert value to percentage for StandardSlider
 * @param {number} value - Current value
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} - Percentage (0-100)
 */
export const valueToPercentage = (value, min = 0, max = 100) => {
  return ((value - min) / (max - min)) * 100;
};

/**
 * Convert percentage to value for StandardSlider
 * @param {number} percentage - Percentage (0-100)
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} - Calculated value
 */
export const percentageToValue = (percentage, min = 0, max = 100) => {
  return min + (percentage / 100) * (max - min);
};

/**
 * Get Figma-compatible slider dimensions based on size variant
 * @param {string} size - Size variant ('xsmall', 'small', 'medium', 'large')
 * @param {string} orientation - Orientation ('horizontal', 'vertical')
 * @returns {Object} - Dimensions object with width and height
 */
export const getStandardSliderDimensions = (size = 'xsmall', orientation = 'horizontal') => {
  const dimensions = {
    xsmall: { width: 354, height: 44 },
    small: { width: 400, height: 48 },
    medium: { width: 480, height: 52 },
    large: { width: 560, height: 56 }
  };

  const baseDimensions = dimensions[size] || dimensions.xsmall;

  if (orientation === 'vertical') {
    return {
      width: baseDimensions.height,
      height: baseDimensions.width
    };
  }

  return baseDimensions;
};
