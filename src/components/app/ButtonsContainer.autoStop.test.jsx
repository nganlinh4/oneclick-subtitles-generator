import { fireEvent, render, screen } from '@testing-library/react';

import { abortAllRequests } from '../../services/geminiService';
import { publishProcessingRanges } from '../../events/bus';
import useAutoGenerateFlow from './hooks/useAutoGenerateFlow';
import ButtonsContainer from './ButtonsContainer';

const mocks = vi.hoisted(() => ({
  autoState: null,
  stopAutoFlow: vi.fn(),
}));

vi.mock('../../services/geminiService', () => ({ abortAllRequests: vi.fn(() => true) }));
vi.mock('../../events/bus', () => ({ publishProcessingRanges: vi.fn() }));
vi.mock('./hooks/useAutoGenerateFlow', () => ({ default: vi.fn(() => mocks.autoState) }));
vi.mock('./utils/srtUploadState', () => ({
  useSrtUploadState: () => ({
    uploadedSrtInfo: { hasUploaded: false, fileName: '' },
    handleSrtUploadWithState: vi.fn(),
    handleSrtClear: vi.fn(),
  }),
}));
vi.mock('../../utils/videoUtils', () => ({ hasValidDownloadedVideo: () => false }));
vi.mock('../SrtUploadButton', () => ({ default: () => null }));
vi.mock('../AddSubtitlesButton', () => ({ default: () => null }));
vi.mock('../VideoAnalysisButton', () => ({ default: () => null }));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('../common/WavyProgressIndicator', () => ({ default: () => null }));
vi.mock('../common/Tooltip', () => ({ default: ({ children }) => children }));

const baseProps = () => ({
  handleSrtUpload: vi.fn(),
  handleGenerateSubtitles: vi.fn(),
  handleProcessWithOptions: vi.fn(),
  handleCancelDownload: vi.fn(),
  handleUserSubtitlesAdd: vi.fn(),
  handleAbortVideoAnalysis: vi.fn(),
  validateInput: () => true,
  isGenerating: true,
  isDownloading: true,
  downloadProgress: 25,
  currentDownloadId: 'manual-download',
  isRetrying: true,
  setIsRetrying: vi.fn(),
  retryingSegments: [],
  segmentsStatus: [],
  subtitlesData: [],
  setSubtitlesData: vi.fn(),
  status: {},
  userProvidedSubtitles: '',
  selectedVideo: { url: 'https://example.test/video' },
  uploadedFile: null,
  uploadedFileData: null,
  isSrtOnlyMode: false,
  t: (_key, fallback) => fallback,
  onGenerateBackground: vi.fn(),
  isProcessingSegment: true,
  setIsProcessingSegment: vi.fn(),
  apiKeysSet: { gemini: true },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.autoState = {
    isAutoGenerating: true,
    autoFlowStep: 'processing',
    autoFlowActiveRef: { current: true },
    startAutoGenerateFlow: vi.fn(),
    stopAutoFlow: mocks.stopAutoFlow,
  };
  useAutoGenerateFlow.mockImplementation(() => mocks.autoState);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

test('automatic Force Stop cancels only its owned run despite hostile coexisting manual state', () => {
  const props = baseProps();
  render(<ButtonsContainer {...props} />);

  fireEvent.click(screen.getByTitle('Force stop all Gemini requests'));

  expect(mocks.stopAutoFlow).toHaveBeenCalledTimes(1);
  expect(abortAllRequests).not.toHaveBeenCalled();
  expect(props.handleCancelDownload).not.toHaveBeenCalled();
  expect(props.handleAbortVideoAnalysis).not.toHaveBeenCalled();
  expect(props.setIsRetrying).not.toHaveBeenCalled();
  expect(props.setIsProcessingSegment).not.toHaveBeenCalled();
  expect(publishProcessingRanges).not.toHaveBeenCalled();
});

test('manual Force Stop retains the existing global cancellation behavior', () => {
  mocks.autoState = {
    ...mocks.autoState,
    isAutoGenerating: false,
    autoFlowActiveRef: { current: false },
  };
  const props = baseProps();
  render(<ButtonsContainer {...props} />);

  fireEvent.click(screen.getByTitle('Force stop all Gemini requests'));

  expect(mocks.stopAutoFlow).not.toHaveBeenCalled();
  expect(abortAllRequests).toHaveBeenCalledTimes(1);
  expect(props.handleCancelDownload).toHaveBeenCalledTimes(1);
  expect(props.handleAbortVideoAnalysis).toHaveBeenCalledTimes(1);
  expect(props.setIsRetrying).toHaveBeenCalledWith(false);
  expect(props.setIsProcessingSegment).toHaveBeenCalledWith(false);
  expect(publishProcessingRanges).toHaveBeenCalledWith({ ranges: [] });
});
