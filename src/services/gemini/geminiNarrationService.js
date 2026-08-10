import {
  DEFAULT_LIVE_AUDIO_MODEL_ID,
  LIVE_AUDIO_MODELS,
} from '../../config/geminiModels';
import { GEMINI_LANGUAGE_CODES } from './constants/languageConstants';
import { GEMINI_VOICES } from './constants/voiceConstants';
import { getGeminiLanguageCode } from './utils/languageUtils';

const nativeNarrationRequired = () => {
  const error = new Error('Gemini narration requires the desktop runtime.');
  error.code = 'desktopRuntimeUnavailable';
  return error;
};

const rejectNativeNarration = () => Promise.reject(nativeNarrationRequired());

/**
 * Compatibility surface for the pre-rewrite narration hooks.
 *
 * The active desktop flow is owned by useNativeNarrationController and speechService. Keeping
 * fail-closed functions here lets the unchanged legacy hook graph render without bundling a
 * provider WebSocket client or accepting provider credentials in the WebView.
 */
export const generateGeminiNarration = rejectNativeNarration;
export const generateGeminiNarrations = rejectNativeNarration;
export const initializeClientPool = rejectNativeNarration;
export const getNextAvailableClient = rejectNativeNarration;
export const markClientAsNotBusy = () => false;
export const disconnectAllClients = async () => undefined;
export const cancelGeminiNarrations = () => false;

export const listGeminiModels = async () => LIVE_AUDIO_MODELS.map((model) => ({
  ...model,
  name: `models/${model.id}`,
}));

export const findSuitableAudioModel = async () => `models/${DEFAULT_LIVE_AUDIO_MODEL_ID}`;

export const checkGeminiAvailability = async () => ({
  available: false,
  error: nativeNarrationRequired().message,
  message: 'desktopRuntimeUnavailable',
});

export {
  GEMINI_LANGUAGE_CODES,
  GEMINI_VOICES,
  getGeminiLanguageCode,
};
