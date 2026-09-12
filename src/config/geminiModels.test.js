import {
  ANALYSIS_MODEL_IDS,
  BACKGROUND_PROMPT_MODELS,
  DEFAULT_ANALYSIS_MODEL_ID,
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  TRANSLATION_MODELS,
  getDefaultThinkingBudgets,
  isCustomGeminiModelId,
  migrateGeminiModelId,
  migrateStoredGeminiModels,
  modelAcceptsMedia,
  normalizeCustomGeminiModelId,
  normalizeCustomGeminiModels,
  normalizeMediaModelId,
  sortModelsForDisplay
} from './geminiModels';

const EXPECTED_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash'
];

const DISPLAY_MODELS = [
  'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
];

describe('Gemini model catalog contract', () => {
  test('matches the toolbox ordinary model lineup exactly', () => {
    expect(GEMINI_MODELS.map(({ id }) => id)).toEqual(EXPECTED_MODELS);
    expect(DEFAULT_GEMINI_MODEL_ID).toBe('gemini-3.1-flash-lite');
    expect(DEFAULT_ANALYSIS_MODEL_ID).toBe(DEFAULT_GEMINI_MODEL_ID);
  });

  test('keeps provider-default sampling and valid quotas on every model', () => {
    GEMINI_MODELS.forEach((model) => {
      expect(model.request.sampling).toBe('provider-default');
      if (model.quota.requestsPerDay !== null) expect(model.quota.requestsPerDay).toBeGreaterThan(0);
      expect(model.dailyUse).toBeTruthy();
    });
    expect(Object.fromEntries(GEMINI_MODELS.map((model) => [model.id, model.freeRPD]))).toEqual({
      'gemini-3.5-flash-lite': 500,
      'gemini-3.7-flash': 20,
      'gemini-3.6-flash': 20,
      'gemini-3.5-flash': 20,
      'gemini-3.1-flash-lite': 500,
      'gemini-3.8-flash': 20
    });
    expect(GEMINI_MODELS.map((model) => model.profileLabels.en)).toEqual([
      'GG Good', 'GG Latest', 'GG Strong', 'GG Strong, slow', 'GG Fast', 'GG New'
    ]);
  });

  test('keeps every ordinary model stable and audio/video capable', () => {
    GEMINI_MODELS.forEach((model) => expect(modelAcceptsMedia(model.id)).toBe(true));
    GEMINI_MODELS.forEach((model) => expect(model.lifecycle).toBe('stable'));
    expect(ANALYSIS_MODEL_IDS).toEqual(DISPLAY_MODELS);
    expect(TRANSLATION_MODELS.map(({ id }) => id)).toEqual(DISPLAY_MODELS);
    expect(BACKGROUND_PROMPT_MODELS.map(({ id }) => id)).toEqual(DISPLAY_MODELS);
  });

  test('numeric display order handles future versions and custom IDs without mutating its source', () => {
    const ids = ['gemini-custom', 'gemini-3.9-flash', 'gemini-3.10-flash-lite',
      'gemini-4.0-flash', 'gemini-3.10-flash'];
    const models = Object.freeze(ids.map(id => Object.freeze({ id })));
    expect(sortModelsForDisplay(models).map(({ id }) => id)).toEqual([
      'gemini-4.0-flash', 'gemini-3.10-flash', 'gemini-3.10-flash-lite',
      'gemini-3.9-flash', 'gemini-custom',
    ]);
    expect(models.map(({ id }) => id)).toEqual(ids);
  });

  test('derives exact default thinking values from the catalog', () => {
    expect(getDefaultThinkingBudgets()).toEqual({
      'gemini-3.5-flash-lite': 'minimal',
      'gemini-3.7-flash': 'low',
      'gemini-3.6-flash': 'minimal',
      'gemini-3.5-flash': 'minimal',
      'gemini-3.1-flash-lite': 'minimal',
      'gemini-3.8-flash': 'low'
    });
  });

  test('migrates retired built-ins without rejecting unknown custom models', () => {
    expect(migrateGeminiModelId('gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite');
    expect(migrateGeminiModelId('gemini-robotics-er-2-preview')).toBe('gemini-3.6-flash');
    expect(migrateGeminiModelId('models/gemini-2.5-flash')).toBe(DEFAULT_GEMINI_MODEL_ID);
    expect(migrateGeminiModelId('my-private-gemini-endpoint')).toBe('my-private-gemini-endpoint');
    expect(normalizeMediaModelId('my-private-gemini-endpoint')).toBe(DEFAULT_GEMINI_MODEL_ID);
  });

  test('accepts bounded provider model IDs as text-only custom models', () => {
    expect(normalizeCustomGeminiModelId('  gemini-custom-test  ')).toBe('gemini-custom-test');
    expect(isCustomGeminiModelId('gemini-custom-test')).toBe(true);
    expect(isCustomGeminiModelId('gemini-3.7-flash')).toBe(false);
    expect(isCustomGeminiModelId('gemini-3.5-flash-lite')).toBe(false);
    expect(normalizeCustomGeminiModelId('models/gemini-custom-test')).toBeNull();
    expect(normalizeCustomGeminiModelId('gemini-custom-test:generateContent')).toBeNull();
    expect(normalizeCustomGeminiModelId('Gemini-3.8-Flash')).toBeNull();
    expect(normalizeCustomGeminiModels([
      { id: 'gemini-3.7-flash', name: 'Promoted duplicate', isCustom: true },
      { id: ' gemini-custom-test ', name: ' Future model ' },
      { id: 'gemini-custom-test', name: 'Duplicate' }
    ])).toEqual([{ id: 'gemini-custom-test', name: 'Future model', isCustom: true }]);
  });

  test('migrates every persisted model selection through one function', () => {
    const values = new Map([
      ['gemini_model', 'gemini-2.5-flash'],
      ['translation_model', 'custom-model'],
      ['video_analysis_model', 'gemini-3.1-flash-lite-preview'],
      ['video_processing_model', 'unverified-custom-model'],
      ['custom_gemini_models', JSON.stringify([
        { id: 'gemini-3.7-flash', name: 'Old custom entry', isCustom: true },
        { id: 'gemini-custom-test', name: 'Future model', isCustom: true }
      ])],
      ['thinking_budgets', JSON.stringify({
        'gemini-3.1-flash-lite-preview': 'high',
        'gemini-2.5-flash': 2048,
        'gemini-3.7-flash': 'minimal'
      })]
    ]);
    const storage = {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value)
    };

    expect(migrateStoredGeminiModels(storage)).toEqual({
      custom_gemini_models: [{
        id: 'gemini-custom-test',
        name: 'Future model',
        isCustom: true
      }],
      gemini_model: 'gemini-3.1-flash-lite',
      video_analysis_model: 'gemini-3.1-flash-lite',
      video_processing_model: 'gemini-3.1-flash-lite'
    });
    expect(values.get('translation_model')).toBe('custom-model');
    expect(JSON.parse(values.get('custom_gemini_models'))).toEqual([{
      id: 'gemini-custom-test',
      name: 'Future model',
      isCustom: true
    }]);
    expect(JSON.parse(values.get('thinking_budgets'))).toEqual({
      'gemini-3.1-flash-lite': 'high',
      'gemini-3.7-flash': 'low'
    });
  });
});
