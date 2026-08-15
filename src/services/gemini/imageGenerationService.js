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

export async function generateBackgroundPrompt(lyrics, songName = 'Unknown Song') {
  if (!lyrics || !lyrics.trim()) throw new Error('Lyrics are required');

  const model = migrateGeminiModelId(
    localStorage.getItem('background_prompt_model'),
    DEFAULT_BACKGROUND_PROMPT_MODEL_ID
  );

  // Use user-customizable template from the Background Prompt Editor (localStorage),
  // falling back to the default template if not set.
  const template = localStorage.getItem('background_prompt_one') || DEFAULT_PROMPT_ONE;
  const content = renderTemplate(template, { lyrics, songName });

  if (!isDesktopRuntime()) {
    const { generateBrowserBackgroundPrompt } = await import('./imageGenerationBrowserService');
    return generateBrowserBackgroundPrompt({ content, model });
  }

  const thinking = getThinkingBudget(model);
  const result = await runNativeGeminiText({
    task: 'analyzeSubtitles',
    model,
    prompt: content,
    ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
  });
  const text = result.text?.trim();
  if (!text) throw new Error('No prompt returned from Gemini');
  return text;
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

  if (isDesktopRuntime()) {
    const generated = await generateNativeGeminiImage({
      referencePlaybackUrl: albumArtUrl,
      prompt: finalPrompt,
      model,
      signal,
    });
    return generated.image;
  }

  // Browser compatibility stays in a separate lazy module. The production desktop fold removes
  // this import and its inline-image/provider implementation from the emitted WebView graph.
  const { generateBrowserBackgroundImage } = await import('./imageGenerationBrowserService');
  return generateBrowserBackgroundImage({
    prompt: finalPrompt,
    albumArtUrl,
    model,
    signal,
  });
}

