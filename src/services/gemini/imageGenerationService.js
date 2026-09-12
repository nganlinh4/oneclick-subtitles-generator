/**
 * Desktop background-image generation service
 * - Generates a prompt from lyrics using Gemini text model
 * - Imports album art as a bounded reference and returns a durable native image capability
 */

import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { generateNativeGeminiImage } from '../../platform/nativeGeminiImage';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import {
  DEFAULT_BACKGROUND_PROMPT_MODEL_ID,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  migrateGeminiModelId,
  normalizeImageGenerationModelId
} from '../../config/geminiModels';

const placeholder = (name) => `\${${name}}`;
const SONG_NAME_PLACEHOLDER = placeholder("songName || 'Unknown Song'");
const LYRICS_PLACEHOLDER = placeholder('lyrics');
const PROMPT_PLACEHOLDER = placeholder('prompt');
const MAX_GENERATED_PROMPT_LENGTH = 64 * 1024;

// Default templates (match BackgroundPromptEditor defaults).
const DEFAULT_PROMPT_ONE = `song title: ${SONG_NAME_PLACEHOLDER}

${LYRICS_PLACEHOLDER}

generate one prompt to put in a image generator to describe the atmosphere/object of this song, should be simple but abstract because I will use this image as youtube video background for a lyrics video, return the prompt only, no extra texts`;

const DEFAULT_PROMPT_TWO = `Expand the image into 16:9 ratio (landscape ratio). Then decorate my given image with ${PROMPT_PLACEHOLDER}`;

const renderTemplate = (template, vars = {}) => {
  let out = String(template);
  if (Object.prototype.hasOwnProperty.call(vars, 'songName')) {
    const sn = vars.songName || 'Unknown Song';
    out = out.split(SONG_NAME_PLACEHOLDER).join(sn);
  }
  if (Object.prototype.hasOwnProperty.call(vars, 'lyrics')) {
    out = out.split(LYRICS_PLACEHOLDER).join(vars.lyrics ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(vars, 'prompt')) {
    out = out.split(PROMPT_PLACEHOLDER).join(vars.prompt ?? '');
  }
  return out;
};

const promptResult = (text, delivery = null) => Object.freeze({
  text,
  delivery,
});

const normalizeGeneratedPrompt = (value) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > MAX_GENERATED_PROMPT_LENGTH) {
    throw new Error('No prompt returned from Gemini');
  }
  return text;
};

const nativePromptDelivery = (result) => {
  if (typeof result?.job?.id !== 'string'
      || typeof result?.deliveryId !== 'string'
      || typeof result?.acknowledge !== 'function') {
    throw new Error('The generated prompt has no durable delivery identity');
  }
  return Object.freeze({
    jobId: result.job.id,
    deliveryId: result.deliveryId,
    acknowledge: result.acknowledge,
  });
};

export async function generateBackgroundPrompt(
  lyrics,
  songName = 'Unknown Song',
  { projectId, expectedProjectStateVersion } = {},
) {
  if (!lyrics || !lyrics.trim()) throw new Error('Lyrics are required');

  const model = migrateGeminiModelId(
    localStorage.getItem('background_prompt_model'),
    DEFAULT_BACKGROUND_PROMPT_MODEL_ID
  );

  // Use user-customizable template from the Background Prompt Editor (localStorage),
  // falling back to the default template if not set.
  const template = localStorage.getItem('background_prompt_one') || DEFAULT_PROMPT_ONE;
  const content = renderTemplate(template, { lyrics, songName });

  if (!isDesktopRuntime()) throw new Error('Gemini image prompting requires the desktop runtime.');

  const thinking = getThinkingBudget(model);
  const result = await runNativeGeminiText({
    task: 'analyzeSubtitles',
    model,
    prompt: content,
    ...(projectId === undefined ? {} : { projectId }),
    ...(expectedProjectStateVersion === undefined ? {} : { expectedProjectStateVersion }),
    ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
  });
  return promptResult(normalizeGeneratedPrompt(result.text), nativePromptDelivery(result));
}

export async function generateBackgroundImage(prompt, albumArtUrl, { signal } = {}) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required');
  if (!albumArtUrl) throw new Error('Album art URL is required');

  const model = normalizeImageGenerationModelId(
    localStorage.getItem('background_image_model') || DEFAULT_IMAGE_GENERATION_MODEL_ID
  );

  // Use Prompt Two template to build the final instruction text that references ${prompt}
  const promptTemplate = localStorage.getItem('background_prompt_two') || DEFAULT_PROMPT_TWO;
  const finalPrompt = renderTemplate(promptTemplate, { prompt });

  if (!isDesktopRuntime()) throw new Error('Gemini image generation requires the desktop runtime.');
  const generated = await generateNativeGeminiImage({
    referencePlaybackUrl: albumArtUrl,
    prompt: finalPrompt,
    model,
    signal,
  });
  return generated.image;
}

