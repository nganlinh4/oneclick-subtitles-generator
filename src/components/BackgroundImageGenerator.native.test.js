import { act, render, screen, waitFor } from '@testing-library/react';

import {
  getActiveGeneratedImageProjectId,
  loadNativeGeneratedImages,
  releaseNativeGeneratedImagePlayback,
} from '../platform/nativeGeminiImage';
import { isDesktopRuntime } from '../platform/runtimeEnvironment';
import { loadBackgroundImages, saveBackgroundImages } from '../utils/indexedDBUtils';
import { subscribeCurrentCacheId } from '../utils/userSubtitlesStore';
import {
  generateBackgroundImage,
  generateBackgroundPrompt,
} from '../services/gemini/imageGenerationService';
import { getActiveProjectSnapshot } from '../platform/projectService';
import BackgroundImageGenerator from './BackgroundImageGenerator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('./background/themeHook', () => ({ useCurrentTheme: () => 'dark' }));
vi.mock('./background/BackgroundPromptEditorButton', () => ({ default: () => null }));
vi.mock('./common/CustomScrollbarTextarea', () => ({
  default: ({ value, onChange }) => <textarea value={value} onChange={onChange} />,
}));
vi.mock('./background/PromptAndAlbumArtSection', () => ({
  default: ({ setCustomAlbumArt, generatePrompt }) => (
    <>
      <button type="button" onClick={() => setCustomAlbumArt('native-local-capability')}>
        Select local album art
      </button>
      <button type="button" onClick={() => generatePrompt()}>
        Generate test prompt
      </button>
    </>
  ),
}));
vi.mock('./background/ImageGenerationSection', () => ({
  default: ({ generatedImages, generateImage, customAlbumArt, generatedPrompt }) => (
    <>
      <div data-testid="generated-image-list">
        {generatedImages.map((image) => image?.nativeImage?.artifact.artifactId ?? 'placeholder')
          .join(',')}
      </div>
      <div data-testid="selected-album-art">{customAlbumArt}</div>
      <div data-testid="generated-prompt">{generatedPrompt}</div>
      <button type="button" onClick={() => generateImage('manual prompt', 1)}>
        Generate test image
      </button>
      <button type="button" onClick={() => generateImage(null, 1)}>
        Generate image from current prompt
      </button>
    </>
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
vi.mock('../platform/projectService', () => ({
  getActiveProjectSnapshot: vi.fn(),
}));
vi.mock('../utils/userSubtitlesStore', () => ({
  subscribeCurrentCacheId: vi.fn(),
}));

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000306';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000307';
const ARTIFACT_A = '01890f39-7b62-7c4e-8c9a-000000000308';
const PLAYBACK_A = '4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11';
const ARTIFACT_B = '01890f39-7b62-7c4e-8c9a-000000000309';
const PLAYBACK_B = '9cb6df97-92c6-4f6d-8717-c2a7acb74a12';
const ARTIFACT_LATE = '01890f39-7b62-7c4e-8c9a-000000000310';
const PLAYBACK_LATE = 'f080b54d-0a31-4f64-91f0-00492fbb8d2c';

const playable = Object.freeze({
  artifact: Object.freeze({
    artifactId: ARTIFACT_A,
    projectId: PROJECT_A,
    mimeType: 'image/png',
    sizeBytes: 16,
    createdAtMs: 1_700_000_000_000,
  }),
  playback: Object.freeze({
    id: PLAYBACK_A,
    playbackUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_A}?token=${'a'.repeat(64)}`,
    mimeType: 'image/png',
    byteLength: 16,
  }),
});
const playableB = Object.freeze({
  artifact: Object.freeze({
    artifactId: ARTIFACT_B,
    projectId: PROJECT_B,
    mimeType: 'image/png',
    sizeBytes: 16,
    createdAtMs: 1_700_000_000_001,
  }),
  playback: Object.freeze({
    id: PLAYBACK_B,
    playbackUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_B}?token=${'b'.repeat(64)}`,
    mimeType: 'image/png',
    byteLength: 16,
  }),
});
const playableLate = Object.freeze({
  artifact: Object.freeze({
    artifactId: ARTIFACT_LATE,
    projectId: PROJECT_A,
    mimeType: 'image/png',
    sizeBytes: 16,
    createdAtMs: 1_700_000_000_002,
  }),
  playback: Object.freeze({
    id: PLAYBACK_LATE,
    playbackUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_LATE}?token=${'c'.repeat(64)}`,
    mimeType: 'image/png',
    byteLength: 16,
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(true);
  getActiveGeneratedImageProjectId.mockResolvedValue(PROJECT_A);
  loadNativeGeneratedImages.mockResolvedValue([playable]);
  releaseNativeGeneratedImagePlayback.mockResolvedValue(true);
  generateBackgroundImage.mockReset();
  generateBackgroundPrompt.mockReset();
  getActiveProjectSnapshot.mockReturnValue({
    metadata: { id: PROJECT_A, name: 'Project A' },
    stateVersion: 4,
    media: [],
    tracks: [],
  });
  subscribeCurrentCacheId.mockImplementation(() => () => undefined);
  window.addToast = vi.fn();
});

test('reopens the active project library after remount without reading or writing global IndexedDB', async () => {
  const first = render(
    <BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />
  );
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));
  expect(loadNativeGeneratedImages).toHaveBeenCalledWith(PROJECT_A);
  expect(loadBackgroundImages).not.toHaveBeenCalled();
  expect(saveBackgroundImages).not.toHaveBeenCalled();

  first.unmount();
  await waitFor(() => expect(releaseNativeGeneratedImagePlayback).toHaveBeenCalledWith(playable));

  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />);
  await waitFor(() => expect(loadNativeGeneratedImages).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A);
  expect(saveBackgroundImages).not.toHaveBeenCalled();
});

test('a user-selected native album-art capability is not overwritten by unchanged source props', async () => {
  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="provider-cover" songName="song" isExpanded />);
  await waitFor(() => expect(screen.getByTestId('selected-album-art'))
    .toHaveTextContent('provider-cover'));

  screen.getByRole('button', { name: 'Select local album art' }).click();

  await waitFor(() => expect(screen.getByTestId('selected-album-art'))
    .toHaveTextContent('native-local-capability'));
});

test('drops and releases a reopened capability when the active project changes during load', async () => {
  getActiveGeneratedImageProjectId
    .mockResolvedValueOnce(PROJECT_A)
    .mockResolvedValueOnce(PROJECT_B);

  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />);

  await waitFor(() => expect(releaseNativeGeneratedImagePlayback).toHaveBeenCalledWith(playable));
  expect(screen.getByTestId('generated-image-list')).toHaveTextContent('');
  expect(saveBackgroundImages).not.toHaveBeenCalled();
});

test('an exact cache-project switch with unchanged visual props releases A and loads B', async () => {
  let projectListener;
  subscribeCurrentCacheId.mockImplementation((listener) => {
    projectListener = listener;
    return () => undefined;
  });
  getActiveGeneratedImageProjectId
    .mockResolvedValueOnce(PROJECT_A)
    .mockResolvedValueOnce(PROJECT_A)
    .mockResolvedValueOnce(PROJECT_B)
    .mockResolvedValueOnce(PROJECT_B);
  loadNativeGeneratedImages.mockImplementation(async (projectId) => (
    projectId === PROJECT_A ? [playable] : [playableB]
  ));
  render(<BackgroundImageGenerator lyrics="same" albumArt="same" songName="same" isExpanded />);
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));

  act(() => projectListener('cache-b', 'cache-a'));

  await waitFor(() => expect(loadNativeGeneratedImages).toHaveBeenCalledWith(PROJECT_B));
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_B));
  expect(screen.getByTestId('generated-image-list')).not.toHaveTextContent(ARTIFACT_A);
  expect(releaseNativeGeneratedImagePlayback).toHaveBeenCalledWith(playable);
});

test('a live A generation is aborted on an identical-props switch to B and its late capability is released once', async () => {
  let projectListener;
  let activeProject = PROJECT_A;
  let resolveGeneration;
  let generationSignal;
  subscribeCurrentCacheId.mockImplementation((listener) => {
    projectListener = listener;
    return () => undefined;
  });
  getActiveGeneratedImageProjectId.mockImplementation(async () => activeProject);
  loadNativeGeneratedImages.mockImplementation(async (projectId) => (
    projectId === PROJECT_A ? [playable] : [playableB]
  ));
  generateBackgroundImage.mockImplementation((_prompt, _albumArt, options) => {
    generationSignal = options.signal;
    return new Promise((resolve) => { resolveGeneration = resolve; });
  });

  render(<BackgroundImageGenerator lyrics="same" albumArt="same" songName="same" isExpanded />);
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));
  screen.getByRole('button', { name: 'Generate test image' }).click();
  await waitFor(() => expect(generateBackgroundImage).toHaveBeenCalledTimes(1));

  activeProject = PROJECT_B;
  act(() => projectListener('cache-b', 'cache-a'));
  expect(generationSignal.aborted).toBe(true);
  resolveGeneration(playableLate);

  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_B));
  await waitFor(() => expect(releaseNativeGeneratedImagePlayback).toHaveBeenCalledWith(playableLate));
  expect(releaseNativeGeneratedImagePlayback.mock.calls.filter(
    ([image]) => image === playableLate
  )).toHaveLength(1);
  expect(screen.getByTestId('generated-image-list')).not.toHaveTextContent(ARTIFACT_A);
  expect(screen.getByTestId('generated-image-list')).not.toHaveTextContent(ARTIFACT_LATE);
});

test('unmount aborts an in-flight generation and releases a capability that resolves late exactly once', async () => {
  let resolveGeneration;
  let generationSignal;
  generateBackgroundImage.mockImplementation((_prompt, _albumArt, options) => {
    generationSignal = options.signal;
    return new Promise((resolve) => { resolveGeneration = resolve; });
  });
  const mounted = render(
    <BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />
  );
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));
  screen.getByRole('button', { name: 'Generate test image' }).click();
  await waitFor(() => expect(generateBackgroundImage).toHaveBeenCalledTimes(1));

  mounted.unmount();
  expect(generationSignal.aborted).toBe(true);
  resolveGeneration(playableLate);

  await waitFor(() => expect(releaseNativeGeneratedImagePlayback).toHaveBeenCalledWith(playableLate));
  expect(releaseNativeGeneratedImagePlayback.mock.calls.filter(
    ([image]) => image === playableLate
  )).toHaveLength(1);
});

test('acknowledges a generated prompt only after a durable native image exists', async () => {
  const acknowledge = vi.fn().mockResolvedValue(undefined);
  generateBackgroundPrompt.mockResolvedValue({
    text: 'durable prompt',
    delivery: { jobId: 'job-a', deliveryId: 'delivery-a', acknowledge },
  });
  generateBackgroundImage.mockResolvedValue(playableLate);

  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />);
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));
  screen.getByRole('button', { name: 'Generate test prompt' }).click();
  await waitFor(() => expect(screen.getByTestId('generated-prompt')).toHaveTextContent('durable prompt'));
  expect(generateBackgroundPrompt).toHaveBeenCalledWith('lyrics', 'song', {
    projectId: PROJECT_A,
    expectedProjectStateVersion: 4,
  });
  expect(acknowledge).not.toHaveBeenCalled();

  screen.getByRole('button', { name: 'Generate image from current prompt' }).click();
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_LATE));
  expect(generateBackgroundImage).toHaveBeenCalledWith(
    'durable prompt',
    'cover',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

test('keeps a prompt delivery pending when image generation fails and retries a lost ack response', async () => {
  const acknowledge = vi.fn()
    .mockRejectedValueOnce(new Error('ack response lost'))
    .mockResolvedValue(undefined);
  generateBackgroundPrompt.mockResolvedValue({
    text: 'retryable prompt',
    delivery: { jobId: 'job-a', deliveryId: 'delivery-a', acknowledge },
  });
  generateBackgroundImage
    .mockRejectedValueOnce(new Error('image provider failed'))
    .mockResolvedValue(playableLate);

  render(<BackgroundImageGenerator lyrics="lyrics" albumArt="cover" songName="song" isExpanded />);
  await waitFor(() => expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_A));
  screen.getByRole('button', { name: 'Generate test prompt' }).click();
  await waitFor(() => expect(screen.getByTestId('generated-prompt')).toHaveTextContent('retryable prompt'));

  screen.getByRole('button', { name: 'Generate image from current prompt' }).click();
  await waitFor(() => expect(generateBackgroundImage).toHaveBeenCalledTimes(1));
  expect(acknowledge).not.toHaveBeenCalled();

  screen.getByRole('button', { name: 'Generate image from current prompt' }).click();
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
  screen.getByRole('button', { name: 'Generate image from current prompt' }).click();
  await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(2));
  expect(screen.getByTestId('generated-image-list')).toHaveTextContent(ARTIFACT_LATE);
});
