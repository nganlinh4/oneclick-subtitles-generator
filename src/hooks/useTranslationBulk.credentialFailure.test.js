import { act, renderHook } from '@testing-library/react';
import { translateSubtitles } from '../services/geminiService';
import { useTranslationBulk } from './useTranslationBulk';

// Before this fix, useTranslationBulk.js caught a per-file NativeGeminiError and pushed it into
// `results` without ever rethrowing, so a bulk run where EVERY file failed for a missing Gemini
// credential still returned { status: 'complete' } and published a "0/N processed" status with no
// toast -- unlike the single-track path, whose missing-credential refusal reaches setError() and
// therefore TranslationError.js's one bounded showErrorToast (see TranslationError.js). These
// regressions fail against that old behavior: `setError` is never called with the credential
// error's message and the outcome stays 'complete' even when nothing succeeded.
vi.mock('../services/geminiService', () => ({
  translateSubtitles: vi.fn(),
}));

const CREDENTIAL_MISSING_MESSAGE = 'The native Gemini operation could not be completed';

const credentialMissingError = () => Object.assign(
  new Error(CREDENTIAL_MISSING_MESSAGE),
  { name: 'NativeGeminiError', code: 'geminiCredentialUnavailable' },
);

const filesOf = (names) => names.map((name, i) => ({
  id: i + 1,
  name,
  subtitles: [{ id: 1, start: 0, end: 1, text: 'Hello' }],
}));

const setupHook = () => {
  const setError = vi.fn();
  const setTranslationStatus = vi.fn();
  const t = (_key, fallback, params) => (
    params ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? '')) : fallback
  );
  const { result } = renderHook(() => useTranslationBulk({
    selectedModel: 'gemini-test',
    splitDuration: 0,
    setError,
    setTranslationStatus,
    t,
  }));
  return { result, setError, setTranslationStatus };
};

beforeEach(() => {
  translateSubtitles.mockReset();
});

test('every file failing for a missing credential yields a failed run and one refusal, not "complete"', async () => {
  const { result, setError, setTranslationStatus } = setupHook();
  act(() => result.current.setBulkFiles(filesOf(['alpha.srt', 'beta.srt'])));
  translateSubtitles.mockRejectedValue(credentialMissingError());

  let outcome;
  await act(async () => {
    outcome = await result.current.handleBulkTranslate(['Spanish']);
  });

  expect(outcome.status).toBe('failed');
  // setError('') also fires once at run start (existing reset behavior); the refusal itself is
  // exactly one additional, terminal call with the credential error's own message -- the same
  // bounded single-toast shape TranslationError.js gives the single-track path.
  expect(setError).toHaveBeenLastCalledWith(CREDENTIAL_MISSING_MESSAGE);
  expect(setError.mock.calls.filter(([message]) => message === CREDENTIAL_MISSING_MESSAGE)).toHaveLength(1);
  // The dishonest "Bulk translation complete: 0/2 files processed successfully" status never ships.
  expect(setTranslationStatus.mock.calls.some(
    ([message]) => /processed successfully/.test(message)
  )).toBe(false);
});

test('a partial success keeps the documented complete-with-warnings semantics (no refusal toast)', async () => {
  const { result, setError, setTranslationStatus } = setupHook();
  act(() => result.current.setBulkFiles(filesOf(['alpha.srt', 'beta.srt'])));
  translateSubtitles
    .mockResolvedValueOnce(Object.freeze({
      status: 'complete',
      rows: Object.freeze([{
        id: 1, originalId: 'number:1', sourceOrder: 0, start: 0, end: 1, text: 'Hola',
      }]),
      deliveries: Object.freeze([]),
    }))
    .mockRejectedValueOnce(credentialMissingError());

  let outcome;
  await act(async () => {
    outcome = await result.current.handleBulkTranslate(['Spanish']);
  });

  expect(outcome.status).toBe('complete');
  expect(setError).not.toHaveBeenCalledWith(CREDENTIAL_MISSING_MESSAGE);
  expect(setTranslationStatus).toHaveBeenLastCalledWith(
    'Bulk translation complete: 1/2 files processed successfully'
  );
});

test('an all-failed run with a non-credential reason mixed in still reports complete (out of this fix\'s scope)', async () => {
  const { result, setError } = setupHook();
  act(() => result.current.setBulkFiles(filesOf(['alpha.srt', 'beta.srt'])));
  translateSubtitles
    .mockRejectedValueOnce(credentialMissingError())
    .mockRejectedValueOnce(new Error('boom'));

  let outcome;
  await act(async () => {
    outcome = await result.current.handleBulkTranslate(['Spanish']);
  });

  expect(outcome.status).toBe('complete');
  expect(setError).not.toHaveBeenCalledWith(CREDENTIAL_MISSING_MESSAGE);
});
