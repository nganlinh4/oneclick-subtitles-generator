/**
 * Provenance Preservation & Manual Editing Operations for Word-Native Subtitles.
 * Implements strict provenance retention (Provider, Manual, Interpolated)
 * and alignment status tagging (Aligned, Modified, Unaligned).
 */

export const WordProvenance = Object.freeze({
  PROVIDER: 'Provider',
  MANUAL: 'Manual',
  INTERPOLATED: 'Interpolated',
});

export const AlignmentStatus = Object.freeze({
  ALIGNED: 'Aligned',
  MODIFIED: 'Modified',
  UNALIGNED: 'Unaligned',
});

/**
 * Applies a spelling/text correction to a word while preserving original timing and raw recognized text.
 */
export function applyWordCorrection(word, newText) {
  if (!word) throw new TypeError('word is required');
  const trimmed = String(newText || '').trim();
  return {
    ...word,
    text: trimmed,
    raw_spelling: word.raw_spelling || word.text,
    provenance: WordProvenance.MANUAL,
    alignment_status: AlignmentStatus.MODIFIED,
    is_unaligned: false,
    edited_at: Date.now(),
  };
}

/**
 * Splits a word proportionally by character index.
 * Duration is divided by character ratio r = splitIndex / textLength.
 */
export function splitWordProportionally(word, splitCharIndex) {
  if (!word) throw new TypeError('word is required');
  if (!word.text || word.text.length === 0) return [word];
  const text = word.text;
  const idx = Math.max(1, Math.min(splitCharIndex, text.length - 1));
  const leftText = text.slice(0, idx).trim();
  const rightText = text.slice(idx).trim();

  const totalDuration = Math.max(1, word.end_ms - word.start_ms);
  const ratio = idx / text.length;
  let splitMs = word.start_ms + Math.round(totalDuration * ratio);
  splitMs = Math.min(word.end_ms, Math.max(word.start_ms, splitMs));

  const word1 = {
    ...word,
    id: `${word.id}_1`,
    text: leftText,
    start_ms: word.start_ms,
    end_ms: splitMs,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    source_word_id: word.id,
    is_unaligned: false,
  };

  const word2 = {
    ...word,
    id: `${word.id}_2`,
    text: rightText,
    start_ms: splitMs,
    end_ms: word.end_ms,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    source_word_id: word.id,
    is_unaligned: false,
  };

  return [word1, word2];
}

/**
 * Merges two adjacent words into a single word unioning timing intervals.
 */
export function mergeAdjacentWords(w1, w2) {
  if (!w1 || !w2) throw new TypeError('w1 and w2 are required');
  const mergedStart = Math.min(w1.start_ms, w2.start_ms);
  const mergedEnd = Math.max(w1.end_ms, w2.end_ms);
  const mergedText = `${w1.text} ${w2.text}`;

  const source_word_ids = [
    ...(w1.source_word_ids || [w1.id]),
    ...(w2.source_word_ids || [w2.id]),
  ];

  return {
    id: `${w1.id}_merged`,
    text: mergedText,
    start_ms: mergedStart,
    end_ms: mergedEnd,
    speaker_id: w1.speaker_id || w2.speaker_id || null,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    source_word_ids,
    is_unaligned: false,
  };
}

/**
 * Nudges a word's timing boundaries. Marking alignment as Unaligned.
 */
export function nudgeWordTiming(word, deltaStartMs = 0, deltaEndMs = 0) {
  if (!word) throw new TypeError('word is required');
  const newStart = Math.max(0, word.start_ms + deltaStartMs);
  const newEnd = Math.max(newStart, word.end_ms + deltaEndMs);

  return {
    ...word,
    start_ms: newStart,
    end_ms: newEnd,
    provenance: WordProvenance.MANUAL,
    alignment_status: AlignmentStatus.UNALIGNED,
    is_unaligned: true,
  };
}
