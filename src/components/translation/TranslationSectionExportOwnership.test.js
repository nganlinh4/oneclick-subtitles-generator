import { act, fireEvent, render, screen } from '@testing-library/react';
import TranslationSection from './index';

const mocks = vi.hoisted(() => ({
  translationState: vi.fn(),
  actionProps: null,
  completeProps: null,
  bulkDownloadAll: vi.fn(),
  bulkDownloadZip: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../../hooks/useTranslationState', () => ({
  default: (...args) => mocks.translationState(...args),
}));

vi.mock('../../hooks/useLanguageChain', () => ({
  default: () => ({
    chainItems: [],
    addLanguage: vi.fn(),
    addOriginalLanguage: vi.fn(),
    addDelimiter: vi.fn(),
    removeItem: vi.fn(),
    updateLanguage: vi.fn(),
    updateDelimiter: vi.fn(),
    moveItem: vi.fn(),
    getLanguageValues: () => [],
    getDelimiterValues: () => [],
    hasValidLanguage: () => true,
    hasOnlyOriginalLanguage: () => true,
  }),
}));

vi.mock('./hooks/usePostSplitSubtitles', () => ({
  default: ({ translatedSubtitles }) => ({
    postSplitMaxWords: 31,
    setPostSplitMaxWords: vi.fn(),
    presentedSubtitles: translatedSubtitles,
  }),
}));

vi.mock('./utils/downloadUtils', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    generateFilename: vi.fn(() => 'captions'),
    getNamingInfo: vi.fn(() => ({
      sourceSubtitleName: '',
      videoName: 'video',
      targetLanguages: [],
    })),
    handleDownload: vi.fn(),
    handleBulkDownloadAll: (...args) => mocks.bulkDownloadAll(...args),
    handleBulkDownloadZip: (...args) => mocks.bulkDownloadZip(...args),
  };
});

vi.mock('../../services/geminiService', () => ({
  completeDocument: vi.fn(),
  summarizeDocument: vi.fn(),
}));
vi.mock('../../utils/fileUtils', () => ({ downloadTextDocument: vi.fn() }));
vi.mock('./handlers/retryHandlers', () => ({ handleRetrySegment: vi.fn() }));

vi.mock('./TranslationActions', () => ({
  default: (props) => {
    mocks.actionProps = props;
    return <button type="button" onClick={props.onDownloadAll}>actions export</button>;
  },
}));

vi.mock('./TranslationComplete', () => ({
  default: (props) => {
    mocks.completeProps = props;
    return <button type="button" onClick={props.onDownloadAll}>complete export</button>;
  },
}));

vi.mock('./TranslationHeader', () => ({ default: () => null }));
vi.mock('./LanguageChain', () => ({ default: () => null }));
vi.mock('./ModelSelection', () => ({ default: () => null }));
vi.mock('./SplitDurationSlider', () => ({ default: () => null }));
vi.mock('./RestTimeSlider', () => ({ default: () => null }));
vi.mock('./RulesToggle', () => ({ default: () => null }));
vi.mock('./TranslationPromptEditorButton', () => ({ default: () => null }));
vi.mock('./TranslationStatus', () => ({ default: () => null }));
vi.mock('./TranslationError', () => ({ default: () => null }));
vi.mock('./TranslationPreview', () => ({ default: () => null }));
vi.mock('./BulkTranslationPreview', () => ({ default: () => null }));
vi.mock('../common/SliderWithValue', () => ({ default: () => null }));
vi.mock('../common/HelpIcon', () => ({ default: () => null }));

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const buildTranslationState = (translatedSubtitles) => ({
  isTranslating: false,
  translatedSubtitles,
  error: null,
  translationStatus: '',
  selectedModel: 'model',
  customTranslationPrompt: '',
  splitDuration: 0,
  restTime: 0,
  includeRules: false,
  rulesAvailable: false,
  hasUserProvidedSubtitles: false,
  loadedFromCache: false,
  handleModelSelect: vi.fn(),
  handleSavePrompt: vi.fn(),
  handleTranslate: vi.fn(),
  handleCancelTranslation: vi.fn(),
  handleReset: vi.fn(),
  handleSplitDurationChange: vi.fn(),
  handleRestTimeChange: vi.fn(),
  handleIncludeRulesChange: vi.fn(),
  retryMainTranslation: vi.fn(),
  bulkFiles: [],
  setBulkFiles: vi.fn(),
  bulkTranslations: [{ success: true }],
  setBulkTranslations: vi.fn(),
  isBulkTranslating: false,
  handleBulkFileRemoval: vi.fn(),
  handleBulkFilesRemovalAll: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actionProps = null;
  mocks.completeProps = null;
});

test.each([
  { translatedSubtitles: null, buttonName: 'actions export', propsKey: 'actionProps' },
  {
    translatedSubtitles: [{ start: 0, end: 1, text: 'translated' }],
    buttonName: 'complete export',
    propsKey: 'completeProps',
  },
])('wires the shared synchronous export owner through $buttonName', async ({
  translatedSubtitles,
  buttonName,
  propsKey,
}) => {
  const pending = deferred();
  mocks.translationState.mockReturnValue(buildTranslationState(translatedSubtitles));
  mocks.bulkDownloadAll.mockReturnValue(pending.promise);

  render(
    <TranslationSection
      subtitles={[{ start: 0, end: 1, text: 'original' }]}
      videoTitle="video"
      onTranslationComplete={vi.fn()}
    />
  );

  const initialRef = mocks[propsKey].exportPendingRef;
  expect(initialRef.current).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: buttonName }));
  fireEvent.click(screen.getByRole('button', { name: buttonName }));

  expect(mocks.bulkDownloadAll).toHaveBeenCalledOnce();
  expect(mocks[propsKey].exportPendingRef).toBe(initialRef);
  expect(initialRef.current).toBe(true);
  expect(mocks[propsKey].isExporting).toBe(true);

  await act(async () => pending.resolve({ status: 'cancelled' }));
  expect(initialRef.current).toBe(false);
  expect(mocks[propsKey].isExporting).toBe(false);
});
