import { fireEvent, render, screen } from '@testing-library/react';
import NarrationResults from './NarrationResults';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('react-window', async () => {
  const ReactModule = await import('react');
  return {
    VariableSizeList: ReactModule.forwardRef(({
      children: Row,
      itemCount,
      itemData,
    }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({ resetAfterIndex: vi.fn() }));
      return (
        <div>
          {Array.from({ length: itemCount }, (_, index) => (
            <Row key={index} index={index} style={{}} data={itemData} />
          ))}
        </div>
      );
    }),
  };
});
vi.mock('./ResultRow', () => ({
  default: ({ index, data }) => (
    <button
      data-testid={`row-retry-${index}`}
      disabled={data.retryAvailable !== true}
      title={data.retryBlockedReason}
      onClick={() => {
        if (data.retryAvailable === true) {
          data.onRetry?.(data.generationResults[index].subtitle_id);
        }
      }}
    >
      retry row
    </button>
  ),
}));
vi.mock('../hooks/useNarrationAudioSpeed', () => ({
  default: () => ({
    itemDurations: {},
    fetchDurationsBatch: vi.fn(),
    speedValue: 1,
    setSpeedValue: vi.fn(),
    isProcessing: false,
    processingProgress: { current: 0, total: 0 },
    itemSpeeds: {},
    setItemSpeed: vi.fn(),
    itemProcessing: {},
    itemTrims: {},
    setItemTrim: vi.fn(),
    modifyAudioSpeed: vi.fn(),
    modifySingleAudioEditCombined: vi.fn(),
  }),
}));
vi.mock('../utils/narrationAudioDownload', () => ({
  downloadAudio: vi.fn(),
}));
vi.mock('../../../utils/functionalScrollbar', () => ({}));

const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const generationResults = [
  { subtitle_id: 1, text: 'Pending', pending: true, success: false },
  { subtitle_id: 2, text: 'Failed', pending: false, success: false },
];

const makeProps = (overrides = {}) => ({
  generationResults,
  playAudio: vi.fn(),
  currentAudio: null,
  isPlaying: false,
  onRetry: vi.fn(),
  retryingSubtitleId: null,
  onRetryFailed: vi.fn(),
  onGenerateAllPending: vi.fn(),
  subtitleSource: 'original',
  isServiceAvailable: true,
  narrationMethod: 'f5tts',
  referenceAudio: { nativeArtifactId: REFERENCE_ID },
  ...overrides,
});

afterEach(() => vi.clearAllMocks());

it('keeps bulk and row retries enabled for a nativeArtifactId-only reference', () => {
  const props = makeProps();
  render(<NarrationResults {...props} />);

  const pending = screen.getByRole('button', { name: /Generate All Pending/u });
  const failed = screen.getByRole('button', { name: /Retry Failed Narrations/u });
  expect(pending).toBeEnabled();
  expect(failed).toBeEnabled();
  expect(screen.getByTestId('row-retry-0')).toBeEnabled();

  fireEvent.click(pending);
  fireEvent.click(failed);
  fireEvent.click(screen.getByTestId('row-retry-0'));
  expect(props.onGenerateAllPending).toHaveBeenCalledTimes(1);
  expect(props.onRetryFailed).toHaveBeenCalledTimes(1);
  expect(props.onRetry).toHaveBeenCalledWith(1);
});

it('blocks every retry path when the native reference capability is missing', () => {
  const props = makeProps({ referenceAudio: { url: 'blob:legacy-reference' } });
  render(<NarrationResults {...props} />);

  const pending = screen.getByRole('button', { name: /Generate All Pending/u });
  const failed = screen.getByRole('button', { name: /Retry Failed Narrations/u });
  const row = screen.getByTestId('row-retry-0');
  expect(pending).toBeDisabled();
  expect(failed).toBeDisabled();
  expect(row).toBeDisabled();
  expect(pending.getAttribute('title')).toContain('reference audio');

  fireEvent.click(pending);
  fireEvent.click(failed);
  fireEvent.click(row);
  expect(props.onGenerateAllPending).not.toHaveBeenCalled();
  expect(props.onRetryFailed).not.toHaveBeenCalled();
  expect(props.onRetry).not.toHaveBeenCalled();
});
