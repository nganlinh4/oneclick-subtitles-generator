/**
 * Frontend configuration
 */
import { DEFAULT_GEMINI_MODEL_ID } from './config/geminiModels';

// Compatibility-only exports for frozen call signatures. Native runtime I/O must use
// typed platform services; accidentally fetching either value fails closed.
const NATIVE_ONLY_ORIGIN = 'osg-native://unavailable';
export const API_BASE_URL = NATIVE_ONLY_ORIGIN;
export const SERVER_URL = NATIVE_ONLY_ORIGIN;

// Provider secrets are write-only inputs to the native vault and never frontend configuration.
export const GEMINI_API_KEY = '';

// Default Gemini model for transcription
export const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_MODEL_ID;
