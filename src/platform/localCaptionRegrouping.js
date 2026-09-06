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
 * Regroups words into cues according to the specified policy.
 *
 * @param {Array<{id: string, text: string, start_ms: number, end_ms: number, speaker_id?: string, is_unaligned?: boolean}>} words
 * @param {string} policy - 'Natural' | 'Short' | 'One word' | 'Custom'
 * @param {object} [customOptions]
 * @returns {Array<object>} projected cues
 */
export function regroupWordsOffline(words, policy = 'Natural', customOptions = {}) {
  if (!Array.isArray(words) || words.length === 0) return [];

  if (policy === 'One word') {
    return words.map((w, idx) => ({
      id: `cue_${idx + 1}`,
      ordinal: idx + 1,
      start_ms: w.start_ms,
      end_ms: Math.max(w.end_ms, w.start_ms + 50),
      text: w.text,
      word_ids: [w.id],
      speaker_id: w.speaker_id || null,
      is_unaligned: Boolean(w.is_unaligned),
      manual_state: 'clean',
    }));
  }

  if (policy === 'Short') {
    const maxWords = 5;
    const maxDurationMs = 2500;
    const cues = [];
    let currentWords = [];

    for (const word of words) {
      const currentDuration = currentWords.length > 0
        ? word.end_ms - currentWords[0].start_ms
        : word.end_ms - word.start_ms;

      if (currentWords.length >= maxWords || currentDuration > maxDurationMs) {
        if (currentWords.length > 0) {
          cues.push({
            id: `cue_${cues.length + 1}`,
            ordinal: cues.length + 1,
            start_ms: currentWords[0].start_ms,
            end_ms: currentWords[currentWords.length - 1].end_ms,
            text: currentWords.map((w) => w.text).join(' '),
            word_ids: currentWords.map((w) => w.id),
            speaker_id: currentWords[0].speaker_id || null,
            manual_state: 'clean',
          });
          currentWords = [];
        }
      }
      currentWords.push(word);
    }
    if (currentWords.length > 0) {
      cues.push({
        id: `cue_${cues.length + 1}`,
        ordinal: cues.length + 1,
        start_ms: currentWords[0].start_ms,
        end_ms: currentWords[currentWords.length - 1].end_ms,
        text: currentWords.map((w) => w.text).join(' '),
        word_ids: currentWords.map((w) => w.id),
        speaker_id: currentWords[0].speaker_id || null,
        manual_state: 'clean',
      });
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

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const prevWord = currentWords[currentWords.length - 1];

      let shouldBreakBefore = false;
      if (prevWord) {
        const pause = word.start_ms - prevWord.end_ms;
        if (pause > pauseThresholdMs) {
          shouldBreakBefore = true;
        }
      }

      if (shouldBreakBefore && currentWords.length > 0) {
        cues.push({
          id: `cue_${cues.length + 1}`,
          ordinal: cues.length + 1,
          start_ms: currentWords[0].start_ms,
          end_ms: currentWords[currentWords.length - 1].end_ms,
          text: currentWords.map((w) => w.text).join(' '),
          word_ids: currentWords.map((w) => w.id),
          speaker_id: currentWords[0].speaker_id || null,
          manual_state: 'clean',
        });
        currentWords = [];
      }

      currentWords.push(word);

      let shouldBreakAfter = false;
      const currentDuration = word.end_ms - currentWords[0].start_ms;
      if (currentWords.length >= maxWords || currentDuration > maxDurationMs) {
        shouldBreakAfter = true;
      } else if (splitOnPunctuation && DEFAULT_SENTENCE_PUNCTUATION_REGEX.test(word.text.trim())) {
        shouldBreakAfter = true;
      }

      if (shouldBreakAfter && currentWords.length > 0) {
        cues.push({
          id: `cue_${cues.length + 1}`,
          ordinal: cues.length + 1,
          start_ms: currentWords[0].start_ms,
          end_ms: currentWords[currentWords.length - 1].end_ms,
          text: currentWords.map((w) => w.text).join(' '),
          word_ids: currentWords.map((w) => w.id),
          speaker_id: currentWords[0].speaker_id || null,
          manual_state: 'clean',
        });
        currentWords = [];
      }
    }

    if (currentWords.length > 0) {
      cues.push({
        id: `cue_${cues.length + 1}`,
        ordinal: cues.length + 1,
        start_ms: currentWords[0].start_ms,
        end_ms: currentWords[currentWords.length - 1].end_ms,
        text: currentWords.map((w) => w.text).join(' '),
        word_ids: currentWords.map((w) => w.id),
        speaker_id: currentWords[0].speaker_id || null,
        manual_state: 'clean',
      });
    }
    return cues;
  }

  // Default: Natural
  // Break on speech pause > 300ms, sentence punctuation [.?!], or max 12 words
  const maxWords = 12;
  const pauseThresholdMs = 300;

  const cues = [];
  let currentWords = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prevWord = currentWords[currentWords.length - 1];

    let shouldBreakBefore = false;
    if (prevWord) {
      const pause = word.start_ms - prevWord.end_ms;
      if (pause > pauseThresholdMs) {
        shouldBreakBefore = true;
      }
    }

    if (shouldBreakBefore && currentWords.length > 0) {
      cues.push({
        id: `cue_${cues.length + 1}`,
        ordinal: cues.length + 1,
        start_ms: currentWords[0].start_ms,
        end_ms: currentWords[currentWords.length - 1].end_ms,
        text: currentWords.map((w) => w.text).join(' '),
        word_ids: currentWords.map((w) => w.id),
        speaker_id: currentWords[0].speaker_id || null,
        manual_state: 'clean',
      });
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
      cues.push({
        id: `cue_${cues.length + 1}`,
        ordinal: cues.length + 1,
        start_ms: currentWords[0].start_ms,
        end_ms: currentWords[currentWords.length - 1].end_ms,
        text: currentWords.map((w) => w.text).join(' '),
        word_ids: currentWords.map((w) => w.id),
        speaker_id: currentWords[0].speaker_id || null,
        manual_state: 'clean',
      });
      currentWords = [];
    }
  }

  if (currentWords.length > 0) {
    cues.push({
      id: `cue_${cues.length + 1}`,
      ordinal: cues.length + 1,
      start_ms: currentWords[0].start_ms,
      end_ms: currentWords[currentWords.length - 1].end_ms,
      text: currentWords.map((w) => w.text).join(' '),
      word_ids: currentWords.map((w) => w.id),
      speaker_id: currentWords[0].speaker_id || null,
      manual_state: 'clean',
    });
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
  const unclaimedSlices = [];
  let currentSlice = [];

  for (const word of words) {
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
    const startA = a.start_ms ?? Math.round((a.start || 0) * 1000);
    const startB = b.start_ms ?? Math.round((b.start || 0) * 1000);
    if (startA !== startB) return startA - startB;
    const endA = a.end_ms ?? Math.round((a.end || 0) * 1000);
    const endB = b.end_ms ?? Math.round((b.end || 0) * 1000);
    return endA - endB;
  });

  // Renumber ordinals and ensure consistent formatting
  return allCues.map((cue, idx) => ({
    ...cue,
    id: cue.id || `cue_${idx + 1}`,
    ordinal: idx + 1,
    start_ms: cue.start_ms ?? Math.round((cue.start || 0) * 1000),
    end_ms: cue.end_ms ?? Math.round((cue.end || 0) * 1000),
    start: (cue.start_ms ?? Math.round((cue.start || 0) * 1000)) / 1000,
    end: (cue.end_ms ?? Math.round((cue.end || 0) * 1000)) / 1000,
  }));
}
