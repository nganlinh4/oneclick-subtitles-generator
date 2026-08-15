import { fireEvent, render, screen } from '@testing-library/react';
import GeminiNarrationResults from './GeminiNarrationResults';

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
        <div data-testid="virtual-list">
          {Array.from({ length: itemCount }, (_, index) => (
            <Row key={index} index={index} style={{}} data={itemData} />
          ))}
        </div>
      );
    }),
  };
});
vi.mock('./GeminiResultRow', () => ({
  default: ({ index, data }) => (
    <button
      data-testid={`row-action-${index}`}
      disabled={data.isServiceAvailable !== true}
      onClick={() => data.onRetry?.(data.generationResults[index].subtitle_id)}
    >
      row action
    </button>
  ),
}));
vi.mock('../hooks/useGeminiAudioSpeed', () => ({
  default: () => ({
    modifyAudioSpeed: vi.fn(),
    modifySingleAudioEditCombined: vi.fn(),
    fetchDurationsBatch: vi.fn(),
  }),
}));
vi.mock('../../../utils/mediaId', () => ({ getCurrentMediaId: () => null }));
vi.mock('../../../utils/functionalScrollbar', () => ({}));

const results = [
  { subtitle_id: 1, text: 'Pending', success: false, pending: true },
  { subtitle_id: 2, text: 'Failed', success: false, pending: false },
];

const makeProps = (overrides = {}) => ({
  generationResults: results,
  onRetry: vi.fn(),
  retryingSubtitleId: null,
  onRetryFailed: vi.fn(),
  onGenerateAllPending: vi.fn(),
  subtitleSource: 'original',
  serviceUnavailableMessage: 'Gemini needs a usable API key.',
  ...overrides,
});

beforeEach(() => {
  window.addToast = vi.fn();
});

afterEach(() => {
  delete window.addToast;
  vi.clearAllMocks();
});

it('fails bulk and row retry controls closed when availability is omitted', () => {
  const props = makeProps();
  render(<GeminiNarrationResults {...props} />);

  const pending = screen.getByRole('button', { name: /Generate All Pending/u });
  const failed = screen.getByRole('button', { name: /Retry Failed Narrations/u });
  expect(pending).toBeDisabled();
  expect(failed).toBeDisabled();
  expect(pending).toHaveAttribute('title', 'Gemini needs a usable API key.');
  expect(screen.getByTestId('row-action-0')).toBeDisabled();

  fireEvent.click(pending);
  fireEvent.click(failed);
  fireEvent.click(screen.getByTestId('row-action-0'));
  expect(props.onGenerateAllPending).not.toHaveBeenCalled();
  expect(props.onRetryFailed).not.toHaveBeenCalled();
  expect(props.onRetry).not.toHaveBeenCalled();
});

it('stops every retry path after Gemini availability drops', () => {
  const props = makeProps({ isServiceAvailable: true });
  const { rerender } = render(<GeminiNarrationResults {...props} />);

  fireEvent.click(screen.getByRole('button', { name: /Generate All Pending/u }));
  fireEvent.click(screen.getByRole('button', { name: /Retry Failed Narrations/u }));
  fireEvent.click(screen.getByTestId('row-action-0'));
  expect(props.onGenerateAllPending).toHaveBeenCalledTimes(1);
  expect(props.onRetryFailed).toHaveBeenCalledTimes(1);
  expect(props.onRetry).toHaveBeenCalledTimes(1);

  rerender(<GeminiNarrationResults {...props} isServiceAvailable={false} />);
  const pending = screen.getByRole('button', { name: /Generate All Pending/u });
  const failed = screen.getByRole('button', { name: /Retry Failed Narrations/u });
  expect(pending).toBeDisabled();
  expect(failed).toBeDisabled();
  expect(screen.getByTestId('row-action-0')).toBeDisabled();

  fireEvent.click(pending);
  fireEvent.click(failed);
  fireEvent.click(screen.getByTestId('row-action-0'));
  expect(props.onGenerateAllPending).toHaveBeenCalledTimes(1);
  expect(props.onRetryFailed).toHaveBeenCalledTimes(1);
  expect(props.onRetry).toHaveBeenCalledTimes(1);
});
