import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  getTranscriptionRulesSync,
  setTranscriptionRulesForCache,
} from '../utils/transcriptionRulesStore';
import { captureActiveMediaRunContext } from '../utils/autoGenerationOwnership';
import VideoAnalysisButton from './VideoAnalysisButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  getTranscriptionRulesSync: vi.fn(),
  setTranscriptionRulesForCache: vi.fn(),
}));
vi.mock('../utils/autoGenerationOwnership', () => ({
  captureActiveMediaRunContext: vi.fn(),
  assertAutoGenerationContextCurrent: vi.fn((context) => context),
  assertAutoGenerationContextDurable: vi.fn(async (context) => context),
  isAutoGenerationContext: vi.fn((context) => context?.kind === 'auto-generation-context'),
}));
vi.mock('../utils/videoProcessing/analysisUtils', () => ({
  analyzeVideoAndWaitForUserChoice: vi.fn(),
}));
vi.mock('../utils/toastUtils', () => ({
  showErrorToast: vi.fn(),
  showWarningToast: vi.fn(),
}));
vi.mock('./TranscriptionRulesEditor', () => ({
  default: ({ onSave }) => (
    <button type="button" onClick={() => onSave({ atmosphere: 'Edited' })}>
      Save owned rules
    </button>
  ),
}));
vi.mock('./common/LoadingIndicator', () => ({ default: () => null }));

const media = (name, assetId) => ({
  __nativeMedia: true,
  assetId,
  name,
  size: 1024,
  lastModified: 0,
  type: 'video/mp4',
});

beforeEach(() => {
  vi.clearAllMocks();
  getTranscriptionRulesSync.mockReturnValue({ atmosphere: 'Media A' });
  setTranscriptionRulesForCache.mockResolvedValue(undefined);
  captureActiveMediaRunContext.mockImplementation(async ({ runId, media: ownedMedia, signal }) => ({
    kind: 'auto-generation-context',
    runId,
    media: ownedMedia,
    cacheId: 'cache-1',
    projectId: 'project-1',
    sourceIdentity: `asset:${ownedMedia.assetId}`,
    signal,
  }));
});

test('switching media reads the newly active project and never deletes its rules', async () => {
  const first = media('a.mp4', '019ffa3a-9a95-7a91-bad8-bd6144abaaeb');
  const second = media('b.mp4', '019ffa3d-8e35-7f92-b3e3-607dd27bb263');
  const view = render(<VideoAnalysisButton uploadedFile={first} uploadedFileData={first} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /Edit rules$/ })).toBeInTheDocument());

  getTranscriptionRulesSync.mockReturnValue({ atmosphere: 'Media B' });
  view.rerender(<VideoAnalysisButton uploadedFile={second} uploadedFileData={second} />);
  await waitFor(() => expect(getTranscriptionRulesSync).toHaveBeenCalled());

  expect(setTranscriptionRulesForCache).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Edit rules$/ })).toBeInTheDocument();
});

test('captures the active project before opening and awaits its scoped editor save', async () => {
  const ownedMedia = media('a.mp4', '019ffa3a-9a95-7a91-bad8-bd6144abaaeb');
  render(<VideoAnalysisButton uploadedFile={ownedMedia} uploadedFileData={ownedMedia} />);
  fireEvent.click(await screen.findByRole('button', { name: /Edit rules$/ }));
  const save = await screen.findByRole('button', { name: 'Save owned rules' });

  fireEvent.click(save);
  await waitFor(() => expect(setTranscriptionRulesForCache).toHaveBeenCalledWith(
    'cache-1',
    { atmosphere: 'Edited' },
    { expectedProjectId: 'project-1' },
  ));
  expect(captureActiveMediaRunContext).toHaveBeenCalledWith(expect.objectContaining({
    media: ownedMedia,
    signal: expect.any(AbortSignal),
  }));
});
