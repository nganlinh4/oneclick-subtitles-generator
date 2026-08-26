/** Whether a string contains no unpaired UTF-16 surrogate. */
export const isWellFormedUnicode = (value) => {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

/**
 * Whether narration grouping may inspect this editor draft yet.
 *
 * A blank cue is a valid, short-lived editor state: both the empty-editor Add action and row
 * insertion create the timing slot before the user types its text. It is not a valid provider
 * source, however. Keep the provider snapshot validator strict, and let render-time consumers use
 * this predicate to avoid treating that ordinary draft state as corrupt grouping data.
 *
 * Accessor-backed rows are not evaluated here. The strict snapshot validator rejects them if a
 * caller tries to submit them, while this readiness check remains side-effect free.
 */
export const hasCompleteGroupingText = (subtitles) => {
  if (!Array.isArray(subtitles) || subtitles.length === 0) return false;
  try {
    return subtitles.every((subtitle) => {
      if (subtitle === null || typeof subtitle !== 'object') return false;
      const descriptor = Object.getOwnPropertyDescriptor(subtitle, 'text');
      return descriptor !== undefined
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
        && isWellFormedUnicode(descriptor.value)
        && descriptor.value.trim().length > 0;
    });
  } catch {
    return false;
  }
};
