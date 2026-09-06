-- 0015_word_native_transcripts.sql
-- Additive migration for word-native transcription, speaker turns, and caption projections.
-- All tables enforce STRICT typing and rigorous integrity checks matching OSG conventions.

-- 1. Transcript Revisions: Durable identity and metadata of a speech transcription run
CREATE TABLE transcript_revisions (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  project_id BLOB NOT NULL
    REFERENCES projects(id) ON DELETE CASCADE
    CHECK(length(project_id) = 16),
  media_id BLOB
    REFERENCES media_assets(id) ON DELETE SET NULL
    CHECK(media_id IS NULL OR length(media_id) = 16),
  provider TEXT NOT NULL
    CHECK(length(provider) BETWEEN 1 AND 64),
  model TEXT NOT NULL
    CHECK(length(model) BETWEEN 1 AND 128),
  source_range_start_ms INTEGER NOT NULL
    CHECK(source_range_start_ms >= 0),
  source_range_end_ms INTEGER NOT NULL
    CHECK(source_range_end_ms >= source_range_start_ms),
  state TEXT NOT NULL
    CHECK(state IN ('in_progress', 'completed', 'partial', 'failed')),
  fingerprint TEXT NOT NULL
    CHECK(length(fingerprint) <= 256),
  word_count INTEGER NOT NULL DEFAULT 0
    CHECK(word_count >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)),
  created_at_ms INTEGER NOT NULL
    CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL
    CHECK(updated_at_ms >= created_at_ms)
) STRICT;

CREATE INDEX transcript_revisions_project_idx
  ON transcript_revisions(project_id, created_at_ms);

CREATE INDEX transcript_revisions_media_idx
  ON transcript_revisions(media_id)
  WHERE media_id IS NOT NULL;

-- 2. Transcript Turns: Grouping of words into speaker utterances
CREATE TABLE transcript_turns (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  revision_id BLOB NOT NULL
    REFERENCES transcript_revisions(id) ON DELETE CASCADE
    CHECK(length(revision_id) = 16),
  ordinal INTEGER NOT NULL
    CHECK(ordinal >= 0),
  speaker_id TEXT NOT NULL
    CHECK(length(speaker_id) BETWEEN 1 AND 64),
  start_ms INTEGER NOT NULL
    CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL
    CHECK(end_ms >= start_ms),
  text TEXT NOT NULL
    CHECK(length(text) <= 1000000),
  start_word_ordinal INTEGER NOT NULL
    CHECK(start_word_ordinal >= 0),
  end_word_ordinal INTEGER NOT NULL
    CHECK(end_word_ordinal >= start_word_ordinal),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)),
  UNIQUE(revision_id, ordinal)
) STRICT;

CREATE INDEX transcript_turns_timeline_idx
  ON transcript_turns(revision_id, start_ms, end_ms);

CREATE INDEX transcript_turns_speaker_idx
  ON transcript_turns(revision_id, speaker_id);

-- 3. Transcript Words: Immutable provider word observations and projected project intervals
CREATE TABLE transcript_words (
  id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
  revision_id BLOB NOT NULL
    REFERENCES transcript_revisions(id) ON DELETE CASCADE
    CHECK(length(revision_id) = 16),
  turn_id BLOB
    REFERENCES transcript_turns(id) ON DELETE SET NULL
    CHECK(turn_id IS NULL OR length(turn_id) = 16),
  ordinal INTEGER NOT NULL
    CHECK(ordinal >= 0),
  text TEXT NOT NULL
    CHECK(length(text) BETWEEN 1 AND 1024),
  raw_start_ns INTEGER NOT NULL
    CHECK(raw_start_ns >= 0),
  raw_end_ns INTEGER NOT NULL
    CHECK(raw_end_ns >= raw_start_ns),
  start_ms INTEGER NOT NULL
    CHECK(start_ms >= 0),
  end_ms INTEGER NOT NULL
    CHECK(end_ms >= start_ms),
  speaker_id TEXT
    CHECK(speaker_id IS NULL OR length(speaker_id) <= 64),
  confidence REAL
    CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
  is_unaligned INTEGER NOT NULL DEFAULT 0
    CHECK(is_unaligned IN (0, 1)),
  alignment_status TEXT NOT NULL DEFAULT 'aligned'
    CHECK(alignment_status IN ('aligned', 'modified', 'unaligned')),
  provenance TEXT NOT NULL DEFAULT 'provider'
    CHECK(provenance IN ('provider', 'manual', 'interpolated', 'synthesized')),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)),
  UNIQUE(revision_id, ordinal)
) STRICT;

CREATE INDEX transcript_words_timeline_idx
  ON transcript_words(revision_id, start_ms, end_ms);

CREATE INDEX transcript_words_speaker_idx
  ON transcript_words(revision_id, speaker_id)
  WHERE speaker_id IS NOT NULL;

CREATE INDEX transcript_words_turn_idx
  ON transcript_words(turn_id)
  WHERE turn_id IS NOT NULL;

-- 4. Cue Word Mappings: Relational link between displayed caption cues and source transcript words
CREATE TABLE cue_word_mappings (
  cue_id BLOB NOT NULL
    REFERENCES cues(id) ON DELETE CASCADE
    CHECK(length(cue_id) = 16),
  word_id BLOB NOT NULL
    REFERENCES transcript_words(id) ON DELETE CASCADE
    CHECK(length(word_id) = 16),
  word_ordinal INTEGER NOT NULL
    CHECK(word_ordinal >= 0),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(metadata_json)),
  PRIMARY KEY(cue_id, word_id),
  UNIQUE(cue_id, word_ordinal)
) STRICT;

CREATE INDEX cue_word_mappings_word_idx
  ON cue_word_mappings(word_id);
