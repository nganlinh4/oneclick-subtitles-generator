// Per-device narration choices: the engine and each engine's voice and tuning.
import { bool, int, json, num, oneOf, text } from './codecs';

export const NARRATION_METHODS = Object.freeze(['f5tts', 'chatterbox', 'gemini', 'edge-tts', 'gtts']);

const isPlainObject = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const DEFAULT_ADVANCED_SETTINGS = Object.freeze({
  speechRate: 1.1,
  // Generation quality: diffusion steps, sway sampling and classifier-free guidance.
  nfeStep: '32',
  swayCoef: -1.0,
  cfgStrength: 2.0,
  useRandomSeed: true,
  seed: 42,
  removeSilence: true,
  sampleRate: '44100',
  audioFormat: 'wav',
  batchSize: '8',
  mergeOutput: false,
});

const voice = (fallback) => text(fallback, { maxLength: 256, allowEmpty: false });

export const NARRATION_KEYS = Object.freeze({
  narration_method: oneOf(NARRATION_METHODS, 'gemini'),
  gemini_voice: voice('Aoede'),
  gemini_concurrent_clients: int(5, { min: 1, max: 10 }),
  chatterbox_exaggeration: num(0.7, { min: 0.25, max: 2 }),
  chatterbox_cfg_weight: num(0.3, { min: 0, max: 1 }),
  chatterbox_language: voice('en'),
  edge_tts_voice: voice('en-US-AriaNeural'),
  edge_tts_rate: voice('+0%'),
  edge_tts_volume: voice('+0%'),
  edge_tts_pitch: voice('+0Hz'),
  gtts_language: voice('en'),
  gtts_tld: voice('com'),
  gtts_slow: bool(false),
  // Empty means no model was chosen yet.
  last_used_narration_model: text('', { maxLength: 256 }),
  grouping_intensity: voice('moderate'),
  narration_advanced_settings: json(() => ({ ...DEFAULT_ADVANCED_SETTINGS }), isPlainObject),
  detected_language: json(() => null, (value) => value === null || isPlainObject(value)),
  recentlyChosenLanguages: json(() => [], Array.isArray),
});
