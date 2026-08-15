import { fetchBrowserResource } from '../../platform/browserFetch';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import {
  blacklistKey,
  getAllKeys,
  getNextAvailableKey,
} from './keyManager';

const MAX_BROWSER_IMAGE_BASE64 = 24 * 1024 * 1024;

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

const browserGeminiFetch = async (requestForKey) => {
  const maximumAttempts = Math.max(1, getAllKeys().length);
  if (getAllKeys().length === 0) {
    throw new Error('No valid Gemini API key available. Add one in Settings > API Keys.');
  }
  let lastRateLimited = null;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const key = getNextAvailableKey();
    if (!key) break;
    const response = await requestForKey(key);
    if (response?.status !== 429) return response;
    blacklistKey(key);
    lastRateLimited = response;
  }
  if (lastRateLimited) return lastRateLimited;
  throw new Error('No valid Gemini API key available. Add one in Settings > API Keys.');
};

const providerError = async (response, operation) => {
  let message = `Failed to generate ${operation} (HTTP ${response?.status ?? 'unknown'})`;
  try {
    message = (await response.json())?.error?.message || message;
  } catch {
    // Keep the bounded HTTP fallback when the provider body is not JSON.
  }
  return new Error(message);
};

export const generateBrowserBackgroundPrompt = async ({ content, model }) => {
  const body = addThinkingConfig({
    contents: [{ role: 'user', parts: [{ text: content }] }],
  }, model);
  const response = await browserGeminiFetch((apiKey) => fetchBrowserResource(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  ));
  if (!response?.ok) throw await providerError(response, 'prompt');
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text?.trim();
  if (!text) throw new Error('No prompt returned from Gemini');
  return text;
};

export const generateBrowserBackgroundImage = async ({
  prompt,
  albumArtUrl,
  model,
  signal,
}) => {
  const { base64: base64Image, mimeType } = await prepareAlbumArt(albumArtUrl);
  const response = await browserGeminiFetch((apiKey) => fetchBrowserResource(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: base64Image } },
          ],
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  ));
  if (!response?.ok) throw await providerError(response, 'image');
  const data = await response.json();
  const inline = data?.candidates?.[0]?.content?.parts
    ?.find((part) => part?.inlineData?.data)?.inlineData;
  const mime = inline?.mimeType === 'image/jpg' ? 'image/jpeg' : inline?.mimeType;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)
      || typeof inline.data !== 'string'
      || inline.data.length === 0
      || inline.data.length > MAX_BROWSER_IMAGE_BASE64) {
    throw new Error('No image returned from Gemini');
  }
  return { data: inline.data, mime_type: mime };
};
