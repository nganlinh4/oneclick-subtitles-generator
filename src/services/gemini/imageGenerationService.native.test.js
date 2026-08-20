import { generateNativeGeminiImage } from '../../platform/nativeGeminiImage';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import {
  generateBackgroundImage,
  generateBackgroundPrompt,
} from './imageGenerationService';

vi.mock('../../platform/nativeGeminiImage', () => ({
  generateNativeGeminiImage: vi.fn(),
}));
vi.mock('../../platform/nativeGeminiText', () => ({
  runNativeGeminiText: vi.fn(),
}));

const generatedImage = Object.freeze({
  artifact: Object.freeze({
    artifactId: '01890f39-7b62-7c4e-8c9a-000000000308',
    projectId: '01890f39-7b62-7c4e-8c9a-000000000306',
    mimeType: 'image/png',
    sizeBytes: 4,
    createdAtMs: 1_700_000_000_000,
  }),
  playback: Object.freeze({
    id: '4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11',
    playbackUrl: `http://127.0.0.1:43210/asset/4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11?token=${'a'.repeat(64)}`,
    mimeType: 'image/png',
    byteLength: 4,
  }),
});
const referencePlaybackId = 'c89ea814-1749-4c3b-8507-4c457df2ef30';
const albumArt = `http://127.0.0.1:43210/asset/${referencePlaybackId}?token=${'b'.repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
  window.isTauri = true;
  localStorage.clear();
  localStorage.setItem('gemini_api_key', 'must-not-be-read-or-sent');
  runNativeGeminiText.mockResolvedValue({ text: '  cinematic night sky  ' });
  generateNativeGeminiImage.mockResolvedValue({
    image: generatedImage,
    job: { id: '01890f39-7b62-7c4e-8c9a-000000000304' },
  });
  global.fetch = vi.fn(() => {
    throw new Error('desktop image generation must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
  delete window.isTauri;
});

test('generates the background prompt through the vault-backed native text job', async () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  await expect(generateBackgroundPrompt('lyrics here', 'Song')).resolves.toBe('cinematic night sky');
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'analyzeSubtitles',
    model: 'gemini-3.5-flash-lite',
    prompt: expect.stringContaining('lyrics here'),
  }));
  expect(getItem).not.toHaveBeenCalledWith('gemini_api_key');
  getItem.mockRestore();
});

test('passes album art as an opaque native playback capability without preparing WebView bytes', async () => {
  const createElement = vi.spyOn(document, 'createElement');
  const result = await generateBackgroundImage('decorate this', albumArt);
  expect(result).toBe(generatedImage);
  expect(generateNativeGeminiImage).toHaveBeenCalledWith(expect.objectContaining({
    referencePlaybackUrl: albumArt,
    prompt: expect.stringContaining('decorate this'),
    model: 'gemini-3.1-flash-image',
  }));
  expect(generateNativeGeminiImage.mock.calls[0][0]).not.toHaveProperty('referenceBlob');
  expect(createElement).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(result))
    .not.toMatch(/(?:base64|data:image|"bytes")/i);
  createElement.mockRestore();
});

test('migrates a retired image model selection to the sole video-capable image model', async () => {
  localStorage.setItem('background_image_model', 'gemini-2.5-flash-image');

  await generateBackgroundImage('decorate this', albumArt);
  expect(generateNativeGeminiImage).toHaveBeenCalledWith(expect.objectContaining({
    model: 'gemini-3.1-flash-image',
  }));
});
