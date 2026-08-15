import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  clearNativeGeneratedImages,
  exportNativeGeneratedImage,
  getActiveGeneratedImageProjectId,
} from '../../platform/nativeGeminiImage';
import { exportGeneratedResource } from '../../platform/generatedFileExportService';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import { clearBackgroundImages } from '../../utils/indexedDBUtils';
import { showErrorToast } from '../../utils/toastUtils';
import ImageGenerationSection from './ImageGenerationSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('../common/CustomDropdown', () => ({ default: () => null }));
vi.mock('../../utils/indexedDBUtils', () => ({ clearBackgroundImages: vi.fn() }));
vi.mock('../../platform/generatedFileExportService', () => ({
  exportGeneratedResource: vi.fn(),
}));
vi.mock('../../utils/toastUtils', () => ({ showErrorToast: vi.fn() }));
vi.mock('../../platform/runtimeEnvironment', () => ({ isDesktopRuntime: vi.fn() }));
vi.mock('../../platform/nativeGeminiImage', () => ({
  clearNativeGeneratedImages: vi.fn(),
  exportNativeGeneratedImage: vi.fn(),
  getActiveGeneratedImageProjectId: vi.fn(),
}));

const PROJECT = '01890f39-7b62-7c4e-8c9a-000000000306';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000307';
const ARTIFACT = '01890f39-7b62-7c4e-8c9a-000000000308';
const PLAYBACK = '4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11';
const playbackUrl = `http://127.0.0.1:43210/asset/${PLAYBACK}?token=${'a'.repeat(64)}`;
const nativeImage = Object.freeze({
  artifact: Object.freeze({
    artifactId: ARTIFACT,
    projectId: PROJECT,
    mimeType: 'image/png',
    sizeBytes: 16,
    createdAtMs: 1_700_000_000_000,
  }),
  playback: Object.freeze({
    id: PLAYBACK,
    playbackUrl,
    mimeType: 'image/png',
    byteLength: 16,
  }),
});

const image = Object.freeze({
  url: playbackUrl,
  timestamp: nativeImage.artifact.createdAtMs,
  prompt: '',
  isLoading: false,
  nativeImage,
});

const renderSection = (overrides = {}) => {
  const props = {
    currentTheme: 'dark',
    generatedImage: playbackUrl,
    setGeneratedImage: vi.fn(),
    generatedImages: [image],
    setGeneratedImages: vi.fn(),
    generatedPrompt: 'prompt',
    customLyrics: 'lyrics',
    customAlbumArt: 'cover',
    isGeneratingPrompt: false,
    isGeneratingImage: false,
    regularImageCount: 1,
    newPromptImageCount: 1,
    handleRegularImageCountChange: vi.fn(),
    handleNewPromptImageCountChange: vi.fn(),
    generateImage: vi.fn(),
    generateWithNewPrompt: vi.fn(),
    generateWithUniquePromptsButtonRef: { current: null },
    ...overrides,
  };
  return { props, ...render(<ImageGenerationSection {...props} />) };
};

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(true);
  exportNativeGeneratedImage.mockResolvedValue(true);
  clearNativeGeneratedImages.mockResolvedValue(1);
  getActiveGeneratedImageProjectId.mockResolvedValue(PROJECT);
});

test('exports a native generated image by project and artifact identity without fetching its URL', async () => {
  renderSection();
  fireEvent.click(screen.getByTitle('Download'));

  await waitFor(() => expect(exportNativeGeneratedImage).toHaveBeenCalledWith({
    projectId: PROJECT,
    artifactId: ARTIFACT,
    suggestedName: 'background-1.png',
  }));
  expect(exportGeneratedResource).not.toHaveBeenCalled();
  expect(JSON.stringify(exportNativeGeneratedImage.mock.calls)).not.toMatch(
    /(?:base64|data:image|"bytes"|playbackUrl|token=)/i
  );
});

test('browser generated-image export retains the lazy legacy exporter', async () => {
  isDesktopRuntime.mockReturnValue(false);
  exportGeneratedResource.mockResolvedValueOnce(true);
  renderSection();
  fireEvent.click(screen.getByTitle('Download'));

  await waitFor(() => expect(exportGeneratedResource).toHaveBeenCalledWith(
    playbackUrl,
    'background-1.png'
  ));
  expect(exportNativeGeneratedImage).not.toHaveBeenCalled();
});

test('never falls back to fetching a capability URL when native artifact metadata is missing', async () => {
  renderSection({ generatedImages: [], generatedImage: playbackUrl });
  fireEvent.click(screen.getByTitle('Download'));

  await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
  expect(exportNativeGeneratedImage).not.toHaveBeenCalled();
  expect(exportGeneratedResource).not.toHaveBeenCalled();
});

test('clears only the displayed native project and updates the UI after native success', async () => {
  const { props } = renderSection();
  fireEvent.click(screen.getByTitle('Clear All Images'));

  await waitFor(() => expect(clearNativeGeneratedImages).toHaveBeenCalledWith(PROJECT));
  expect(clearBackgroundImages).not.toHaveBeenCalled();
  expect(props.setGeneratedImages).toHaveBeenCalledWith([]);
  expect(props.setGeneratedImage).toHaveBeenCalledWith('');
});

test('clears the captured project when failed placeholders accompany its native images', async () => {
  const failedPlaceholder = Object.freeze({
    url: null,
    timestamp: nativeImage.artifact.createdAtMs + 1,
    prompt: '',
    isLoading: false,
    error: true,
  });
  const { props } = renderSection({ generatedImages: [image, failedPlaceholder] });
  fireEvent.click(screen.getByTitle('Clear All Images'));

  await waitFor(() => expect(clearNativeGeneratedImages).toHaveBeenCalledWith(PROJECT));
  expect(props.setGeneratedImages).toHaveBeenCalledWith([]);
  expect(props.setGeneratedImage).toHaveBeenCalledWith('');
});

test('keeps the UI intact when native clear fails', async () => {
  clearNativeGeneratedImages.mockRejectedValueOnce(new Error('fixed failure'));
  const { props } = renderSection();
  fireEvent.click(screen.getByTitle('Clear All Images'));

  await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
  expect(props.setGeneratedImages).not.toHaveBeenCalled();
  expect(props.setGeneratedImage).not.toHaveBeenCalled();
});

test('a stale A view cannot export or clear either A or the unseen active B project', async () => {
  getActiveGeneratedImageProjectId.mockResolvedValue(PROJECT_B);
  const { props } = renderSection();

  fireEvent.click(screen.getByTitle('Download'));
  await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
  expect(exportNativeGeneratedImage).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTitle('Clear All Images'));
  await waitFor(() => expect(showErrorToast).toHaveBeenCalledTimes(2));
  expect(clearNativeGeneratedImages).not.toHaveBeenCalled();
  expect(clearNativeGeneratedImages).not.toHaveBeenCalledWith(PROJECT);
  expect(props.setGeneratedImages).not.toHaveBeenCalled();
  expect(props.setGeneratedImage).not.toHaveBeenCalled();
});

test('does not clear the current UI when project B becomes active while native A clear is pending', async () => {
  let resolveClear;
  clearNativeGeneratedImages.mockReturnValue(new Promise((resolve) => {
    resolveClear = resolve;
  }));
  getActiveGeneratedImageProjectId
    .mockResolvedValueOnce(PROJECT)
    .mockResolvedValueOnce(PROJECT_B);
  const { props } = renderSection();

  fireEvent.click(screen.getByTitle('Clear All Images'));
  await waitFor(() => expect(clearNativeGeneratedImages).toHaveBeenCalledWith(PROJECT));
  resolveClear(1);

  await waitFor(() => expect(showErrorToast).toHaveBeenCalled());
  expect(props.setGeneratedImages).not.toHaveBeenCalled();
  expect(props.setGeneratedImage).not.toHaveBeenCalled();
});
