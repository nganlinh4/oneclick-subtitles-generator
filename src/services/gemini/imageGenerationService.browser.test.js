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

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  delete window.isTauri;
  localStorage.clear();
  localStorage.setItem('gemini_api_keys', JSON.stringify(['browser-key-1', 'browser-key-2']));
});

afterAll(() => {
  delete global.fetch;
});

test('browser prompt generation uses the browser provider and never invokes native Gemini', async () => {
  global.fetch = vi.fn().mockResolvedValue(response({
    candidates: [{ content: { parts: [{ text: '  browser prompt  ' }] } }],
  }));

  await expect(generateBackgroundPrompt('browser lyrics', 'Browser Song'))
    .resolves.toEqual({ text: 'browser prompt', delivery: null });
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining('key=browser-key-1'),
    expect.objectContaining({ method: 'POST' })
  );
  expect(runNativeGeminiText).not.toHaveBeenCalled();
  expect(generateNativeGeminiImage).not.toHaveBeenCalled();
});

test('browser image generation rotates only on 429 and returns browser bytes without native IPC', async () => {
  global.fetch = vi.fn()
    .mockResolvedValueOnce(response({ error: { message: 'quota' } }, 429))
    .mockResolvedValueOnce(response({
      candidates: [{
        content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'cG5nLWJ5dGVz' } }] },
      }],
    }));
  const albumArt = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\ncover')}`;

  await expect(generateBackgroundImage('browser image', albumArt)).resolves.toEqual({
    data: 'cG5nLWJ5dGVz',
    mime_type: 'image/png',
  });
  expect(global.fetch).toHaveBeenCalledTimes(2);
  expect(global.fetch.mock.calls[0][0]).toContain('key=browser-key-1');
  expect(global.fetch.mock.calls[1][0]).toContain('key=browser-key-2');
  expect(localStorage.getItem('gemini_active_key_index')).toBe('1');
  expect(runNativeGeminiText).not.toHaveBeenCalled();
  expect(generateNativeGeminiImage).not.toHaveBeenCalled();
});
