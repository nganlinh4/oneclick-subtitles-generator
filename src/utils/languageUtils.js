/**
 * Utility functions for language handling
 */

/**
 * Map of language names to ISO language codes
 */
const LANGUAGE_CODES = {
  // Common languages
  'english': 'en',
  'spanish': 'es',
  'french': 'fr',
  'german': 'de',
  'italian': 'it',
  'portuguese': 'pt',
  'russian': 'ru',
  'japanese': 'ja',
  'korean': 'ko',
  'chinese': 'zh',
  'vietnamese': 'vi',
  'thai': 'th',
  'arabic': 'ar',
  'hindi': 'hi',
  'bengali': 'bn',
  'turkish': 'tr',
  'dutch': 'nl',
  'swedish': 'sv',
  'polish': 'pl',
  'indonesian': 'id',
  'malay': 'ms',
  'greek': 'el',
  'hebrew': 'he',
  
  // Include the codes themselves for direct use
  'en': 'en',
  'es': 'es',
  'fr': 'fr',
  'de': 'de',
  'it': 'it',
  'pt': 'pt',
  'ru': 'ru',
  'ja': 'ja',
  'ko': 'ko',
  'zh': 'zh',
  'vi': 'vi',
  'th': 'th',
  'ar': 'ar',
  'hi': 'hi',
  'bn': 'bn',
  'tr': 'tr',
  'nl': 'nl',
  'sv': 'sv',
  'pl': 'pl',
  'id': 'id',
  'ms': 'ms',
  'el': 'el',
  'he': 'he'
};

/**
 * Get the ISO language code for a given language name
 * @param {string} language - The language name (e.g., "English", "Spanish")
 * @returns {string} - The ISO language code (e.g., "en", "es")
 */
export const getLanguageCode = (language) => {
  if (!language) return 'en'; // Default to English if no language provided
  
  // Convert to lowercase for case-insensitive matching
  const normalizedLanguage = language.toLowerCase();
  
  // Return the code if it exists in our map
  if (LANGUAGE_CODES[normalizedLanguage]) {
    return LANGUAGE_CODES[normalizedLanguage];
  }
  
  // For languages not in our map, try to extract the first two characters
  // if they look like a language code (e.g., "en-US" -> "en")
  if (normalizedLanguage.length >= 2 && normalizedLanguage.indexOf('-') === 2) {
    return normalizedLanguage.substring(0, 2);
  }
  
  // If all else fails, return the original string
  return normalizedLanguage;
};

/**
 * Get the language name for a given ISO language code
 * @param {string} code - The ISO language code (e.g., "en", "es")
 * @returns {string} - The language name (e.g., "English", "Spanish")
 */
export const getLanguageName = (code) => {
  if (!code) return 'English'; // Default to English if no code provided
  
  // Convert to lowercase for case-insensitive matching
  const normalizedCode = code.toLowerCase();
  
  // Map of ISO language codes to language names
  const LANGUAGE_NAMES = {
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'de': 'German',
    'it': 'Italian',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh': 'Chinese',
    'vi': 'Vietnamese',
    'th': 'Thai',
    'ar': 'Arabic',
    'hi': 'Hindi',
    'bn': 'Bengali',
    'tr': 'Turkish',
    'nl': 'Dutch',
    'sv': 'Swedish',
    'pl': 'Polish',
    'id': 'Indonesian',
    'ms': 'Malay',
    'el': 'Greek',
    'he': 'Hebrew'
  };
  
  // Return the name if it exists in our map
  if (LANGUAGE_NAMES[normalizedCode]) {
    return LANGUAGE_NAMES[normalizedCode];
  }

  // If the code is not in our map, return the code itself
  return code;
};

/**
 * The common languages offered in selection UIs (e.g. the ASR force-language picker), as
 * ISO 639-1 code + display name. Reuses getLanguageName so names stay in one place.
 * @returns {{code:string,name:string}[]}
 */
const COMMON_LANGUAGE_CODES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'ja', 'ko', 'zh', 'vi', 'th',
  'ar', 'hi', 'bn', 'tr', 'nl', 'sv', 'pl', 'id', 'ms', 'el', 'he',
];
export const getLanguageOptions = () =>
  COMMON_LANGUAGE_CODES.map((code) => ({ code, name: getLanguageName(code) }));
