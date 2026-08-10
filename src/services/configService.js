// Light-weight config/localStorage wrapper with typed helpers
import { DEFAULT_GEMINI_MODEL_ID, normalizeMediaModelId } from '../config/geminiModels';

export const getGeminiModel = () => normalizeMediaModelId(
  localStorage.getItem('gemini_model'),
  DEFAULT_GEMINI_MODEL_ID
);
export const setGeminiModel = (model) => {
  try {
    localStorage.setItem('gemini_model', normalizeMediaModelId(model, DEFAULT_GEMINI_MODEL_ID));
  } catch {
    // Settings persistence is best effort for compatibility callers.
  }
};

export const getMediaResolution = () => localStorage.getItem('media_resolution') || 'medium';
export const setMediaResolution = (res) => {
  try {
    localStorage.setItem('media_resolution', res);
  } catch {
    // Settings persistence is best effort for compatibility callers.
  }
};

export const getVideoProcessingFps = () => parseFloat(localStorage.getItem('video_processing_fps') || '1');
export const setVideoProcessingFps = (fps) => {
  try {
    localStorage.setItem('video_processing_fps', String(fps));
  } catch {
    // Settings persistence is best effort for compatibility callers.
  }
};

export const getCurrentVideoUrl = () => localStorage.getItem('current_video_url') || null;
export const setCurrentVideoUrl = (url) => {
  try {
    localStorage.setItem('current_video_url', url);
  } catch {
    // Settings persistence is best effort for compatibility callers.
  }
};

export const getCurrentFileCacheId = () => localStorage.getItem('current_file_cache_id') || null;
export const setCurrentFileCacheId = (id) => {
  try {
    localStorage.setItem('current_file_cache_id', id);
  } catch {
    // Settings persistence is best effort for compatibility callers.
  }
};
