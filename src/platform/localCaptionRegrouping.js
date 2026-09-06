/**
 * 100% Offline, Zero-Provider-Call Caption Regrouping Engine.
 * Implements Natural, Short, One word, and Custom policies.
 * Guarantees zero network calls and sub-millisecond local execution.
 */

export const REGROUPING_POLICIES = Object.freeze({
  NATURAL: 'Natural',
  SHORT: 'Short',
  ONE_WORD: 'One word',
  CUSTOM: 'Custom',
});

const DEFAULT_SENTENCE_PUNCTUATION_REGEX = /[.?!。！？]$/u;

/**
 * Joins word tokens preserving script-aware spacing.
 * Does not insert extra spaces before punctuation or between adjacent CJK characters.
 */
export function joinWordsPreservingSpacing(words) {
  if (!Array.isArray(words) || words.length === 0) return '';
  let result = '';
  for (let i = 0; i < words.length; i++) {
    const text = words[i]?.text ?? '';
    if (!text) continue;
    if (result.length === 0) {
      result = text;
      continue;
    }
    const prev = words[i - 1]?.text ?? '';
    if (/^[.,!?:;'\u2019\u201d\u3001\u3002\uff0c\uff01\uff1f]/.test(text)) {
      result += text;
    } else if (/[\u4e00-\u9fa5\u3040-\u30ff\u3000-\u303f\uff00-\uffef]/.test(prev.slice(-1)) && /[\u4e00-\u9fa5\u3040-\u30ff]/.test(text.slice(0, 1))) {
      result += text;
    } else if (result.endsWith(' ') || text.startsWith(' ')) {
      result += text;
    } else {
      result += ' ' + text;
    }
  }
  return result;
}

function buildCue(cueIdx, currentWords) {
  const startMs = Math.min(...currentWords.map((cw) => cw.startMs));
  const endMs = Math.max(...currentWords.map((cw) => cw.endMs));
  const rawWords = currentWords.map((cw) => cw.raw);
  const wordIds = rawWords.map((w, idx) => w.id || `w_${cueIdx}_${idx + 1}`);
  const speakerId = currentWords[0]?.speakerId || null;
  return {
    id: `cue_${cueIdx}`,
    ordinal: cueIdx,
    start_ms: startMs,
    end_ms: endMs,
    startMs,
    endMs,
    start: startMs / 1000,
    end: endMs / 1000,
    text: joinWordsPreservingSpacing(rawWords),
    word_ids: wordIds,
    wordIds,
    speaker_id: speakerId,
    speakerId,
    manual_state: 'clean',
  };
}

/**
 * Regroups words into cues according to the specified policy.
 *
 * @param {Array<{id: string, text: string, start_ms: number, end_ms: number, speaker_id?: string, is_unaligned?: boolean}>} words
 * @param {string} policy - 'Natural' | 'Short' | 'One word' | 'Custom'
 * @param {object} [customOptions]
 * @returns {Array<object>} projected cues
 */
export function regroupWordsOffline(words, policy = 'Natural', customOptions = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];

  const normalizedWords = words
    .map((w) => {
      const startMs = w.startMs ?? w.start_ms ?? Math.round((w.start || 0) * 1000);
      const endMs = w.endMs ?? w.end_ms ?? Math.round((w.end || 0) * 1000);
      const speakerId = w.speakerId || w.speaker_id || null;
      const isUnaligned = Boolean(w.is_unaligned) || w.alignmentStatus === 'Unaligned' || w.alignment_status === 'Unaligned';
      return {
        raw: w,
        id: w.id,
        text: w.text || '',
        startMs,
        endMs,
        speakerId,
        isUnaligned,
      };
    })
    .sort((a, b) => (a.startMs - b.startMs) || (a.endMs - b.endMs));

  if (policy === 'One word') {
    return normalizedWords.map((w, idx) => ({
      id: `cue_${idx + 1}`,
      ordinal: idx + 1,
      start_ms: w.startMs,
      end_ms: w.endMs,
      startMs: w.startMs,
      endMs: w.endMs,
      start: w.startMs / 1000,
      end: w.endMs / 1000,
      text: w.text,
      word_ids: [w.id],
      wordIds: [w.id],
      speaker_id: w.speakerId,
      speakerId: w.speakerId,
      is_unaligned: w.isUnaligned,
      manual_state: 'clean',
    }));
  }

  if (policy === 'Short') {
    const maxWords = 5;
    const maxDurationMs = 2500;
    const cues = [];
    let currentWords = [];

    for (const word of normalizedWords) {
      const currentDuration = currentWords.length > 0
        ? word.endMs - currentWords[0].startMs
        : word.endMs - word.startMs;

      if (currentWords.length >= maxWords || currentDuration > maxDurationMs) {
        if (currentWords.length > 0) {
          cues.push(buildCue(cues.length + 1, currentWords));
          currentWords = [];
        }
      }
      currentWords.push(word);
    }
    if (currentWords.length > 0) {
      cues.push(buildCue(cues.length + 1, currentWords));
    }
    return cues;
  }

  if (policy === 'Custom') {
    const maxWords = customOptions.max_words ?? customOptions.maxWords ?? 8;
    const maxDurationMs = customOptions.max_duration_ms
      ?? customOptions.maxDurationMs
      ?? (customOptions.maxDuration != null ? Math.round(customOptions.maxDuration * 1000) : 4000);
    const pauseThresholdMs = customOptions.pause_threshold_ms
      ?? customOptions.pauseThresholdMs
      ?? customOptions.pauseThreshold
      ?? 300;
    const splitOnPunctuation = customOptions.split_on_punctuation ?? customOptions.splitOnPunctuation ?? true;
    const cues = [];
    let currentWords = [];

    for (let i = 0; i < normalizedWords.length; i++) {
      const word = normalizedWords[i];
      const prevWord = currentWords[currentWords.length - 1];

      let shouldBreakBefore = false;
      if (prevWord) {
        const pause = word.startMs - prevWord.endMs;
        if (pause > pauseThresholdMs) {
          shouldBreakBefore = true;
        }
      }

      if (shouldBreakBefore && currentWords.length > 0) {
        cues.push(buildCue(cues.length + 1, currentWords));
        currentWords = [];
      }

      currentWords.push(word);

      let shouldBreakAfter = false;
      const currentDuration = word.endMs - currentWords[0].startMs;
      if (currentWords.length >= maxWords || currentDuration > maxDurationMs) {
        shouldBreakAfter = true;
      } else if (splitOnPunctuation && DEFAULT_SENTENCE_PUNCTUATION_REGEX.test(word.text.trim())) {
        shouldBreakAfter = true;
      }

      if (shouldBreakAfter && currentWords.length > 0) {
        cues.push(buildCue(cues.length + 1, currentWords));
        currentWords = [];
      }
    }

    if (currentWords.length > 0) {
      cues.push(buildCue(cues.length + 1, currentWords));
    }
    return cues;
  }

  // Default: Natural
  // Break on speech pause > 300ms, sentence punctuation [.?!], or max 12 words
  const maxWords = 12;
  const pauseThresholdMs = 300;

  const cues = [];
  let currentWords = [];

  for (let i = 0; i < normalizedWords.length; i++) {
    const word = normalizedWords[i];
    const prevWord = currentWords[currentWords.length - 1];

    let shouldBreakBefore = false;
    if (prevWord) {
      const pause = word.startMs - prevWord.endMs;
      if (pause > pauseThresholdMs) {
        shouldBreakBefore = true;
      }
    }

    if (shouldBreakBefore && currentWords.length > 0) {
      cues.push(buildCue(cues.length + 1, currentWords));
      currentWords = [];
    }

    currentWords.push(word);

    let shouldBreakAfter = false;
    if (currentWords.length >= maxWords) {
      shouldBreakAfter = true;
    } else if (DEFAULT_SENTENCE_PUNCTUATION_REGEX.test(word.text.trim())) {
      shouldBreakAfter = true;
    }

    if (shouldBreakAfter && currentWords.length > 0) {
      cues.push(buildCue(cues.length + 1, currentWords));
      currentWords = [];
    }
  }

  if (currentWords.length > 0) {
    cues.push(buildCue(cues.length + 1, currentWords));
  }

  return cues;
}

/**
 * Regroups words while preserving manual edits.
 * Cues marked with userEdited: true or manual_state != 'clean' are kept locked,
 * while unedited spans of words are reflowed.
 *
 * @param {Array} words
 * @param {Array} currentCues
 * @param {string} policy
 * @param {object} [options]
 * @returns {Array} new cues
 */
export function regroupPreservingEdits(words, currentCues = [], policy = 'Natural', options = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];
  if (!Array.isArray(currentCues) || currentCues.length === 0) {
    return regroupWordsOffline(words, policy, options);
  }

  // Identify preserved cues
  const preservedCues = currentCues.filter(
    (c) => c.userEdited || (c.manual_state && c.manual_state !== 'clean') || c.locked
  );

  if (preservedCues.length === 0) {
    return regroupWordsOffline(words, policy, options);
  }

  // Collect all word IDs claimed by preserved cues
  const claimedWordIds = new Set();
  for (const cue of preservedCues) {
    if (Array.isArray(cue.word_ids)) {
      for (const wId of cue.word_ids) claimedWordIds.add(wId);
    }
    if (Array.isArray(cue.wordIds)) {
      for (const wId of cue.wordIds) claimedWordIds.add(wId);
    }
  }

  // Slice unclaimed words into contiguous segments
  const sortedWords = [...words].sort((a, b) => {
    const aStart = a.startMs ?? a.start_ms ?? Math.round((a.start || 0) * 1000);
    const bStart = b.startMs ?? b.start_ms ?? Math.round((b.start || 0) * 1000);
    if (aStart !== bStart) return aStart - bStart;
    const aEnd = a.endMs ?? a.end_ms ?? Math.round((a.end || 0) * 1000);
    const bEnd = b.endMs ?? b.end_ms ?? Math.round((b.end || 0) * 1000);
    return aEnd - bEnd;
  });

  const unclaimedSlices = [];
  let currentSlice = [];

  for (const word of sortedWords) {
    if (claimedWordIds.has(word.id)) {
      if (currentSlice.length > 0) {
        unclaimedSlices.push(currentSlice);
        currentSlice = [];
      }
    } else {
      currentSlice.push(word);
    }
  }
  if (currentSlice.length > 0) {
    unclaimedSlices.push(currentSlice);
  }

  // Project new cues for each unclaimed slice
  const newlyProjectedCues = [];
  for (const slice of unclaimedSlices) {
    const projected = regroupWordsOffline(slice, policy, options);
    newlyProjectedCues.push(...projected);
  }

  // Merge preserved cues and new cues, sorted chronologically
  const allCues = [...preservedCues, ...newlyProjectedCues].sort((a, b) => {
    const startA = a.startMs ?? a.start_ms ?? Math.round((a.start || 0) * 1000);
    const startB = b.startMs ?? b.start_ms ?? Math.round((b.start || 0) * 1000);
    if (startA !== startB) return startA - startB;
    const endA = a.endMs ?? a.end_ms ?? Math.round((a.end || 0) * 1000);
    const endB = b.endMs ?? b.end_ms ?? Math.round((b.end || 0) * 1000);
    return endA - endB;
  });

  // Renumber ordinals and ensure consistent formatting
  return allCues.map((cue, idx) => {
    const startMs = cue.startMs ?? cue.start_ms ?? Math.round((cue.start || 0) * 1000);
    const endMs = cue.endMs ?? cue.end_ms ?? Math.round((cue.end || 0) * 1000);
    const wordIds = cue.wordIds || cue.word_ids || [];
    const speakerId = cue.speakerId || cue.speaker_id || null;
    return {
      ...cue,
      id: cue.id || `cue_${idx + 1}`,
      ordinal: idx + 1,
      start_ms: startMs,
      end_ms: endMs,
      startMs,
      endMs,
      start: startMs / 1000,
      end: endMs / 1000,
      word_ids: wordIds,
      wordIds,
      speaker_id: speakerId,
      speakerId,
    };
  });
}
