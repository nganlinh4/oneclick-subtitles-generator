// Per-device choices of the video processing modal and the automatic generation that mirrors it.
import { DEFAULT_TRANSCRIPTION_MODEL_ID } from '../../config/geminiModels';
import { bool, int, json, num, oneOf, text } from './codecs';
import { mediaModel } from './modelCodec';

export const PROCESSING_KEYS = Object.freeze({
  video_processing_method: text('new', { maxLength: 128, allowEmpty: false }),
  has_seen_transcription_method_selection: bool(false),
  video_processing_audio_only: bool(false),
  video_processing_fps: num(0.25, { min: 0.25, max: 5 }),
  video_processing_media_resolution: oneOf(['low', 'medium'], 'low'),
  video_processing_model: mediaModel(() => DEFAULT_TRANSCRIPTION_MODEL_ID),
  video_processing_prompt_preset: text('settings', { maxLength: 256, allowEmpty: false }),
  video_processing_custom_language: text('', { maxLength: 10_000 }),
  video_processing_use_transcription_rules: bool(false),
  video_processing_use_outside_context: bool(true),
  // 1-20 subtitles of context on each side; 21 means unlimited.
  video_processing_outside_context_range: int(5, { min: 1, max: 21 }),
  video_processing_max_duration: int(10, { min: 1, max: 20 }),
  segment_processing_delay: int(0, { min: 0, max: 60 }),
  user_prompt_presets: json(() => [], Array.isArray),
  video_processing_transcribe_window_seconds: int(600, { min: 60, max: 600 }),
  video_processing_transcribe_language_hints: json(() => [], Array.isArray),
  video_processing_transcribe_diarization: bool(false),
});

// Local ASR segmentation options, one set per engine: `asr_<engineId>_<option>`. Parakeet's older
// `parakeet_<option>` keys are read as a one-way seed by the options hook.
export const ASR_OPTION_CODECS = Object.freeze({
  segment_strategy: text('', { maxLength: 64 }),
  max_chars: int(60, { min: 5, max: 100 }),
  max_words: int(7, { min: 1, max: 50 }),
  preserve_sentences: bool(false),
  max_duration_per_request: int(3, { min: 1, max: 10 }),
  language: text('auto', { maxLength: 32, allowEmpty: false }),
});
