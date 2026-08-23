import { act, renderHook } from '@testing-library/react';

import { downloadNativeNarration } from '../../../platform/nativeNarrationArtifacts';
import {
  generateAlignedNarration,
  getAlignedNarrationArtifactIdForPlan,
} from '../../../services/alignedNarrationService';
import useAlignedDownload from './useAlignedDownload';
import { showSuccessToast } from '../../../utils/toastUtils';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/nativeNarrationArtifacts', () => ({
  downloadNativeNarration: vi.fn(),
}));
vi.mock('../../../services/alignedNarrationService', () => ({
  generateAlignedNarration: vi.fn(),
  getAlignedNarrationArtifactIdForPlan: vi.fn(),
}));
vi.mock('../utils/loadingOverlayFactory', () => ({
  createSimpleLoadingOverlay: () => ({
    updateProgress: vi.fn(),
    destroy: vi.fn(),
  }),
}));
vi.mock('../../../utils/toastUtils', () => ({ showSuccessToast: vi.fn() }));

const CLIP_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const ALIGNED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

test('aligned download stays on durable native speech artifacts', async () => {
  const originalFetch = global.fetch;
  global.fetch = vi.fn();
  generateAlignedNarration.mockResolvedValue('aligned-preview://timeline');
  getAlignedNarrationArtifactIdForPlan.mockReturnValue(ALIGNED_ID);
  downloadNativeNarration.mockResolvedValue(undefined);
  const currentCues = [{ id: 1, text: 'hello', start: 0, end: 1 }];
  const generationResults = [{
    subtitle_id: 1,
    text: 'hello',
    success: true,
    nativeArtifactId: CLIP_ID,
    filename: `osg-speech-artifact:${CLIP_ID}`,
    projectId: PROJECT_ID,
  }];
  const { result } = renderHook(() => useAlignedDownload({
    generationResults,
    getCurrentCues: () => currentCues,
    t: (_key, fallback) => fallback,
  }));

  await act(async () => result.current.downloadAlignedAudio());

  expect(generateAlignedNarration).toHaveBeenCalledWith(
    generationResults,
    currentCues,
    expect.any(Function),
  );
  expect(downloadNativeNarration).toHaveBeenCalledWith({
    success: true,
    nativeArtifactId: ALIGNED_ID,
    nativeFormat: 'm4a',
    subtitle_id: 'aligned',
  }, 'aligned_narration.m4a');
  expect(showSuccessToast).toHaveBeenCalledWith('Aligned narration was saved successfully.');
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
});
