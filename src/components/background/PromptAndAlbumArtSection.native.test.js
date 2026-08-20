import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  exportReferenceImagePlayback,
  releaseReferenceImagePlayback,
  selectReferenceImagePlayback,
} from '../../platform/imageService';
import { getActiveGeneratedImageProjectId } from '../../platform/nativeGeminiImage';
import { exportGeneratedResource } from '../../platform/generatedFileExportService';
import { isDesktopRuntime } from '../../platform/runtimeEnvironment';
import PromptAndAlbumArtSection from './PromptAndAlbumArtSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('../common/CustomScrollbarTextarea', () => ({
  default: ({ value, onChange }) => <textarea value={value} onChange={onChange} />,
}));
vi.mock('../../platform/generatedFileExportService', () => ({
  exportGeneratedResource: vi.fn(),
}));
vi.mock('../../platform/imageService', () => ({
  exportReferenceImagePlayback: vi.fn(),
  releaseReferenceImagePlayback: vi.fn(),
  selectReferenceImagePlayback: vi.fn(),
}));
vi.mock('../../platform/nativeGeminiImage', () => ({
  getActiveGeneratedImageProjectId: vi.fn(),
}));
vi.mock('../../platform/runtimeEnvironment', () => ({ isDesktopRuntime: vi.fn() }));
vi.mock('../../utils/toastUtils', () => ({ showErrorToast: vi.fn() }));

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000401';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000402';
const playback = (id, token = 'a', projectId = PROJECT_A) => Object.freeze({
  id,
  playbackUrl: `http://127.0.0.1:43210/asset/${id}?token=${token.repeat(64)}`,
  mimeType: 'image/png',
  byteLength: 16,
  projectId,
});
const LOCAL_A = playback('4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11');
const LOCAL_B = playback('9cb6df97-92c6-4f6d-8717-c2a7acb74a12', 'b');
const PROVIDER = playback('8aa0ed25-3679-4d70-812d-e5877aa99d55', 'c');

const props = (overrides = {}) => ({
  currentTheme: 'dark',
  customSongName: '',
  setCustomSongName: vi.fn(),
  customLyrics: 'lyrics',
  generatedPrompt: 'prompt',
  setGeneratedPrompt: vi.fn(),
  customAlbumArt: '',
  setCustomAlbumArt: vi.fn(),
  isGeneratingPrompt: false,
  generatePrompt: vi.fn(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(true);
  releaseReferenceImagePlayback.mockResolvedValue(true);
  exportReferenceImagePlayback.mockResolvedValue(true);
  getActiveGeneratedImageProjectId.mockResolvedValue(PROJECT_A);
});

test('desktop local selection, reselection, and unmount keep bytes native and release ownership', async () => {
  selectReferenceImagePlayback
    .mockResolvedValueOnce(LOCAL_A)
    .mockResolvedValueOnce(LOCAL_B);
  const firstProps = props();
  const view = render(<PromptAndAlbumArtSection {...firstProps} />);

  expect(view.container.querySelector('input[type="file"]')).toBeNull();
  fireEvent.click(screen.getAllByTitle('Upload Album Art')[0]);
  await waitFor(() => expect(firstProps.setCustomAlbumArt).toHaveBeenCalledWith(
    LOCAL_A.playbackUrl
  ));
  expect(selectReferenceImagePlayback).toHaveBeenCalledTimes(1);
  expect(selectReferenceImagePlayback).toHaveBeenCalledWith(PROJECT_A);
  expect(releaseReferenceImagePlayback).not.toHaveBeenCalled();

  const secondProps = props({ customAlbumArt: LOCAL_A.playbackUrl });
  view.rerender(<PromptAndAlbumArtSection {...secondProps} />);
  fireEvent.click(screen.getAllByTitle('Upload Album Art')[0]);
  await waitFor(() => expect(secondProps.setCustomAlbumArt).toHaveBeenCalledWith(
    LOCAL_B.playbackUrl
  ));
  expect(releaseReferenceImagePlayback).toHaveBeenCalledWith({
    playbackId: LOCAL_A.id,
    projectId: PROJECT_A,
  });

  view.rerender(<PromptAndAlbumArtSection {...props({ customAlbumArt: LOCAL_B.playbackUrl })} />);
  view.unmount();
  expect(releaseReferenceImagePlayback).toHaveBeenCalledWith({
    playbackId: LOCAL_B.id,
    projectId: PROJECT_A,
  });
});

test('a provider change while the native picker is pending releases the stale local selection', async () => {
  let resolveSelection;
  selectReferenceImagePlayback.mockReturnValue(new Promise((resolve) => {
    resolveSelection = resolve;
  }));
  const initial = props();
  const view = render(<PromptAndAlbumArtSection {...initial} />);
  fireEvent.click(screen.getAllByTitle('Upload Album Art')[0]);

  view.rerender(<PromptAndAlbumArtSection {...props({ customAlbumArt: PROVIDER.playbackUrl })} />);
  resolveSelection(LOCAL_A);

  await waitFor(() => expect(releaseReferenceImagePlayback).toHaveBeenCalledWith({
    playbackId: LOCAL_A.id,
    projectId: PROJECT_A,
  }));
  expect(initial.setCustomAlbumArt).not.toHaveBeenCalled();
});

test('an A to B project switch during the native dialog releases A exactly once and never installs it', async () => {
  getActiveGeneratedImageProjectId
    .mockResolvedValueOnce(PROJECT_A)
    .mockResolvedValueOnce(PROJECT_B);
  selectReferenceImagePlayback.mockResolvedValueOnce(LOCAL_A);
  const initial = props();
  render(<PromptAndAlbumArtSection {...initial} />);

  fireEvent.click(screen.getAllByTitle('Upload Album Art')[0]);

  await waitFor(() => expect(releaseReferenceImagePlayback).toHaveBeenCalledTimes(1));
  expect(selectReferenceImagePlayback).toHaveBeenCalledWith(PROJECT_A);
  expect(releaseReferenceImagePlayback).toHaveBeenCalledWith({
    playbackId: LOCAL_A.id,
    projectId: PROJECT_A,
  });
  expect(initial.setCustomAlbumArt).not.toHaveBeenCalled();
});

test('picker cancellation creates no capability to release and preserves the current art', async () => {
  selectReferenceImagePlayback.mockResolvedValueOnce(null);
  const initial = props({ customAlbumArt: PROVIDER.playbackUrl });
  render(<PromptAndAlbumArtSection {...initial} />);
  fireEvent.click(screen.getAllByTitle('Upload Album Art')[0]);

  await waitFor(() => expect(selectReferenceImagePlayback).toHaveBeenCalledWith(PROJECT_A));
  expect(releaseReferenceImagePlayback).not.toHaveBeenCalled();
  expect(initial.setCustomAlbumArt).not.toHaveBeenCalled();
});

test('desktop album-art export uses only the active project and native playback capability', async () => {
  render(<PromptAndAlbumArtSection {...props({ customAlbumArt: PROVIDER.playbackUrl })} />);
  fireEvent.click(screen.getByTitle('Download Album Art'));

  await waitFor(() => expect(exportReferenceImagePlayback).toHaveBeenCalledWith(
    PROVIDER.playbackUrl,
    PROJECT_A,
    'album-art.png'
  ));
  expect(exportGeneratedResource).not.toHaveBeenCalled();
});

test('browser upload retains FileReader behavior and never opens the native picker', async () => {
  isDesktopRuntime.mockReturnValue(false);
  const readAsDataURL = vi.fn(function read() {
    this.onload({ target: { result: 'data:image/png;base64,cG5n' } });
  });
  const OriginalFileReader = global.FileReader;
  global.FileReader = vi.fn(function Reader() {
    this.onload = null;
    this.readAsDataURL = readAsDataURL;
  });
  const browserProps = props();
  const view = render(<PromptAndAlbumArtSection {...browserProps} />);
  const file = new File(['png'], 'cover.png', { type: 'image/png' });
  fireEvent.change(view.container.querySelector('input[type="file"]'), {
    target: { files: [file] },
  });

  await waitFor(() => expect(browserProps.setCustomAlbumArt)
    .toHaveBeenCalledWith('data:image/png;base64,cG5n'));
  expect(readAsDataURL).toHaveBeenCalledWith(file);
  expect(selectReferenceImagePlayback).not.toHaveBeenCalled();
  global.FileReader = OriginalFileReader;
});

test('browser album-art export retains the lazy legacy exporter', async () => {
  isDesktopRuntime.mockReturnValue(false);
  exportGeneratedResource.mockResolvedValueOnce(true);
  render(<PromptAndAlbumArtSection {...props({
    customAlbumArt: 'data:image/png;base64,cG5n',
  })} />);
  fireEvent.click(screen.getByTitle('Download Album Art'));

  await waitFor(() => expect(exportGeneratedResource).toHaveBeenCalledWith(
    'data:image/png;base64,cG5n',
    'album-art.png'
  ));
  expect(exportReferenceImagePlayback).not.toHaveBeenCalled();
});
