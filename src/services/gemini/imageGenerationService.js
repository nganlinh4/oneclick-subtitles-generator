/**
 * Client-side Background Image Generation Service (serverless)
 * - Generates a prompt from lyrics using Gemini text model
 * - Generates a background image conditioned on prompt + album art using Gemini image model
 */

// Convert Blob to base64 string (without data: prefix) — shared helper.
import { toBase64 as blobToBase64 } from '../../utils/fileUtils';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { generateNativeGeminiImage } from '../../platform/nativeGeminiImage';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import {
  DEFAULT_BACKGROUND_PROMPT_MODEL_ID,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  migrateGeminiModelId,
  normalizeImageGenerationModelId
} from '../../config/geminiModels';

// Normalize album art input (data URL or remote URL) into { base64, mimeType }
const prepareAlbumArt = async (albumArtUrl) => {
  if (albumArtUrl.startsWith('data:')) {
    const [meta, data] = albumArtUrl.split(',');
    const mimeType = (meta.split(';')[0] || '').split(':')[1] || 'image/png';
    return { base64: data || '', mimeType };
  }

  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = 'anonymous';
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Unable to load the album art image.'));
    element.src = albumArtUrl;
  });
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to prepare the album art image.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  return { base64: dataUrl.split(',')[1] || '', mimeType: 'image/jpeg' };
};

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

export async function generateBackgroundImage(prompt, albumArtUrl) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required');
  if (!albumArtUrl) throw new Error('Album art URL is required');

  const model = normalizeImageGenerationModelId(
    localStorage.getItem('background_image_model') || DEFAULT_IMAGE_GENERATION_MODEL_ID
  );

  // Prepare image data without any provider request from the WebView.
  const { base64: base64Image, mimeType } = await prepareAlbumArt(albumArtUrl);

  // Use Prompt Two template to build the final instruction text that references ${prompt}
  const promptTemplate = localStorage.getItem('background_prompt_two') || DEFAULT_PROMPT_TWO;
  const finalPrompt = renderTemplate(promptTemplate, { prompt });

  let binary;
  try {
    binary = atob(base64Image);
  } catch {
    throw new Error('The album art image data is invalid');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const generated = await generateNativeGeminiImage({
    referenceBlob: new Blob([bytes], { type: mimeType }),
    prompt: finalPrompt,
    model,
  });
  return {
    data: await blobToBase64(new Blob([generated.bytes], { type: generated.mimeType })),
    mime_type: generated.mimeType,
  };
}

