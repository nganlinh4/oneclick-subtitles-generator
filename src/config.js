/**
 * Frontend configuration
 */
import { DEFAULT_GEMINI_MODEL_ID } from './config/geminiModels';

// Unified port configuration - matches server/config.js
const BACKEND_PORT = 3031;

// API base URL for server requests - using IPv4 for better compatibility
export const API_BASE_URL = `http://127.0.0.1:${BACKEND_PORT}/api`;

// Server URL for direct server requests (without /api) - using IPv4 for better compatibility
export const SERVER_URL = `http://127.0.0.1:${BACKEND_PORT}`;

// Gemini API key for direct API calls
// This should be loaded from environment variables in production
export const GEMINI_API_KEY = localStorage.getItem('gemini_api_key') || '';

// Default Gemini model for transcription
export const DEFAULT_GEMINI_MODEL = DEFAULT_GEMINI_MODEL_ID;
