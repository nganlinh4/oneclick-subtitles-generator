// Per-device choices of the translation and background-image generators.
import { bool, int, text } from './codecs';

export const GENERATION_KEYS = Object.freeze({
  // Model ids are migrated by their readers, which know each task's catalog and default.
  translation_model: text('', { maxLength: 256 }),
  custom_prompt_translation: text(''),
  translation_split_duration: int(0, { min: 0, max: 24 * 60 }),
  translation_rest_time: int(0, { min: 0, max: 24 * 60 * 60 }),
  translation_include_rules: bool(false),
  // The serialized chain; its reader validates the structure.
  language_chain_items: text(''),
  background_prompt_one: text(''),
  background_prompt_two: text(''),
  background_prompt_model: text('', { maxLength: 256 }),
  background_image_model: text('', { maxLength: 256 }),
});
