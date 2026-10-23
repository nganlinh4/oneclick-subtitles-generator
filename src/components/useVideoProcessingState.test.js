import { act, renderHook } from '@testing-library/react';

import useVideoProcessingState from './useVideoProcessingState';

const rules = vi.hoisted(() => ({ available: true }));

vi.mock('./useModalHeight', () => ({ default: () => ({ modalRef: null, contentRef: null }) }));
vi.mock('./useTokenCounting', () => ({
  default: () => ({ realTokenCount: null, displayTokens: 0, isCountingTokens: false }),
}));
vi.mock('./useTranscriptionRulesAvailability', () => ({ default: () => rules.available }));
vi.mock('./runVideoProcess', () => ({ default: vi.fn() }));
vi.mock('../utils/toastUtils', () => ({ showInfoToast: vi.fn() }));

const SEGMENT = Object.freeze({ start: 10, end: 20 });
const NEIGHBOURS = Object.freeze([
  { start: 0, end: 5, text: 'before' },
  { start: 25, end: 30, text: 'after' },
]);

const renderState = (props = {}) => renderHook((current) => useVideoProcessingState({
  isOpen: true,
  onClose: vi.fn(),
  isUploading: false,
  videoFile: { type: 'video/mp4' },
  userProvidedSubtitles: '',
  useUserProvidedSubtitles: false,
  subtitlesData: [],
  onSelectedSegmentChange: vi.fn(),
  selectedSegment: SEGMENT,
  onProcess: vi.fn(),
  transcribeOptions: null,
  ...current,
}), { initialProps: props });

beforeEach(() => {
  localStorage.clear();
  rules.available = true;
});

test('unavailable outside context is off for the run but never overwrites the stored choice', () => {
  const { result, rerender } = renderState({ subtitlesData: [] });

  expect(result.current.outsideContextAvailable).toBe(false);
  expect(result.current.useOutsideResultsContext).toBe(false);
  expect(localStorage.getItem('video_processing_use_outside_context')).toBeNull();

  rerender({ subtitlesData: NEIGHBOURS, isOpen: false });
  expect(result.current.useOutsideResultsContext).toBe(true);
});

test('timing generation runs without auto-split and leaves the stored settings alone', () => {
  localStorage.setItem('video_processing_prompt_preset', 'describe-video');
  const { result, rerender } = renderState({
    userProvidedSubtitles: 'line one',
    useUserProvidedSubtitles: true,
  });

  expect(result.current.selectedPromptPreset).toBe('timing-generation');
  expect(result.current.autoSplitSubtitles).toBe(false);
  expect(localStorage.getItem('show_favorite_max_length')).toBeNull();
  expect(localStorage.getItem('video_processing_prompt_preset')).toBe('describe-video');

  rerender({ userProvidedSubtitles: '', useUserProvidedSubtitles: false });
  expect(result.current.selectedPromptPreset).toBe('describe-video');
  expect(result.current.autoSplitSubtitles).toBe(true);
});

test('turning auto-split on during timing generation is an explicit, stored choice', () => {
  localStorage.setItem('show_favorite_max_length', 'false');
  const { result } = renderState({ userProvidedSubtitles: 'line', useUserProvidedSubtitles: true });

  act(() => { result.current.handleAutoSplitToggle(true); });

  expect(result.current.autoSplitSubtitles).toBe(true);
  expect(localStorage.getItem('show_favorite_max_length')).toBe('true');
});

test('a stored timing-generation preset falls back to Settings without subtitles', () => {
  localStorage.setItem('video_processing_prompt_preset', 'timing-generation');
  const { result } = renderState();

  expect(result.current.selectedPromptPreset).toBe('settings');
  expect(localStorage.getItem('video_processing_prompt_preset')).toBe('timing-generation');
});

test('unavailable transcription rules do not erase the stored rules toggle', () => {
  localStorage.setItem('video_processing_use_transcription_rules', 'true');
  rules.available = false;
  const { result } = renderState();

  expect(result.current.useTranscriptionRules).toBe(false);
  expect(localStorage.getItem('video_processing_use_transcription_rules')).toBe('true');
});

test('max words has one default and follows a Settings change in this window', () => {
  const { result } = renderState();
  expect(result.current.maxWordsPerSubtitle).toBe(12);

  localStorage.setItem('video_processing_max_words', 'garbage');
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key: 'video_processing_max_words' }));
  });
  expect(result.current.maxWordsPerSubtitle).toBe(12);

  act(() => { result.current.setMaxWordsPerSubtitle(8); });
  expect(result.current.maxWordsPerSubtitle).toBe(8);
  expect(localStorage.getItem('video_processing_max_words')).toBe('8');
});

test('the old Gemini method is the inline-extraction one', () => {
  const { result } = renderState();
  expect(result.current.inlineExtraction).toBe(false);

  act(() => { result.current.setMethod('old'); });
  expect(result.current.method).toBe('old');
  expect(result.current.inlineExtraction).toBe(true);
  expect(localStorage.getItem('video_processing_inline_extraction')).toBeNull();
});
