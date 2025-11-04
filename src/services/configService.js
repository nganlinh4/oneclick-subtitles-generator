// Light-weight config/localStorage wrapper with typed helpers

export const getGeminiModel = () => localStorage.getItem('gemini_model') || 'gemini-2.0-flash';
export const setGeminiModel = (model) => { try { localStorage.setItem('gemini_model', model); } catch {} };

export const getMediaResolution = () => localStorage.getItem('media_resolution') || 'medium';
export const setMediaResolution = (res) => { try { localStorage.setItem('media_resolution', res); } catch {} };

export const getVideoProcessingFps = () => parseFloat(localStorage.getItem('video_processing_fps') || '1');
export const setVideoProcessingFps = (fps) => { try { localStorage.setItem('video_processing_fps', String(fps)); } catch {} };

export const getCurrentVideoUrl = () => localStorage.getItem('current_video_url') || null;
export const setCurrentVideoUrl = (url) => { try { localStorage.setItem('current_video_url', url); } catch {} };

export const getCurrentFileCacheId = () => localStorage.getItem('current_file_cache_id') || null;
export const setCurrentFileCacheId = (id) => { try { localStorage.setItem('current_file_cache_id', id); } catch {} };
