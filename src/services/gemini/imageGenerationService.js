/**
 * Client-side Background Image Generation Service (serverless)
 * - Generates a prompt from lyrics using Gemini text model
 * - Generates a background image conditioned on prompt + album art using Gemini image model
 */

// Utility: Convert Blob to base64 string (without data: prefix)
const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => {
    const result = reader.result;
    // result is a data URL: data:<mime>;base64,<data>
    const base64 = String(result).split(',')[1] || '';
    resolve(base64);
  };
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

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

const getApiKey = () => {
  return localStorage.getItem('gemini_api_key') || localStorage.getItem('gemini_token') || '';
};

// Default templates (match BackgroundPromptEditor defaults) using raw strings to preserve ${...}
const DEFAULT_PROMPT_ONE = 'song title: ${songName || \'Unknown Song\'}\n\n${lyrics}\n\n' +
  'generate one prompt to put in a image generator to describe the atmosphere/object of this song, ' +
  'should be simple but abstract because I will use this image as youtube video background for a lyrics video, ' +
  'return the prompt only, no extra texts';

const DEFAULT_PROMPT_TWO = 'Expand the image into 16:9 ratio (landscape ratio). Then decorate my given image with ${prompt}';

const renderTemplate = (template, vars = {}) => {
  let out = String(template);
  if (Object.prototype.hasOwnProperty.call(vars, 'songName')) {
    const sn = vars.songName || 'Unknown Song';
    out = out.split("${songName || 'Unknown Song'}").join(sn);
  }
  if (Object.prototype.hasOwnProperty.call(vars, 'lyrics')) {
    out = out.split('${lyrics}').join(vars.lyrics ?? '');
  }
  if (Object.prototype.hasOwnProperty.call(vars, 'prompt')) {
    out = out.split('${prompt}').join(vars.prompt ?? '');
  }
  return out;
};

export async function generateBackgroundPrompt(lyrics, songName = 'Unknown Song') {
  if (!lyrics || !lyrics.trim()) throw new Error('Lyrics are required');

  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Gemini API key not set. Please set it in settings.');

  const model = localStorage.getItem('background_prompt_model') || 'gemini-2.5-flash-lite';

  // Use user-customizable template from the Background Prompt Editor (localStorage),
  // falling back to the default template if not set.
  const template = localStorage.getItem('background_prompt_one') || DEFAULT_PROMPT_ONE;
  const content = renderTemplate(template, { lyrics, songName });

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: content }]
      }
    ],
    generationConfig: {
      topK: 32,
      topP: 0.95,
      maxOutputTokens: 8192
    }
  };

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
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

  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Gemini API key not set. Please set it in settings.');

  const model = localStorage.getItem('background_image_model') || 'gemini-2.0-flash-preview-image-generation';

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

  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
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

