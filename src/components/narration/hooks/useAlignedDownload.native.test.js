import { act, renderHook } from '@testing-library/react';

import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  generateAlignedNarration,
  getAlignedNarrationArtifactId,
} from '../../../services/alignedNarrationService';
import useAlignedDownload from './useAlignedDownload';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/nativeNarrationArtifacts', () => ({
  downloadNativeNarration: vi.fn(),
}));
vi.mock('../../../services/alignedNarrationService', () => ({
  generateAlignedNarration: vi.fn(),
  getAlignedNarrationArtifactId: vi.fn(),
}));
vi.mock('../utils/loadingOverlayFactory', () => ({
  createSimpleLoadingOverlay: () => ({
    updateProgress: vi.fn(),
    destroy: vi.fn(),
  }),
}));

const CLIP_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const ALIGNED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';

test('aligned download stays on durable native speech artifacts', async () => {
  const originalFetch = global.fetch;
  global.fetch = vi.fn();
  generateAlignedNarration.mockResolvedValue('aligned-preview://timeline');
  getAlignedNarrationArtifactId.mockReturnValue(ALIGNED_ID);
  downloadNativeNarration.mockResolvedValue(undefined);
  const { result } = renderHook(() => useAlignedDownload({
    generationResults: [{
      subtitle_id: 1,
      success: true,
      nativeArtifactId: CLIP_ID,
      filename: `osg-speech-artifact:${CLIP_ID}`,
    }],
    getSelectedSubtitles: () => [{ id: 1, text: 'hello', start: 0, end: 1 }],
    t: (_key, fallback) => fallback,
  }));

  await act(async () => result.current.downloadAlignedAudio());

  expect(generateAlignedNarration).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ nativeArtifactId: CLIP_ID })]),
    expect.any(Function),
  );
  expect(downloadNativeNarration).toHaveBeenCalledWith({
    success: true,
    nativeArtifactId: ALIGNED_ID,
    nativeFormat: 'm4a',
    subtitle_id: 'aligned',
  }, 'aligned_narration.m4a');
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
});
