import { fireEvent, render, screen } from '@testing-library/react';
import ResultRow from './ResultRow';

vi.mock('../../common/SliderWithValue', () => ({ default: () => <div /> }));
vi.mock('../../common/StandardSlider', () => ({ default: () => <div /> }));
vi.mock('../../common/LoadingIndicator', () => ({ default: () => <span>loading</span> }));
vi.mock('../../common/HelpIcon', () => ({ default: () => <span>help</span> }));

const dataFor = (result, overrides = {}) => ({
  generationResults: [result],
  onRetry: vi.fn(),
  retryingSubtitleId: null,
  currentAudio: null,
  isPlaying: false,
  playAudio: vi.fn(),
  downloadAudio: vi.fn(),
  itemDurations: {},
  itemTrims: {},
  setItemTrim: vi.fn(),
  itemSpeeds: {},
  setItemSpeed: vi.fn(),
  modifySingleAudioEditCombined: vi.fn(),
  itemProcessing: {},
  retryAvailable: false,
  retryBlockedReason: 'A native reference is required.',
  t: (_key, fallback) => fallback,
  ...overrides,
});

const cases = [
  ['pending', { subtitle_id: 1, text: 'Pending', success: false, pending: true }],
  ['failed', { subtitle_id: 2, text: 'Failed', success: false, pending: false }],
  ['successful', { subtitle_id: 3, text: 'Ready', success: true, pending: false, filename: 'voice.wav' }],
];

afterEach(() => vi.clearAllMocks());

it.each(cases)('fails the %s row retry closed when generation prerequisites are missing', (_name, result) => {
  const data = dataFor(result);
  render(<ResultRow index={0} style={{}} data={data} />);

  const retry = screen.getByTitle('A native reference is required.');
  expect(retry).toBeDisabled();
  fireEvent.click(retry);
  expect(data.onRetry).not.toHaveBeenCalled();
});

it.each(cases)('allows the %s row retry when every prerequisite is authoritative', (_name, result) => {
  const data = dataFor(result, { retryAvailable: true, retryBlockedReason: '' });
  render(<ResultRow index={0} style={{}} data={data} />);

  const title = result.pending ? 'Generate this narration' : 'Retry generation';
  fireEvent.click(screen.getByTitle(title));
  expect(data.onRetry).toHaveBeenCalledWith(result.subtitle_id);
});
