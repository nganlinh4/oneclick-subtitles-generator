import { describe, expect, it, vi } from 'vitest';

import { boundedBackgroundErrorCode, getFriendlyErrorMessage } from './errorMessages';

const t = vi.fn((_key, fallback) => fallback);

describe('background generation errors', () => {
  it('retains only a bounded native code and explains pre-provider failures', () => {
    const error = Object.assign(new Error('redacted native failure'), { code: 'invalidImageRequest' });
    expect(boundedBackgroundErrorCode(error)).toBe('invalidImageRequest');
    expect(getFriendlyErrorMessage(t, error)).toMatch(/album art could not be prepared/i);
    expect(boundedBackgroundErrorCode({ code: '../private' })).toBeNull();
  });

  it('maps credential, model, project and empty-image codes without provider diagnostics', () => {
    expect(getFriendlyErrorMessage(t, { code: 'geminiCredentialRejected' })).toMatch(/unauthorized/i);
    expect(getFriendlyErrorMessage(t, { code: 'geminiRateLimited' })).toMatch(/quota/i);
    expect(getFriendlyErrorMessage(t, { code: 'invalidImageModel' })).toMatch(/model is unavailable/i);
    expect(getFriendlyErrorMessage(t, { code: 'invalidGeminiRequest' })).toMatch(/rejected the image model or request/i);
    expect(getFriendlyErrorMessage(t, { code: 'staleGeminiImageProject' })).toMatch(/project changed/i);
    expect(getFriendlyErrorMessage(t, { code: 'geminiImageEmpty' })).toMatch(/no image was returned/i);
  });
});
