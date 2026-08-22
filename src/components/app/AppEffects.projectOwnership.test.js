import { renderHook } from '@testing-library/react';

import { useAppEffects } from './AppEffects';

vi.mock('../../utils/geminiEffects', () => ({
  initGeminiButtonEffects: vi.fn(),
  resetAllGeminiButtonEffects: vi.fn(),
  disableGeminiButtonEffects: vi.fn(),
}));
vi.mock('../../services/localStorageService', () => ({
  syncLocalStorageToServer: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/tabPillAnimation', () => ({ default: vi.fn() }));
vi.mock('../../utils/systemDetection', () => ({ getThemeWithFallback: vi.fn(() => 'light') }));

const props = (overrides = {}) => ({
  setSegmentsStatus: vi.fn(),
  setVideoSegments: vi.fn(),
  setShowVideoAnalysis: vi.fn(),
  setVideoAnalysisResult: vi.fn(),
  setStatus: vi.fn(),
  setTheme: vi.fn(),
  setShowWaveformLongVideos: vi.fn(),
  setTimeFormat: vi.fn(),
  setOptimizeVideos: vi.fn(),
  setOptimizedResolution: vi.fn(),
  setUseOptimizedPreview: vi.fn(),
  subtitlesData: [{ start: 0, end: 1, text: 'Cached subtitle' }],
  status: {
    type: 'success',
    translationKey: 'output.subtitlesLoadedFromCache',
    message: 'Subtitles loaded from cache!',
  },
  ...overrides,
});

test('a cache-hit status never starts a second media preparation owner', async () => {
  const legacyDuplicatePreparation = vi.fn();
  const { unmount } = renderHook(() => useAppEffects(props({
    uploadedFile: null,
    handleDownloadAndPrepareYouTubeVideo: legacyDuplicatePreparation,
  })));

  await Promise.resolve();
  expect(legacyDuplicatePreparation).not.toHaveBeenCalled();
  unmount();
});
