// Orchestration logic owned by useUnifiedNarration itself: source selection, project-result
// presentation and the subtitle list handed to the generation handlers. The per-concern hooks it
// composes have their own tests and are stubbed here.
import { act, renderHook } from '@testing-library/react';
import useUnifiedNarration from './useUnifiedNarration';

const mocks = vi.hoisted(() => ({
  handlersParams: null,
  nativeHandlers: { handleGeminiNarration: () => 'gemini', cancelGTTSGeneration: () => 'gtts' },
  projectResults: {
    original: [{ subtitle_id: 1, text: 'original result' }],
    translated: [{ subtitle_id: 1, text: 'translated result' }],
    grouped: [{ subtitle_id: 1, text: 'grouped result' }],
  },
}));

vi.mock('./useAvailabilityCheck', () => ({ default: () => ({ geminiUnavailableReason: null }) }));
vi.mock('./useAudioPlayback', () => ({ default: () => ({ audioRef: { current: null }, handleAudioEnded: vi.fn() }) }));
vi.mock('./useNarrationStorage', () => ({ default: () => undefined }));
vi.mock('./useUIEffects', () => ({ default: () => undefined }));
vi.mock('./useNarrationCache', () => ({ default: () => undefined }));
vi.mock('./useWindowStateManager', () => ({ default: () => undefined }));
vi.mock('./useNativeNarrationController', () => ({ default: () => mocks.nativeHandlers }));
vi.mock('./useNarrationEffects', () => ({
  default: () => undefined,
  createSetReferenceTextWithCache: () => vi.fn(),
}));
vi.mock('./useNarrationHandlers', () => ({
  default: (params) => {
    mocks.handlersParams = params;
    return {};
  },
}));
vi.mock('../../../platform/projectNarrationState', () => ({
  getCurrentProjectNarrationResults: (source) => mocks.projectResults[source] ?? [],
}));

const original = [{ id: 1, start: 0, end: 1, text: 'hello' }];
const translated = [{ id: 1, start: 0, end: 1, text: 'xin chao' }];
const t = (_key, fallback) => fallback;

const renderNarration = (props = {}) => renderHook(
  (current) => useUnifiedNarration({
    subtitles: original,
    originalSubtitles: original,
    translatedSubtitles: null,
    t,
    fileInputRef: { current: null },
    mediaRecorderRef: { current: null },
    audioChunksRef: { current: [] },
    statusRef: { current: null },
    sectionRef: { current: null },
    ...current,
  }),
  { initialProps: props },
);

beforeEach(() => {
  mocks.handlersParams = null;
});

test('a translated source preference falls back to original when no translation exists', () => {
  const { result } = renderNarration();

  act(() => result.current.setSubtitleSource('translated'));

  expect(result.current.subtitleSource).toBe('original');
});

test('switching source presents that source\'s project results without renaming rows', () => {
  const { result } = renderNarration({ translatedSubtitles: translated });
  expect(result.current.generationResults).toEqual([]);

  act(() => result.current.setSubtitleSource('translated'));
  expect(result.current.subtitleSource).toBe('translated');
  expect(result.current.generationResults).toEqual(mocks.projectResults.translated);
  expect(result.current.generationResults).not.toBe(mocks.projectResults.translated);

  act(() => result.current.setSubtitleSource('original'));
  expect(result.current.generationResults).toEqual(mocks.projectResults.original);
});

test('grouped subtitles take precedence as the presented and generated source', () => {
  const grouped = [{ id: 1, start: 0, end: 2, text: 'hello world' }];
  const { result } = renderNarration({ translatedSubtitles: translated });

  act(() => {
    result.current.setGroupedSubtitles(grouped);
    result.current.setUseGroupedSubtitles(true);
  });

  expect(result.current.generationResults).toEqual(mocks.projectResults.grouped);
  expect(mocks.handlersParams.getSelectedSubtitles()).toBe(grouped);
});

test('generation handlers receive the subtitles of the selected source', () => {
  const { result, rerender } = renderNarration({ translatedSubtitles: translated });
  expect(mocks.handlersParams.getSelectedSubtitles()).toBe(original);

  act(() => result.current.setSubtitleSource('translated'));
  expect(mocks.handlersParams.getSelectedSubtitles()).toBe(translated);

  rerender({ originalSubtitles: null, translatedSubtitles: translated });
  act(() => result.current.setSubtitleSource('original'));
  expect(mocks.handlersParams.getSelectedSubtitles()).toBe(original);
});

test('native method handlers are exposed under their method names', () => {
  const { result } = renderNarration();

  expect(result.current.handleGeminiNarration).toBe(mocks.nativeHandlers.handleGeminiNarration);
  expect(result.current.cancelGTTSGeneration).toBe(mocks.nativeHandlers.cancelGTTSGeneration);
});
