import { getEngineDescriptor } from '../services/engines/transcriptionEngineRegistry';

const TRANSCRIBE_WINDOW_KEY = 'video_processing_transcribe_window_seconds';
const TRANSCRIBE_LANGUAGES_KEY = 'video_processing_transcribe_language_hints';
const TRANSCRIBE_DIARIZATION_KEY = 'video_processing_transcribe_diarization';

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};

export const readProcessingMethod = () => {
  const saved = localStorage.getItem('video_processing_method');
  return saved && getEngineDescriptor(saved) ? saved : 'new';
};

export const writeProcessingMethod = (method) => {
  const validated = getEngineDescriptor(method) ? method : 'new';
  localStorage.setItem('video_processing_method', validated);
  return validated;
};

export const readTranscribeOptions = () => {
  let languageHints = [];
  try {
    const saved = JSON.parse(localStorage.getItem(TRANSCRIBE_LANGUAGES_KEY) || '[]');
    if (Array.isArray(saved)) {
      languageHints = saved.filter((value) => typeof value === 'string' && value.trim()).slice(0, 8);
    }
  } catch {
    // A damaged preference must restore safe defaults rather than break the modal.
  }
  return {
    windowDurationSecs: boundedInteger(localStorage.getItem(TRANSCRIBE_WINDOW_KEY), 600, 60, 600),
    languageHints,
    diarization: localStorage.getItem(TRANSCRIBE_DIARIZATION_KEY) === 'true',
  };
};

export const writeTranscribeOptions = (options) => {
  const normalized = {
    windowDurationSecs: boundedInteger(options?.windowDurationSecs, 600, 60, 600),
    languageHints: Array.isArray(options?.languageHints)
      ? options.languageHints.filter((value) => typeof value === 'string' && value.trim()).slice(0, 8)
      : [],
    diarization: options?.diarization === true,
  };
  localStorage.setItem(TRANSCRIBE_WINDOW_KEY, String(normalized.windowDurationSecs));
  localStorage.setItem(TRANSCRIBE_LANGUAGES_KEY, JSON.stringify(normalized.languageHints));
  localStorage.setItem(TRANSCRIBE_DIARIZATION_KEY, String(normalized.diarization));
  return normalized;
};
