/**
 * Client-side Background Image Generation Service (serverless)
 * - Generates a prompt from lyrics using Gemini text model
 * - Generates a background image conditioned on prompt + album art using Gemini image model
 */

// Convert Blob to base64 string (without data: prefix) — shared helper.
import { toBase64 as blobToBase64 } from '../../utils/fileUtils';
// Route Gemini calls through the shared key-rotation wrapper (auto switch-on-429).
import { fetchWithKeyRotation } from './withKeyRotation';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import {
  DEFAULT_BACKGROUND_PROMPT_MODEL_ID,
  DEFAULT_IMAGE_GENERATION_MODEL_ID,
  migrateGeminiModelId,
  normalizeImageGenerationModelId
} from '../../config/geminiModels';

// Load an image blob and return a resized JPEG base64 (to keep payloads small and consistent)
const resizeImageBlobToJpegBase64 = async (blob, maxDim = 1024, quality = 0.92) => {
  try {
    // Prefer createImageBitmap for speed if available
    const bitmap = await createImageBitmap(blob).catch(() => null);

    const imgElementToCanvas = async () => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      // Allow CORS if server permits; otherwise canvas will be tainted and toDataURL will fail
      img.crossOrigin = 'anonymous';
      img.src = URL.createObjectURL(blob);
    });

    const source = bitmap || await imgElementToCanvas();
    const srcW = source.width;
    const srcH = source.height;
    if (!srcW || !srcH) throw new Error('Invalid album art image');

    let targetW = srcW;
    let targetH = srcH;
    if (Math.max(srcW, srcH) > maxDim) {
      if (srcW >= srcH) {
        targetW = maxDim;
        targetH = Math.round((srcH / srcW) * maxDim);
      } else {
        targetH = maxDim;
        targetW = Math.round((srcW / srcH) * maxDim);
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(source, 0, 0, targetW, targetH);

    // Use JPEG to improve compatibility and reduce size
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.split(',')[1] || '';
    return { base64, mimeType: 'image/jpeg' };
  } catch (e) {
    // Fallback: return original blob as base64
    const base64 = await blobToBase64(blob);
    return { base64, mimeType: blob.type || 'image/png' };
  }
};

// Normalize album art input (data URL or remote URL) into { base64, mimeType }
const prepareAlbumArt = async (albumArtUrl) => {
  if (albumArtUrl.startsWith('data:')) {
    const [meta, data] = albumArtUrl.split(',');
    const mimeType = (meta.split(';')[0] || '').split(':')[1] || 'image/png';
    return { base64: data || '', mimeType };
  }

  // Try to fetch the image bytes (will require the source to allow CORS)
  const resp = await fetch(albumArtUrl, { mode: 'cors', referrerPolicy: 'no-referrer' }).catch(() => null);
  if (!resp || !resp.ok) {
    throw new Error('Unable to fetch album art due to CORS or network restrictions. Please upload the image or use a same-origin URL.');
  }
  const blob = await resp.blob();
  // Resize/compress to a sane size to avoid payload limits
  return await resizeImageBlobToJpegBase64(blob);
};

const placeholder = (name) => '$' + '{' + name + '}';
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

  let body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: content }]
      }
    ]
  };
  body = addThinkingConfig(body, model);

  const resp = await fetchWithKeyRotation((apiKey) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
  );

  if (!resp.ok) {
    let msg = `Failed to generate prompt (HTTP ${resp.status})`;
    try { const err = await resp.json(); msg = err?.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.find(p => p.text)?.text?.trim();
  if (!text) throw new Error('No prompt returned from Gemini');
  return text;
}

export async function generateBackgroundImage(prompt, albumArtUrl) {
  if (!prompt || !prompt.trim()) throw new Error('Prompt is required');
  if (!albumArtUrl) throw new Error('Album art URL is required');

  const model = normalizeImageGenerationModelId(
    localStorage.getItem('background_image_model') || DEFAULT_IMAGE_GENERATION_MODEL_ID
  );

  // Prepare inline image data from album art (handles data URL, CORS fetch, resize/compress)
  const { base64: base64Image, mimeType } = await prepareAlbumArt(albumArtUrl);

  // Use Prompt Two template to build the final instruction text that references ${prompt}
  const promptTemplate = localStorage.getItem('background_prompt_two') || DEFAULT_PROMPT_TWO;
  const finalPrompt = renderTemplate(promptTemplate, { prompt });

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: finalPrompt },
          { inlineData: { mimeType, data: base64Image } }
        ]
      }
    ],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE']
    }
  };

  const resp = await fetchWithKeyRotation((apiKey) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    )
  );

  if (!resp.ok) {
    let msg = `Failed to generate image (HTTP ${resp.status})`;
    try { const err = await resp.json(); msg = err?.error?.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await resp.json();
  // Find first inlineData part in the response
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData && p.inlineData.data);
  if (!imagePart) throw new Error('No image returned from Gemini');

  return {
    data: imagePart.inlineData.data,
    mime_type: imagePart.inlineData.mimeType || 'image/png'
  };
}

