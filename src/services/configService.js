// Light-weight config/localStorage wrapper with typed helpers

export const getMediaResolution = () => localStorage.getItem('media_resolution') || 'medium';

export const getVideoProcessingFps = () => parseFloat(localStorage.getItem('video_processing_fps') || '1');
