// E2E Test Harness for OneClick Subtitles Generator Word-Native Transcription
// Provides isolated in-memory/temp SQLite database fixtures, provider mocks,
// and journey verification utilities for opaque-box testing.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';
import { SQLITE_V15_MIGRATION_DDL } from './contracts.mjs';

/** Convert UUID string to 16-byte Buffer */
export const uuidToBuffer = (uuidStr) => {
  const clean = uuidStr.replace(/-/g, '');
  return Buffer.from(clean, 'hex');
};

/** Convert 16-byte Buffer to UUID string */
export const bufferToUuid = (buf) => {
  const hex = Buffer.from(buf).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Create a fresh in-memory SQLite database with base schema (v1-v14) */
export const createBaseDatabase = () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');

  // Core tables matching OSG v1-v14 schema
  db.exec(`
    CREATE TABLE projects (
      id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
      title TEXT NOT NULL,
      state_version INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE media_assets (
      id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
      kind TEXT NOT NULL CHECK(kind IN ('audio', 'video')),
      display_name TEXT NOT NULL,
      extension TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_hash BLOB,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE project_media (
      project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      media_id BLOB NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('primary', 'source', 'reference', 'background')),
      ordinal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id, media_id, role)
    ) STRICT;

    CREATE TABLE cues (
      id BLOB PRIMARY KEY NOT NULL CHECK(length(id) = 16),
      project_id BLOB NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      track_id BLOB NOT NULL,
      ordinal INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      text TEXT NOT NULL
    ) STRICT;

    CREATE TABLE app_settings (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      PRIMARY KEY(scope, key)
    ) STRICT;
  `);

  return db;
};

/** Apply additive v15 word-native migration to database */
export const applyV15Migration = (db) => {
  db.exec(SQLITE_V15_MIGRATION_DDL);
};

/** Seed a sample project into database */
export const seedProject = (db, { id = randomUUID(), title = 'Test Project', durationMs = 120_000 } = {}) => {
  const projectBuffer = uuidToBuffer(id);
  const now = Date.now();
  db.prepare(`
    INSERT INTO projects (id, title, state_version, created_at_ms, updated_at_ms)
    VALUES (?, ?, 1, ?, ?)
  `).run(projectBuffer, title, now, now);

  const mediaId = randomUUID();
  const mediaBuffer = uuidToBuffer(mediaId);
  db.prepare(`
    INSERT INTO media_assets (id, kind, display_name, extension, size_bytes, content_hash, metadata_json, created_at_ms)
    VALUES (?, 'video', 'sample.mp4', 'mp4', 1048576, ?, ?, ?)
  `).run(mediaBuffer, randomBytes(32), JSON.stringify({ duration_ms: durationMs }), now);

  db.prepare(`
    INSERT INTO project_media (project_id, media_id, role, ordinal)
    VALUES (?, ?, 'primary', 0)
  `).run(projectBuffer, mediaBuffer);

  return { projectId: id, mediaId, projectBuffer, mediaBuffer };
};

/** Build simulated provider SSE chunk with audioTranscription */
export const createProviderSseChunk = ({
  words = [],
  isDone = false,
  finishReason = isDone ? 'STOP' : undefined,
}) => {
  if (isDone) {
    return 'data: [DONE]\n\n';
  }

  const payload = {
    candidates: [{
      content: {
        parts: [{
          audioTranscription: {
            words: words.map(w => ({
              word: w.word,
              startOffset: w.startOffset,
              endOffset: w.endOffset,
              speakerLabel: w.speakerLabel,
            })),
          },
        }],
      },
      finishReason,
    }],
  };

  return `data: ${JSON.stringify(payload)}\n\n`;
};

/** Synthesize a multi-window batch of words with realistic timing */
export const synthesizeWordSequence = (tokens, { startMs = 0, avgWordDurationMs = 350, avgPauseMs = 120, speaker = '1' } = {}) => {
  let currentMs = startMs;
  return tokens.map((token, idx) => {
    const wordStart = currentMs;
    const wordEnd = wordStart + avgWordDurationMs;
    currentMs = wordEnd + avgPauseMs;
    return {
      id: randomUUID(),
      ordinal: idx,
      text: token,
      start_ms: wordStart,
      end_ms: wordEnd,
      speaker_id: speaker,
      confidence: 0.95,
      is_unaligned: false,
    };
  });
};
