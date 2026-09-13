import { fireEvent, render, screen } from '@testing-library/react';
import GeminiResultRow from './GeminiResultRow';

vi.mock('../../common/SliderWithValue', () => ({
  default: () => <div data-testid="speed-slider" />,
}));
vi.mock('../../common/StandardSlider', () => ({
  default: () => <div data-testid="trim-slider" />,
}));
vi.mock('../../common/LoadingIndicator', () => ({
  default: () => <span>loading</span>,
}));

const makeData = (item, overrides = {}) => ({
  generationResults: [item],
  onRetry: vi.fn(),
  retryingSubtitleId: null,
  currentlyPlaying: null,
  isPlaying: false,
  playAudio: vi.fn(),
  downloadAudio: vi.fn(),
  subtitleSource: 'original',
  itemTrims: {},
  setItemTrim: vi.fn(),
  itemSpeeds: {},
  setItemSpeed: vi.fn(),
  modifySingleAudioEditCombined: vi.fn(),
  itemProcessing: {},
  itemDurations: {},
  t: (_key, fallback) => fallback,
  serviceUnavailableMessage: 'Start this engine before retrying.',
  ...overrides,
});

const rowCases = [
  ['successful', { subtitle_id: 1, text: 'Ready', success: true, filename: 'ready.wav' }, 'Retry generation'],
  ['pending', { subtitle_id: 2, text: 'Pending', success: false, pending: true }, 'Generate this narration'],
  ['failed', { subtitle_id: 3, text: 'Failed', success: false, pending: false }, 'Retry generation'],
];

it.each([
  ['succeeded', rowCases[0][1]],
  ['pending', rowCases[1][1]],
  ['failed', rowCases[2][1]],
])('publishes the shared %s narration result state', (state, item) => {
  const { container } = render(
    <GeminiResultRow index={0} style={{}} data={makeData(item, { isServiceAvailable: true })} />
  );
  expect(container.firstChild).toHaveAttribute('data-narration-result-state', state);
});

it.each(rowCases)('blocks the %s row action after Gemini becomes unavailable', (_name, item) => {
  const data = makeData(item, { isServiceAvailable: false });
  render(<GeminiResultRow index={0} style={{}} data={data} />);

  const retry = screen.getByTitle('Start this engine before retrying.');
  expect(retry).toBeDisabled();
  fireEvent.click(retry);
  expect(data.onRetry).not.toHaveBeenCalled();
});

it.each(rowCases)('allows the %s row action only while Gemini is available', (_name, item, title) => {
  const data = makeData(item, { isServiceAvailable: true });
  render(<GeminiResultRow index={0} style={{}} data={data} />);

  fireEvent.click(screen.getByTitle(title));
  expect(data.onRetry).toHaveBeenCalledWith(item.subtitle_id);
});
