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

beforeEach(() => {
  vi.clearAllMocks();
  delete window.isTauri;
  localStorage.clear();
  localStorage.setItem('gemini_api_keys', JSON.stringify(['browser-key-1', 'browser-key-2']));
});

test('browser inspection cannot contact Gemini for prompt generation', async () => {
  await expect(generateBackgroundPrompt('browser lyrics', 'Browser Song'))
    .rejects.toThrow('requires the desktop runtime');
  expect(runNativeGeminiText).not.toHaveBeenCalled();
  expect(generateNativeGeminiImage).not.toHaveBeenCalled();
});

test('browser inspection cannot expose credentials or contact Gemini for image generation', async () => {
  const albumArt = `data:image/png;base64,${btoa('\x89PNG\r\n\x1a\ncover')}`;

  await expect(generateBackgroundImage('browser image', albumArt))
    .rejects.toThrow('requires the desktop runtime');
  expect(runNativeGeminiText).not.toHaveBeenCalled();
  expect(generateNativeGeminiImage).not.toHaveBeenCalled();
});
