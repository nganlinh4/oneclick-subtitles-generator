// Formal Interface Contracts & Specifications for OSG Word-Native Transcription
// Derived directly from:
// - ORIGINAL_REQUEST.md (§R1-R6)
// - PROJECT.md (Architecture, Features F01-F24, Interface Contracts)
// - docs/rewrite/WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import assert from 'node:assert/strict';

/**
 * 1. Domain Types (Spec R1, F01)
 */

export const validateTimedWord = (word) => {
  assert.ok(word, 'TimedWord must not be null');
  assert.ok(typeof word.id === 'string' && word.id.length > 0, 'TimedWord must have a valid string/UUID id');
  assert.ok(typeof word.text === 'string', 'TimedWord text must be a string');
  assert.ok(Number.isInteger(word.start_ms) && word.start_ms >= 0, `start_ms must be non-negative integer, got ${word.start_ms}`);
  assert.ok(Number.isInteger(word.end_ms) && word.end_ms >= word.start_ms, `end_ms (${word.end_ms}) must be >= start_ms (${word.start_ms})`);
  if (word.speaker_id !== undefined && word.speaker_id !== null) {
    assert.ok(typeof word.speaker_id === 'string', 'speaker_id must be string when present');
  }
  if (word.confidence !== undefined && word.confidence !== null) {
    assert.ok(typeof word.confidence === 'number' && word.confidence >= 0 && word.confidence <= 1, 'confidence must be in [0, 1]');
  }
  if (word.is_unaligned !== undefined) {
    assert.ok(typeof word.is_unaligned === 'boolean', 'is_unaligned must be a boolean');
  }
  return true;
};

export const validateTranscriptTurn = (turn) => {
  assert.ok(turn, 'TranscriptTurn must not be null');
  assert.ok(typeof turn.turn_id === 'string' && turn.turn_id.length > 0, 'turn_id must be valid');
  assert.ok(typeof turn.speaker_id === 'string' && turn.speaker_id.length > 0, 'speaker_id must be valid');
  assert.ok(Number.isInteger(turn.start_ms) && turn.start_ms >= 0, 'start_ms must be non-negative');
  assert.ok(Number.isInteger(turn.end_ms) && turn.end_ms >= turn.start_ms, 'end_ms must be >= start_ms');
  assert.ok(Array.isArray(turn.word_ids), 'word_ids must be an array');
  return true;
};

export const validateTranscriptRevision = (revision) => {
  assert.ok(revision, 'TranscriptRevision must not be null');
  assert.ok(typeof revision.revision_id === 'string', 'revision_id must be valid string/UUID');
  assert.ok(typeof revision.project_id === 'string', 'project_id must be valid string/UUID');
  assert.ok(Number.isInteger(revision.created_at) && revision.created_at > 0, 'created_at must be positive timestamp');
  assert.ok(Array.isArray(revision.words), 'words must be an array');
  assert.ok(Array.isArray(revision.turns), 'turns must be an array');
  for (const word of revision.words) {
    validateTimedWord(word);
  }
  for (const turn of revision.turns) {
    validateTranscriptTurn(turn);
  }
  return true;
};

/**
 * 2. Provider Wire Protocol Contracts (Spec R2, F05-F07)
 */

export const MODEL_GEMINI_35_TRANSCRIBE = 'gemini-3.5-transcribe';

export const buildTranscriptionRequest = ({
  audioBase64,
  mimeType = 'audio/wav',
  wordTimestamp = true,
  diarization = false,
  languageHints = [],
}) => {
  assert.ok(audioBase64, 'audioBase64 payload required');
  const request = {
    contents: [{
      parts: [{
        inlineData: {
          mimeType,
          data: audioBase64,
        },
      }],
    }],
    generationConfig: {
      audioTranscriptionConfig: {
        wordTimestamp: Boolean(wordTimestamp),
        diarization: Boolean(diarization),
      },
    },
  };

  if (Array.isArray(languageHints) && languageHints.length > 0) {
    request.generationConfig.audioTranscriptionConfig.languageHints = languageHints;
  }

  // Enforce F07: Strict Provider Separation
  // Prompt, thinking, visual parameters must NOT be present
  assert.equal(request.contents[0].parts.some(p => p.text !== undefined), false, 'Transcription request must not contain text prompt');
  assert.equal('thinkingConfig' in request.generationConfig, false, 'Thinking config forbidden in ASR request');
  assert.equal('fps' in request.generationConfig, false, 'FPS forbidden in ASR request');
  assert.equal('responseSchema' in request.generationConfig, false, 'Prompt responseSchema forbidden in ASR request');

  return request;
};

/**
 * 3. Duration Parsing & 100ms Overshoot Projection Policy (Spec R2, F06)
 */

export const parseDurationToNanoseconds = (durationStr) => {
  if (typeof durationStr !== 'string' || !durationStr.endsWith('s')) {
    throw new Error(`Invalid duration string format: ${durationStr}`);
  }
  const numericPart = durationStr.slice(0, -1);
  if (numericPart.startsWith('-')) {
    throw new Error(`Negative duration offset disallowed: ${durationStr}`);
  }
  const parts = numericPart.split('.');
  if (parts.length > 2) {
    throw new Error(`Malformed duration decimal: ${durationStr}`);
  }
  const seconds = BigInt(parts[0] || '0');
  const fractionStr = (parts[1] || '').padEnd(9, '0').slice(0, 9);
  const nanos = BigInt(fractionStr);
  return seconds * 1_000_000_000n + nanos;
};

export const parseDurationToMs = (durationStr) => {
  const nanos = parseDurationToNanoseconds(durationStr);
  return Number(nanos / 1_000_000n);
};

export const projectWordWith100msOvershootPolicy = (rawWord, mediaDurationMs) => {
  const startMs = parseDurationToMs(rawWord.start_offset);
  const endMs = parseDurationToMs(rawWord.end_offset);

  if (endMs < startMs) {
    return { status: 'rejected', reason: 'reversed_timestamps', word: rawWord };
  }

  if (startMs > mediaDurationMs) {
    return { status: 'quarantined', reason: 'starts_after_media_end', word: rawWord };
  }

  if (endMs > mediaDurationMs) {
    const overshootMs = endMs - mediaDurationMs;
    if (overshootMs <= 100) {
      // Documented policy: clamp up to 100ms and record adjustment
      return {
        status: 'clamped',
        word: {
          ...rawWord,
          original_end_ms: endMs,
          clamped_end_ms: mediaDurationMs,
          overshoot_ms: overshootMs,
        },
      };
    } else {
      // Material overshoot > 100ms: quarantine rather than silently clamping arbitrary errors
      return {
        status: 'quarantined',
        reason: `overshoot_exceeds_100ms_${overshootMs}ms`,
        word: rawWord,
      };
    }
  }

  return {
    status: 'accepted',
    word: {
      ...rawWord,
      start_ms: startMs,
      end_ms: endMs,
    },
  };
};

/**
 * 4. Single Offset Projection for Engine (Spec R2, F08)
 */
export const projectWindowOffset = (windowStartMs, wordOffsetMs) => {
  assert.ok(windowStartMs >= 0, 'windowStartMs must be non-negative');
  assert.ok(wordOffsetMs >= 0, 'wordOffsetMs must be non-negative');
  return windowStartMs + wordOffsetMs;
};

/**
 * 5. Window Namespacing (Spec R2, F09)
 */
export const namespaceSpeaker = (windowIndex, rawSpeakerLabel) => {
  if (!rawSpeakerLabel) return 'speaker_0';
  return `w${windowIndex}:${rawSpeakerLabel}`;
};

/**
 * 6. Local Offline Regrouping Policies (Spec R4, F17)
 */
export const regroupWordsOffline = (words, policy, customOptions = {}) => {
  if (!words || words.length === 0) return [];

  if (policy === 'One word') {
    return words.map((w, idx) => ({
      id: `cue_${idx + 1}`,
      ordinal: idx + 1,
      start_ms: w.start_ms,
      end_ms: w.end_ms,
      text: w.text,
      word_ids: [w.id],
      is_unaligned: Boolean(w.is_unaligned),
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
            text: currentWords.map(w => w.text).join(' '),
            word_ids: currentWords.map(w => w.id),
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
        text: currentWords.map(w => w.text).join(' '),
        word_ids: currentWords.map(w => w.id),
      });
    }
    return cues;
  }

  if (policy === 'Custom') {
    const maxWords = customOptions.max_words || 8;
    const maxDurationMs = customOptions.max_duration_ms || 4000;
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
            text: currentWords.map(w => w.text).join(' '),
            word_ids: currentWords.map(w => w.id),
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
        text: currentWords.map(w => w.text).join(' '),
        word_ids: currentWords.map(w => w.id),
      });
    }
    return cues;
  }

  // Default: 'Natural'
  // Break on sentence punctuation [.?!], pause > 300ms, or max 12 words
  const maxWords = 12;
  const pauseThresholdMs = 300;
  const sentencePunctuationRegex = /[.?!]$/u;

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
        text: currentWords.map(w => w.text).join(' '),
        word_ids: currentWords.map(w => w.id),
      });
      currentWords = [];
    }

    currentWords.push(word);

    let shouldBreakAfter = false;
    if (currentWords.length >= maxWords) {
      shouldBreakAfter = true;
    } else if (sentencePunctuationRegex.test(word.text.trim())) {
      shouldBreakAfter = true;
    }

    if (shouldBreakAfter && currentWords.length > 0) {
      cues.push({
        id: `cue_${cues.length + 1}`,
        ordinal: cues.length + 1,
        start_ms: currentWords[0].start_ms,
        end_ms: currentWords[currentWords.length - 1].end_ms,
        text: currentWords.map(w => w.text).join(' '),
        word_ids: currentWords.map(w => w.id),
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
      text: currentWords.map(w => w.text).join(' '),
      word_ids: currentWords.map(w => w.id),
    });
  }

  return cues;
};

/**
 * 7. Shared Presentation Contract (Spec R5, F21)
 */
export const evaluateActivePresentation = (cues, words, timeMs, style = 'Standard') => {
  const activeCues = cues.filter(c => timeMs >= c.start_ms && timeMs <= c.end_ms);
  if (activeCues.length === 0) {
    return { activeCues: [], activeWords: [] };
  }

  const activeWords = [];
  if (style === 'WordReveal' || style === 'WordHighlight') {
    for (const cue of activeCues) {
      const cueWords = (cue.word_ids || [])
        .map(id => words.find(w => w.id === id))
        .filter(Boolean);

      for (const w of cueWords) {
        if (style === 'WordReveal') {
          // Reveals all words spoken up to timeMs
          if (timeMs >= w.start_ms) {
            activeWords.push({ ...w, state: 'revealed' });
          } else {
            activeWords.push({ ...w, state: 'hidden' });
          }
        } else if (style === 'WordHighlight') {
          // Highlights specifically the word being spoken right now
          if (timeMs >= w.start_ms && timeMs <= w.end_ms) {
            activeWords.push({ ...w, state: 'highlighted' });
          } else if (timeMs > w.end_ms) {
            activeWords.push({ ...w, state: 'past' });
          } else {
            activeWords.push({ ...w, state: 'upcoming' });
          }
        }
      }
    }
  }

  return { activeCues, activeWords };
};

/**
 * 8. SQLite Schema v15 Migration DDL Definition (Spec R1, F02)
 */
export const SQLITE_V15_MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS transcript_revisions (
  revision_id BLOB PRIMARY KEY NOT NULL CHECK(length(revision_id) = 16),
  project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id BLOB REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  provider_model TEXT NOT NULL CHECK(length(provider_model) > 0),
  word_count INTEGER NOT NULL DEFAULT 0 CHECK(word_count >= 0),
  turn_count INTEGER NOT NULL DEFAULT 0 CHECK(turn_count >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_revisions_project 
  ON transcript_revisions(project_id, created_at_ms);

CREATE TABLE IF NOT EXISTS transcript_words (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  revision_id BLOB NOT NULL REFERENCES transcript_revisions(revision_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
  speaker_id TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  is_unaligned INTEGER NOT NULL DEFAULT 0 CHECK(is_unaligned IN (0, 1)),
  UNIQUE(revision_id, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_words_timing 
  ON transcript_words(revision_id, start_ms, end_ms);

CREATE TABLE IF NOT EXISTS transcript_turns (
  turn_id BLOB PRIMARY KEY NOT NULL CHECK(length(turn_id) = 16),
  revision_id BLOB NOT NULL REFERENCES transcript_revisions(revision_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  speaker_id TEXT NOT NULL CHECK(length(speaker_id) > 0),
  start_ms INTEGER NOT NULL CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK(end_ms >= start_ms),
  word_ids_json TEXT NOT NULL CHECK(json_valid(word_ids_json)),
  UNIQUE(revision_id, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_transcript_turns_timing 
  ON transcript_turns(revision_id, start_ms, end_ms);

CREATE TABLE IF NOT EXISTS cue_word_mappings (
  cue_id BLOB NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
  word_id BLOB NOT NULL REFERENCES transcript_words(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  PRIMARY KEY(cue_id, word_id),
  UNIQUE(cue_id, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_cue_word_mappings_word ON cue_word_mappings(word_id);
`;
