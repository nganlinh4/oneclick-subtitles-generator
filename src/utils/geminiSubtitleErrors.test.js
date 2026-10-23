import {
  classifyGeminiError,
  GEMINI_ERROR_KIND,
  isTransientGeminiError,
  reportKnownGeminiSubtitleError,
} from './geminiSubtitleErrors';

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

const coded = (code, message = 'The native Gemini operation could not be completed') => (
  Object.assign(new Error(message), { code })
);

describe('classifyGeminiError', () => {
  test.each([
    [coded('geminiRateLimited'), GEMINI_ERROR_KIND.RATE_LIMITED],
    [coded('geminiProvider'), GEMINI_ERROR_KIND.PROVIDER_FAILURE],
    // A code is authoritative: its message text is never re-classified.
    [coded('nativeGeminiFailed', '503 quota overloaded'), null],
    [coded('geminiCredentialRejected', 'Gemini quota'), null],
    [coded('subtitleCacheSaveFailed'), null],
    [new Error('429 RESOURCE_EXHAUSTED'), GEMINI_ERROR_KIND.RATE_LIMITED],
    [new Error('rate limit reached'), GEMINI_ERROR_KIND.RATE_LIMITED],
    [new Error('503 Service Unavailable'), GEMINI_ERROR_KIND.OVERLOADED],
    [new Error('status UNAVAILABLE'), GEMINI_ERROR_KIND.OVERLOADED],
    [new Error('The model is overloaded'), GEMINI_ERROR_KIND.OVERLOADED],
    [new Error('input token count (5) exceeds the maximum'), GEMINI_ERROR_KIND.TOKEN_LIMIT],
    [new Error('File size (60MB) exceeds the recommended maximum of 20MB'), GEMINI_ERROR_KIND.FILE_TOO_LARGE],
    // Mentioning Gemini is not, by itself, a provider failure.
    [new Error('Gemini returned no subtitles'), null],
    [{}, null],
    [null, null],
  ])('classifies %o as %s', (error, kind) => {
    expect(classifyGeminiError(error)).toBe(kind);
  });

  test('rate-limit, overload and upstream failures are transient; others are not', () => {
    expect(isTransientGeminiError(coded('geminiRateLimited'))).toBe(true);
    expect(isTransientGeminiError(coded('geminiProvider'))).toBe(true);
    expect(isTransientGeminiError(new Error('The model is overloaded'))).toBe(true);
    expect(isTransientGeminiError(coded('geminiRequestRejected'))).toBe(false);
    expect(isTransientGeminiError(new Error('input token count (5) exceeds the maximum'))).toBe(false);
  });

  test('a coded rate limit reports the quota status; a coded upstream failure is left to the caller', () => {
    const ctx = makeCtx();
    expect(reportKnownGeminiSubtitleError(coded('geminiRateLimited'), ctx)).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.geminiQuotaExceeded' }));
    expect(reportKnownGeminiSubtitleError(coded('geminiProvider'), makeCtx())).toBe(false);
  });

  test('retry seconds without a countdown owner fall back to the quota status', () => {
    const ctx = { t: vi.fn((key) => key), setStatus: vi.fn() };
    expect(reportKnownGeminiSubtitleError(new Error('429. Please retry in 3s'), ctx)).toBe(true);
    expect(ctx.setStatus).toHaveBeenCalledWith(expect.objectContaining({ message: 'errors.geminiQuotaExceeded' }));
  });
});
