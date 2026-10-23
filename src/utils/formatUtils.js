/**
 * Utility functions for formatting values
 */

/**
 * Format decimal numbers to avoid floating-point precision issues
 * @param {number} value - The number to format
 * @param {number} decimals - Number of decimal places (default: 1)
 * @returns {number} - Properly formatted number
 */
export const formatDecimal = (value, decimals = 1) => {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  return parseFloat(value.toFixed(decimals));
};
