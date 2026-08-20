import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  generateBackgroundImage,
  generateBackgroundPrompt,
} from '../services/gemini/imageGenerationService';
import {
  getActiveGeneratedImageProjectId,
  loadNativeGeneratedImages,
  releaseNativeGeneratedImagePlayback,
} from '../platform/nativeGeminiImage';
import { isDesktopRuntime } from '../platform/runtimeEnvironment';
import { loadBackgroundImages, saveBackgroundImages } from '../utils/indexedDBUtils';
import BackgroundImageGenerator from './BackgroundImageGenerator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('./background/themeHook', () => ({ useCurrentTheme: () => 'dark' }));
vi.mock('./background/BackgroundPromptEditorButton', () => ({ default: () => null }));
vi.mock('./common/CustomScrollbarTextarea', () => ({ default: () => null }));
vi.mock('./background/PromptAndAlbumArtSection', () => ({ default: () => null }));
vi.mock('./background/ImageGenerationSection', () => ({
  default: ({ generatedImages, generateWithNewPrompt }) => (
    <div>
      <button type="button" onClick={() => generateWithNewPrompt(1)}>generate-browser-image</button>
      <div data-testid="browser-images">{generatedImages.map((image) => image?.url || '').join(',')}</div>
    </div>
  ),
}));
vi.mock('../services/gemini/imageGenerationService', () => ({
  generateBackgroundImage: vi.fn(),
  generateBackgroundPrompt: vi.fn(),
}));
vi.mock('../utils/indexedDBUtils', () => ({
  loadBackgroundImages: vi.fn(),
  saveBackgroundImages: vi.fn(),
}));
vi.mock('../platform/runtimeEnvironment', () => ({ isDesktopRuntime: vi.fn() }));
vi.mock('../platform/nativeGeminiImage', () => ({
  getActiveGeneratedImageProjectId: vi.fn(),
  loadNativeGeneratedImages: vi.fn(),
  releaseNativeGeneratedImagePlayback: vi.fn(),
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  subscribeCurrentCacheId: vi.fn(() => () => undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(false);
  loadBackgroundImages.mockResolvedValue([]);
  saveBackgroundImages.mockResolvedValue(undefined);
  generateBackgroundPrompt.mockResolvedValue('browser-only prompt');
  generateBackgroundImage.mockResolvedValue({
    mime_type: 'image/png',
    data: 'YnJvd3Nlci1ieXRlcw==',
  });
});

test('browser results become browser-only data URLs and IndexedDB records without native fallback', async () => {
  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />);
  await waitFor(() => expect(loadBackgroundImages).toHaveBeenCalled());
  fireEvent.click(screen.getByText('generate-browser-image'));

  await waitFor(() => expect(screen.getByTestId('browser-images'))
    .toHaveTextContent('data:image/png;base64,YnJvd3Nlci1ieXRlcw=='));
  await waitFor(() => expect(saveBackgroundImages).toHaveBeenCalledWith([
    expect.objectContaining({
      url: 'data:image/png;base64,YnJvd3Nlci1ieXRlcw==',
    }),
  ]));
  const saved = saveBackgroundImages.mock.calls.find(([images]) => (
    images[0]?.url === 'data:image/png;base64,YnJvd3Nlci1ieXRlcw=='
  ))?.[0];
  expect(saved[0]).not.toHaveProperty('nativeImage');
  expect(getActiveGeneratedImageProjectId).not.toHaveBeenCalled();
  expect(loadNativeGeneratedImages).not.toHaveBeenCalled();
  expect(releaseNativeGeneratedImagePlayback).not.toHaveBeenCalled();
});
