import { GEMINI_MODELS } from '../../config/geminiModels';
import { supportsMediaResolution } from './modelCapabilities';

describe('supportsMediaResolution', () => {
  test('uses the central request profile for every built-in model', () => {
    GEMINI_MODELS.forEach((model) => {
      expect(supportsMediaResolution(model.id)).toBe(model.request.mediaResolution);
    });
  });

  test('normalizes models/ prefixes and retired built-ins', () => {
    expect(supportsMediaResolution('models/gemini-3.5-flash-lite')).toBe(true);
    expect(supportsMediaResolution('gemini-2.5-flash')).toBe(true);
  });

  test('keeps the known LearnLM exception for custom models', () => {
    expect(supportsMediaResolution('learnlm-2.0-flash-experimental')).toBe(false);
    expect(supportsMediaResolution('models/learnlm-2.0-flash')).toBe(false);
  });

  test('defaults unknown custom models to supported', () => {
    expect(supportsMediaResolution('custom-future-model')).toBe(true);
  });
});
