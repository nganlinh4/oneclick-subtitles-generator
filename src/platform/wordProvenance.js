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
  const startMs = word.startMs ?? word.start_ms ?? 0;
  const endMs = word.endMs ?? word.end_ms ?? 0;
  return {
    ...word,
    text: trimmed,
    start_ms: startMs,
    end_ms: endMs,
    startMs,
    endMs,
    raw_spelling: word.raw_spelling || word.rawSpelling || word.text,
    rawSpelling: word.rawSpelling || word.raw_spelling || word.text,
    provenance: WordProvenance.MANUAL,
    alignment_status: AlignmentStatus.MODIFIED,
    alignmentStatus: AlignmentStatus.MODIFIED,
    is_unaligned: false,
    edited_at: Date.now(),
    editedAt: Date.now(),
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

  const wStart = word.startMs ?? word.start_ms ?? 0;
  const wEnd = word.endMs ?? word.end_ms ?? 0;
  const totalDuration = Math.max(1, wEnd - wStart);
  const ratio = idx / text.length;
  let splitMs = wStart + Math.round(totalDuration * ratio);
  splitMs = Math.min(wEnd, Math.max(wStart, splitMs));

  const word1 = {
    ...word,
    id: `${word.id}_1`,
    text: leftText,
    start_ms: wStart,
    end_ms: splitMs,
    startMs: wStart,
    endMs: splitMs,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    alignmentStatus: AlignmentStatus.MODIFIED,
    source_word_id: word.id,
    sourceWordId: word.id,
    is_unaligned: false,
  };

  const word2 = {
    ...word,
    id: `${word.id}_2`,
    text: rightText,
    start_ms: splitMs,
    end_ms: wEnd,
    startMs: splitMs,
    endMs: wEnd,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    alignmentStatus: AlignmentStatus.MODIFIED,
    source_word_id: word.id,
    sourceWordId: word.id,
    is_unaligned: false,
  };

  return [word1, word2];
}

/**
 * Merges two adjacent words into a single word unioning timing intervals.
 */
export function mergeAdjacentWords(w1, w2) {
  if (!w1 || !w2) throw new TypeError('w1 and w2 are required');
  const w1Start = w1.startMs ?? w1.start_ms ?? 0;
  const w1End = w1.endMs ?? w1.end_ms ?? 0;
  const w2Start = w2.startMs ?? w2.start_ms ?? 0;
  const w2End = w2.endMs ?? w2.end_ms ?? 0;

  const mergedStart = Math.min(w1Start, w2Start);
  const mergedEnd = Math.max(w1End, w2End);
  const mergedText = `${w1.text} ${w2.text}`;
  const speakerId = w1.speakerId || w1.speaker_id || w2.speakerId || w2.speaker_id || null;

  const source_word_ids = [
    ...(w1.source_word_ids || w1.sourceWordIds || [w1.id]),
    ...(w2.source_word_ids || w2.sourceWordIds || [w2.id]),
  ];

  return {
    id: `${w1.id}_merged`,
    text: mergedText,
    start_ms: mergedStart,
    end_ms: mergedEnd,
    startMs: mergedStart,
    endMs: mergedEnd,
    speaker_id: speakerId,
    speakerId,
    provenance: WordProvenance.INTERPOLATED,
    alignment_status: AlignmentStatus.MODIFIED,
    alignmentStatus: AlignmentStatus.MODIFIED,
    source_word_ids,
    sourceWordIds: source_word_ids,
    is_unaligned: false,
  };
}

/**
 * Nudges a word's timing boundaries. Marking alignment as Unaligned.
 */
export function nudgeWordTiming(word, deltaStartMs = 0, deltaEndMs = 0) {
  if (!word) throw new TypeError('word is required');
  const wStart = word.startMs ?? word.start_ms ?? 0;
  const wEnd = word.endMs ?? word.end_ms ?? 0;
  const newStart = Math.max(0, wStart + deltaStartMs);
  const newEnd = Math.max(newStart, wEnd + deltaEndMs);

  return {
    ...word,
    start_ms: newStart,
    end_ms: newEnd,
    startMs: newStart,
    endMs: newEnd,
    provenance: WordProvenance.MANUAL,
    alignment_status: AlignmentStatus.UNALIGNED,
    alignmentStatus: AlignmentStatus.UNALIGNED,
    is_unaligned: true,
  };
}
