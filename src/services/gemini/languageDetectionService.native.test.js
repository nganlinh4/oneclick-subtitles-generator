import { detectSubtitleLanguage } from './languageDetectionService';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';

const projectMocks = vi.hoisted(() => ({
  load: vi.fn(),
  capture: vi.fn(),
  persist: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../../platform/nativeGeminiText', () => ({
  runNativeGeminiText: vi.fn(),
}));
vi.mock('../../platform/projectSubtitleLanguageStore', async (importOriginal) => ({
  ...(await importOriginal()),
  loadProjectSubtitleLanguage: projectMocks.load,
  captureProjectSubtitleLanguage: projectMocks.capture,
  persistProjectSubtitleLanguage: projectMocks.persist,
  acknowledgeProjectSubtitleLanguage: projectMocks.acknowledge,
}));

const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000501';
const DELIVERY_ID = '01890f39-7b62-7c4e-8c9a-000000000502';
const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000503';
const delivery = (text) => ({
  text,
  job: { id: JOB_ID },
  deliveryId: DELIVERY_ID,
  acknowledge: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  localStorage.clear();
  runNativeGeminiText.mockReset();
  projectMocks.load.mockReset().mockResolvedValue(null);
  projectMocks.capture.mockReset().mockResolvedValue({
    projectId: PROJECT_ID,
    projectStateVersion: 4,
  });
  projectMocks.persist.mockReset().mockImplementation(async (_context, provider) => ({
    result: provider.result,
  }));
  projectMocks.acknowledge.mockReset().mockImplementation(async (receipt) => receipt);
  global.fetch = vi.fn(() => {
    throw new Error('native language detection must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
});

test('native language detection uses structured Rust Gemini output', async () => {
  const completed = vi.fn();
  const failed = vi.fn();
  window.addEventListener('language-detection-complete', completed);
  window.addEventListener('language-detection-error', failed);
  runNativeGeminiText.mockResolvedValue(delivery(JSON.stringify({
      languageCode: 'ko',
      languageName: 'Korean',
      isMultiLanguage: false,
      secondaryLanguages: [],
    })));

  await expect(detectSubtitleLanguage([
    { text: '안녕하세요' },
  ], 'original', 'gemini-3.5-flash-lite')).resolves.toEqual({
    languageCode: 'ko',
    languageName: 'Korean',
    isMultiLanguage: false,
    secondaryLanguages: [],
  });
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'analyzeSubtitles',
    model: 'gemini-3.5-flash-lite',
    responseJsonSchema: expect.objectContaining({ type: 'object' }),
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 4,
  }));
  expect(global.fetch).not.toHaveBeenCalled();
  expect(completed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    detail: expect.objectContaining({ source: 'original' }),
  }));
  expect(failed).not.toHaveBeenCalled();
  window.removeEventListener('language-detection-complete', completed);
  window.removeEventListener('language-detection-error', failed);
});

test('native provider failure returns null and emits an error without fake completion', async () => {
  const completed = vi.fn();
  const failed = vi.fn();
  window.addEventListener('language-detection-complete', completed);
  window.addEventListener('language-detection-error', failed);
  runNativeGeminiText.mockRejectedValue(new Error('native failure'));

  await expect(detectSubtitleLanguage([
    { text: 'unknown' },
  ], 'original', 'gemini-3.5-flash-lite')).resolves.toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    detail: { error: 'native failure', source: 'original' },
  }));
  window.removeEventListener('language-detection-complete', completed);
  window.removeEventListener('language-detection-error', failed);
});

test.each([
  ['not JSON'],
  [JSON.stringify({ languageCode: '', languageName: 'Unknown', isMultiLanguage: false })],
  [JSON.stringify({ languageCode: 'ko', languageName: '', isMultiLanguage: false })],
])('malformed provider result returns null and never emits completion: %s', async (text) => {
  const completed = vi.fn();
  const failed = vi.fn();
  window.addEventListener('language-detection-complete', completed);
  window.addEventListener('language-detection-error', failed);
  runNativeGeminiText.mockResolvedValue(delivery(text));

  await expect(detectSubtitleLanguage([
    { text: 'sample' },
  ], 'translated')).resolves.toBeNull();

  expect(completed).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
  expect(failed.mock.calls[0][0].detail.source).toBe('translated');
  window.removeEventListener('language-detection-complete', completed);
  window.removeEventListener('language-detection-error', failed);
});

test.each([
  [null],
  [[]],
  [[{ text: '   ' }]],
  [[{ missingText: true }]],
])('empty or malformed subtitles fail closed without invoking the provider: %j', async (subtitles) => {
  const completed = vi.fn();
  const failed = vi.fn();
  window.addEventListener('language-detection-complete', completed);
  window.addEventListener('language-detection-error', failed);

  await expect(detectSubtitleLanguage(subtitles, 'original')).resolves.toBeNull();

  expect(runNativeGeminiText).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledTimes(1);
  window.removeEventListener('language-detection-complete', completed);
  window.removeEventListener('language-detection-error', failed);
});
