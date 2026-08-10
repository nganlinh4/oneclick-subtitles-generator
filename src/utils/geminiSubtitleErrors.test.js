import { reportKnownGeminiSubtitleError } from './geminiSubtitleErrors';

const makeCtx = () => ({
  t: vi.fn((key) => key),
  setStatus: vi.fn(),
  startQuotaCountdown: vi.fn(),
});

describe('reportKnownGeminiSubtitleError', () => {
  test('quota error with explicit retry seconds starts the countdown (rounded up, free-tier flagged)', () => {
    const ctx = makeCtx();
    const handled = reportKnownGeminiSubtitleError(
      new Error('429 RESOURCE_EXHAUSTED. Please retry in 12.5s. generate_content_free_tier_requests'),
      ctx,
    );
    expect(handled).toBe(true);
    expect(ctx.startQuotaCountdown).toHaveBeenCalledWith(13, true);
    expect(ctx.setStatus).not.toHaveBeenCalled();
  });

  test('quota error without retry seconds reports a quota status', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(new Error('quota exceeded'), ctx)).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'errors.geminiQuotaExceeded' }));
  });

  test('503 service-unavailable is reported', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(new Error('503 Service Unavailable'), ctx)).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.geminiServiceUnavailable' }));
  });

  test('"model is overloaded" is reported as overloaded', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(new Error('The model is overloaded'), ctx)).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.geminiOverloaded' }));
  });

  test('token-limit error is reported with counts', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(
      new Error('input token count (5000) exceeds the maximum number of tokens allowed (4000)'), ctx,
    )).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.tokenLimitExceededCounts' }));
  });

  test('file-size error is reported', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(
      new Error('File size (60MB) exceeds the recommended maximum of 20MB'), ctx,
    )).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.fileSizeTooLarge' }));
  });

  test('unknown errors are not handled (caller falls through to its own logic)', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(new Error('something unexpected'), ctx)).toBe(false);
    expect(ctx.setStatus).not.toHaveBeenCalled();
    expect(ctx.startQuotaCountdown).not.toHaveBeenCalled();
  });

  test('an error without a message returns false', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError({}, ctx)).toBe(false);
  });
});
