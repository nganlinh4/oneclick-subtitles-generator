/**
 * System detection utilities for theme and language
 * Provides cross-platform detection for Windows, macOS, and Linux
 */

/**
 * Detect system language preference
 * @returns {string} Language code ('en', 'vi', 'ko') or 'en' as fallback
 */
export const detectSystemLanguage = () => {
  try {
    // Get system language from browser
    const systemLanguage = navigator.language || navigator.userLanguage || 'en';
    const languageCode = systemLanguage.toLowerCase().split('-')[0]; // Extract language part (e.g., 'en' from 'en-US')
    
    // Supported languages in the app
    const supportedLanguages = ['en', 'vi', 'ko'];
    
    // Return the language if supported, otherwise default to English
    return supportedLanguages.includes(languageCode) ? languageCode : 'en';
  } catch (error) {
    console.warn('Error detecting system language:', error);
    return 'en'; // Fallback to English
  }
};

/**
 * Detect system theme preference
 * @returns {string} Theme ('dark' or 'light')
 */
export const detectSystemTheme = () => {
  try {
    // Check if the browser supports prefers-color-scheme
    if (window.matchMedia) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      return prefersDark ? 'dark' : 'light';
    }
    
    // Fallback to dark theme if media queries are not supported
    return 'dark';
  } catch (error) {
    console.warn('Error detecting system theme:', error);
    return 'dark'; // Fallback to dark theme
  }
};

/**
 * Get language with fallback chain: localStorage -> system detection -> English
 * @param {string} storageKey - localStorage key to check
 * @returns {string} Language code
 */
export const getLanguageWithFallback = (storageKey = 'preferred_language') => {
  try {
    // First try localStorage
    const savedLanguage = localStorage.getItem(storageKey);
    if (savedLanguage && ['en', 'vi', 'ko'].includes(savedLanguage)) {
      return savedLanguage;
    }
    
    // Then try system detection
    return detectSystemLanguage();
  } catch (error) {
    console.warn('Error getting language with fallback:', error);
    return 'en'; // Ultimate fallback
  }
};

/**
 * Get theme with fallback chain: localStorage -> system detection -> dark
 * @param {string} storageKey - localStorage key to check
 * @returns {string} Theme ('dark' or 'light')
 */
export const getThemeWithFallback = (storageKey = 'theme') => {
  try {
    // First try localStorage
    const savedTheme = localStorage.getItem(storageKey);
    if (savedTheme && ['dark', 'light'].includes(savedTheme)) {
      return savedTheme;
    }
    
    // Then try system detection
    return detectSystemTheme();
  } catch (error) {
    console.warn('Error getting theme with fallback:', error);
    return 'dark'; // Ultimate fallback
  }
};

/**
 * Set up system theme change listener
 * @param {Function} callback - Function to call when system theme changes
 * @returns {Function} Cleanup function to remove the listener
 */
export const setupSystemThemeListener = (callback) => {
  try {
    if (!window.matchMedia) {
      console.warn('matchMedia not supported, system theme changes will not be detected');
      return () => {}; // Return empty cleanup function
    }
    
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e) => {
      const newTheme = e.matches ? 'dark' : 'light';
      callback(newTheme);
    };
    
    mediaQuery.addEventListener('change', handleChange);
    
    // Return cleanup function
    return () => mediaQuery.removeEventListener('change', handleChange);
  } catch (error) {
    console.warn('Error setting up system theme listener:', error);
    return () => {}; // Return empty cleanup function
  }
};

/**
 * Detect if the current device is a mobile device
 * @returns {boolean} True if mobile device, false otherwise
 */
export const isMobileDevice = () => {
  try {
    // Check for touch capability
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    // Check screen width (typical mobile breakpoint)
    const isSmallScreen = window.innerWidth <= 768;

    // Check user agent for mobile keywords
    const userAgent = navigator.userAgent.toLowerCase();
    const isMobileUA = /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(userAgent);

    // Consider it mobile if it has touch capability AND (small screen OR mobile user agent)
    return hasTouch && (isSmallScreen || isMobileUA);
  } catch (error) {
    console.warn('Error detecting mobile device:', error);
    return false; // Default to desktop if detection fails
  }
};

/**
 * Initialize theme and language from system preferences
 * @returns {Object} Object with theme and language
 */
export const initializeSystemPreferences = () => {
  return {
    theme: getThemeWithFallback(),
    language: getLanguageWithFallback()
  };
};
