import { addThinkingConfig, getThinkingBudget, validateThinkingBudget } from './thinkingBudgetUtils';

describe('Gemini thinking request profiles', () => {
  beforeEach(() => localStorage.clear());

  test('uses toolbox minimal thinking for Gemini 3 models', () => {
    expect(addThinkingConfig({}, 'gemini-3.6-flash')).toEqual({
      generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } }
    });
  });

  test('uses numeric zero for disabled-thinking endpoints', () => {
    expect(addThinkingConfig({}, 'gemini-robotics-er-1.6-preview')).toEqual({
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } }
    });
  });

  test('accepts valid user levels and rejects stale values', () => {
    localStorage.setItem('thinking_budgets', JSON.stringify({
      'gemini-3.5-flash-lite': 'high'
    }));
    expect(getThinkingBudget('gemini-3.5-flash-lite')).toBe('high');

    localStorage.setItem('thinking_budgets', JSON.stringify({
      'gemini-3.5-flash-lite': 24576
    }));
    expect(getThinkingBudget('gemini-3.5-flash-lite')).toBe('minimal');
  });

  test('forces the lowest supported value when thinking is disabled per call', () => {
    localStorage.setItem('thinking_budgets', JSON.stringify({
      'gemini-3.5-flash': 'high'
    }));
    expect(addThinkingConfig({}, 'gemini-3.5-flash', { enableThinking: false }))
      .toEqual({ generationConfig: { thinkingConfig: { thinkingLevel: 'MINIMAL' } } });
  });

  test('leaves unknown custom model requests untouched', () => {
    expect(addThinkingConfig({ contents: [] }, 'custom-model')).toEqual({ contents: [] });
    expect(validateThinkingBudget('custom-model', 'minimal')).toBe(false);
  });
});
