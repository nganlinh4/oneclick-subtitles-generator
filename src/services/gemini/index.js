/**
 * Native-only Gemini facade used by the desktop frontend.
 *
 * Provider URLs, provider credentials, uploads, SSE, and WebSockets are deliberately absent from
 * this graph. Browser-only inspection can render the UI, but invoking a Gemini operation fails at
 * the native adapter boundary.
 */
export {
  callGeminiApi,
  callGeminiApiWithFilesApi,
  callGeminiApiWithFilesApiForAnalysis,
  streamGeminiApiInline,
  streamGeminiApiWithFilesApi,
} from './core';
export {
  abortAllRequests,
  getProcessingForceStopped,
  setProcessingForceStopped,
} from './requestManagement';
export {
  DEFAULT_TRANSCRIPTION_PROMPT,
  PROMPT_PRESETS,
  getDefaultConsolidatePrompt,
  getDefaultSummarizePrompt,
  getDefaultTranslationPrompt,
  getUserPromptPresets,
  saveUserPromptPresets,
} from './promptManagement';
export { cancelTranslation, translateSubtitles } from './translation';
export { completeDocument, summarizeDocument } from './documentProcessingService';
