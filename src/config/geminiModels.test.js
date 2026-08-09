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
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-robotics-er-1.6-preview',
  'gemini-robotics-er-2-preview'
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
      'gemini-3.1-flash-lite': 500,
      'gemini-3-flash-preview': 20,
      'gemini-2.5-flash-lite': 20,
      'gemini-robotics-er-1.6-preview': 20,
      'gemini-robotics-er-2-preview': 20
    });
    expect(GEMINI_MODELS.map((model) => model.profileLabels.en)).toEqual([
      'GG Good', 'GG Strong', 'GG Strong, slow', 'GG Fast',
      'GG Versatile', 'GG Lite', 'GG Precise', 'GG Precise+'
    ]);
  });

  test('keeps every ordinary model media-capable and limits Robotics ER 2 to video analysis', () => {
    const robotics2 = GEMINI_MODELS.find(({ id }) => id === 'gemini-robotics-er-2-preview');
    GEMINI_MODELS.forEach((model) => expect(modelAcceptsMedia(model.id)).toBe(true));
    expect(robotics2.modalities).toEqual(['video', 'image']);
    expect(robotics2.features).toEqual(['analysis']);
    expect(ANALYSIS_MODEL_IDS).toContain(robotics2.id);
    expect(TRANSLATION_MODELS.map(({ id }) => id)).not.toContain(robotics2.id);
    expect(BACKGROUND_PROMPT_MODELS.map(({ id }) => id)).not.toContain(robotics2.id);
  });

  test('derives exact default thinking values from the catalog', () => {
    expect(getDefaultThinkingBudgets()).toEqual({
      'gemini-3.5-flash-lite': 'minimal',
      'gemini-3.6-flash': 'minimal',
      'gemini-3.5-flash': 'minimal',
      'gemini-3.1-flash-lite': 'minimal',
      'gemini-3-flash-preview': 'minimal',
      'gemini-2.5-flash-lite': 0,
      'gemini-robotics-er-1.6-preview': 0,
      'gemini-robotics-er-2-preview': 0
    });
  });

  test('migrates retired built-ins without rejecting unknown custom models', () => {
    expect(migrateGeminiModelId('gemini-3.1-flash-lite-preview')).toBe('gemini-3.1-flash-lite');
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
