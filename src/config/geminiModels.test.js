import {
  ANALYSIS_MODEL_IDS,
  BACKGROUND_PROMPT_MODELS,
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  TRANSLATION_MODELS,
  getDefaultThinkingBudgets,
  migrateGeminiModelId,
  migrateStoredGeminiModels,
  modelAcceptsMedia,
  normalizeMediaModelId
} from './geminiModels';

const EXPECTED_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite'
];

describe('Gemini model catalog contract', () => {
  test('matches the toolbox ordinary model lineup exactly', () => {
    expect(GEMINI_MODELS.map(({ id }) => id)).toEqual(EXPECTED_MODELS);
    expect(DEFAULT_GEMINI_MODEL_ID).toBe('gemini-3.5-flash-lite');
    expect(DEFAULT_ANALYSIS_MODEL_ID).toBe(DEFAULT_GEMINI_MODEL_ID);
  });

  test('keeps provider-default sampling and valid quotas on every model', () => {
    GEMINI_MODELS.forEach((model) => {
      expect(model.request.sampling).toBe('provider-default');
      expect(model.quota.requestsPerDay).toBeGreaterThan(0);
      expect(model.dailyUse).toBeTruthy();
    });
    expect(Object.fromEntries(GEMINI_MODELS.map((model) => [model.id, model.freeRPD]))).toEqual({
      'gemini-3.5-flash-lite': 500,
      'gemini-3.6-flash': 20,
      'gemini-3.5-flash': 20,
      'gemini-3.1-flash-lite': 500
    });
    expect(GEMINI_MODELS.map((model) => model.profileLabels.en)).toEqual([
      'GG Good', 'GG Strong', 'GG Strong, slow', 'GG Fast'
    ]);
  });

  test('keeps every ordinary model stable and audio/video capable', () => {
    GEMINI_MODELS.forEach((model) => expect(modelAcceptsMedia(model.id)).toBe(true));
    GEMINI_MODELS.forEach((model) => expect(model.lifecycle).toBe('stable'));
    expect(ANALYSIS_MODEL_IDS).toEqual(EXPECTED_MODELS);
    expect(TRANSLATION_MODELS.map(({ id }) => id)).toEqual(EXPECTED_MODELS);
    expect(BACKGROUND_PROMPT_MODELS.map(({ id }) => id)).toEqual(EXPECTED_MODELS);
  });

  test('derives exact default thinking values from the catalog', () => {
    expect(getDefaultThinkingBudgets()).toEqual({
      'gemini-3.5-flash-lite': 'minimal',
      'gemini-3.6-flash': 'minimal',
      'gemini-3.5-flash': 'minimal',
      'gemini-3.1-flash-lite': 'minimal'
    });
  });

  test('migrates retired built-ins without rejecting unknown custom models', () => {
    expect(migrateGeminiModelId('gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite');
    expect(migrateGeminiModelId('gemini-robotics-er-2-preview')).toBe('gemini-3.6-flash');
    expect(migrateGeminiModelId('models/gemini-2.5-flash')).toBe(DEFAULT_GEMINI_MODEL_ID);
    expect(migrateGeminiModelId('my-private-gemini-endpoint')).toBe('my-private-gemini-endpoint');
    expect(normalizeMediaModelId('my-private-gemini-endpoint')).toBe(DEFAULT_GEMINI_MODEL_ID);
  });

  test('migrates every persisted model selection through one function', () => {
    const values = new Map([
      ['gemini_model', 'gemini-2.5-flash'],
      ['translation_model', 'custom-model'],
      ['video_analysis_model', 'gemini-3.1-flash-lite-preview'],
      ['video_processing_model', 'unverified-custom-model'],
      ['thinking_budgets', JSON.stringify({
        'gemini-3.1-flash-lite-preview': 'high',
        'gemini-2.5-flash': 2048
      })]
    ]);
    const storage = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value)
    };

    expect(migrateStoredGeminiModels(storage)).toEqual({
      gemini_model: 'gemini-3.5-flash-lite',
      video_analysis_model: 'gemini-3.1-flash-lite',
      video_processing_model: 'gemini-3.5-flash-lite'
    });
    expect(values.get('translation_model')).toBe('custom-model');
    expect(JSON.parse(values.get('thinking_budgets'))).toEqual({
      'gemini-3.1-flash-lite': 'high'
    });
  });
});
