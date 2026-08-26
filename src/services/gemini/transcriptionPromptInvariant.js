export const TRANSCRIPTION_CONTENT_TYPE_TOKEN = '{contentType}';

const countTokenOccurrences = (prompt) => {
  if (typeof prompt !== 'string') return 0;
  return prompt.split(TRANSCRIPTION_CONTENT_TYPE_TOKEN).length - 1;
};

export const hasExactlyOneContentTypeToken = (prompt) => (
  countTokenOccurrences(prompt) === 1
);

/**
 * Return a prompt with exactly one content-type token without policing the
 * user's intermediate keystrokes. The first token keeps its position and any
 * later duplicates are removed. A missing token is appended to a non-empty
 * draft; an empty or non-string draft falls back to the last known-valid
 * prompt when one is available.
 */
export const normalizeTranscriptionPrompt = (prompt, lastValidPrompt = '') => {
  const draft = typeof prompt === 'string' ? prompt : '';
  const pieces = draft.split(TRANSCRIPTION_CONTENT_TYPE_TOKEN);

  if (pieces.length > 1) {
    return `${pieces[0]}${TRANSCRIPTION_CONTENT_TYPE_TOKEN}${pieces.slice(1).join('')}`;
  }

  const trimmedDraft = draft.trim();
  const isLegacyStorageSentinel = trimmedDraft === 'undefined' || trimmedDraft === 'null';
  if (!trimmedDraft || isLegacyStorageSentinel) {
    if (hasExactlyOneContentTypeToken(lastValidPrompt)) return lastValidPrompt;
    return TRANSCRIPTION_CONTENT_TYPE_TOKEN;
  }

  return `${draft.trimEnd()}\n\n${TRANSCRIPTION_CONTENT_TYPE_TOKEN}`;
};
