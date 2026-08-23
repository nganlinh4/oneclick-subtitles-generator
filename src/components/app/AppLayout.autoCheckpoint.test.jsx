import { render } from '@testing-library/react';

import { checkpointBeforeUpdate } from '../../services/lifecycleOrchestrator';
import AppLayout from './AppLayout';

const mocks = vi.hoisted(() => ({
  flush: vi.fn(),
}));

vi.mock('../Header', () => ({ default: () => null }));
vi.mock('../InputMethods', () => ({ default: () => null }));
vi.mock('./ButtonsContainer', () => ({ default: () => null }));
vi.mock('../settings/SettingsModal', () => ({ default: () => null }));
vi.mock('../VideoAnalysisModal', () => ({ default: () => null }));
vi.mock('../TranscriptionRulesEditor', () => ({ default: () => null }));
vi.mock('../BackgroundImageGenerator', () => ({ default: () => null }));
vi.mock('../VideoRenderingSection', () => ({ default: () => null }));
vi.mock('../VideoQualityModal', () => ({ default: () => null }));
vi.mock('../FloatingScrollbar', () => ({ default: () => null }));
vi.mock('../VideoProcessingOptionsModal', () => ({ default: () => null }));
vi.mock('../BackgroundMusicSection', () => ({ default: () => null }));
vi.mock('../previews/VideoPreview', () => ({ default: () => null }));
vi.mock('../LyricsDisplay', () => ({ default: () => null }));
vi.mock('../translation', () => ({ default: () => null }));
vi.mock('../narration', () => ({ UnifiedNarrationSection: () => null }));
vi.mock('../ParallelProcessingStatus', () => ({ default: () => null }));
vi.mock('../../hooks/useVideoInfo', () => ({
  useVideoInfo: () => ({
    videoInfo: null,
    availableVersions: [],
    getVideoInfoForModal: () => null,
    getVideoFileForRendering: vi.fn(),
  }),
}));
vi.mock('../../utils/mobileZoom', () => ({ initializeMobileZoom: vi.fn() }));
vi.mock('../../hooks/useNativeMediaSessionHydration', () => ({
  applyNativeMediaSession: vi.fn(),
}));
vi.mock('../../platform/durableLyricsHistory', () => ({
  flushDurableLyricsHistory: mocks.flush,
}));
vi.mock('../../platform/durableLyricsCheckpoint', () => ({
  flushDurableLyricsHistory: mocks.flush,
}));
vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../../services/subtitleCache', async (importOriginal) => ({
  ...(await importOriginal()),
  saveSubtitlesToCache: vi.fn(),
}));
vi.mock('../../utils/userSubtitlesStore', async (importOriginal) => ({
  ...(await importOriginal()),
  getCurrentCacheId: () => 'fresh-url-cache',
}));

const fn = () => undefined;

const appState = () => ({
  showSettings: false,
  setShowSettings: fn,
  activeTab: 'all-sites',
  selectedVideo: { url: 'https://example.test/fresh-url', source: 'all-sites' },
  setSelectedVideo: fn,
  uploadedFile: null,
  setUploadedFile: fn,
  apiKeysSet: { gemini: true },
  setApiKeysSet: fn,
  isAppReady: true,
  isGenerating: false,
  isDownloading: false,
  downloadProgress: 0,
  currentDownloadId: null,
  isRetrying: false,
  isSrtOnlyMode: false,
  setIsSrtOnlyMode: fn,
  showVideoAnalysis: false,
  setShowVideoAnalysis: fn,
  videoAnalysisResult: null,
  setVideoAnalysisResult: fn,
  segmentsStatus: [],
  videoSegments: [],
  showRulesEditor: false,
  setShowRulesEditor: fn,
  userProvidedSubtitles: '',
  useUserProvidedSubtitles: false,
  transcriptionRules: null,
  subtitlesData: null,
  setSubtitlesData: fn,
  status: {},
  setStatus: fn,
  timeFormat: 'seconds',
  showWaveformLongVideos: false,
  useOptimizedPreview: false,
  enableYoutubeSearch: false,
  optimizeVideos: false,
  optimizedResolution: '720p',
  retryingSegments: [],
  retrySegment: vi.fn(),
  isUploading: false,
  selectedSegment: null,
  setSelectedSegment: fn,
  showProcessingModal: false,
  setShowProcessingModal: fn,
  uploadedFileData: null,
  setUploadedFileData: fn,
  isProcessingSegment: false,
  setIsRetrying: fn,
  setIsProcessingSegment: fn,
});

const appHandlers = {
  validateInput: () => true,
  handleSrtUpload: fn,
  handleGenerateSubtitles: fn,
  handleCancelDownload: fn,
  handleTabChange: fn,
  saveApiKeys: fn,
  handleSegmentSelect: fn,
  handleProcessWithOptions: fn,
};

const modalHandlers = {
  handleUseRecommendedPreset: fn,
  handleUseDefaultPreset: fn,
  handleEditRules: fn,
  handleSaveRules: fn,
  handleViewRules: fn,
  handleUserSubtitlesAdd: fn,
  handleAbortVideoAnalysis: fn,
};

test('fresh URL App layout owns a checkpoint listener before conditional output UI exists', async () => {
  localStorage.clear();
  localStorage.setItem('current_video_url', 'https://example.test/fresh-url');
  mocks.flush.mockResolvedValue(undefined);
  const { container, unmount } = render(<AppLayout
    appState={appState()}
    appHandlers={appHandlers}
    modalHandlers={modalHandlers}
    t={(_key, fallback) => fallback}
  />);

  expect(container.querySelector('.output-container')).toBeNull();
  await expect(checkpointBeforeUpdate({
    source: 'auto-generation-start',
    runId: 'fresh-url-run',
    signal: new AbortController().signal,
  }, 100)).resolves.toBeUndefined();
  expect(mocks.flush).toHaveBeenCalledTimes(1);
  unmount();
});
