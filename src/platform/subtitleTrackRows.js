// Pure conversions between the legacy editor's subtitle rows and the project's cached subtitle
// track: reading/writing rows, semantic comparison, segment merging and identity rebinding.
import {
  legacyRowsToCanonicalTrack,
  readLegacySubtitleTrack,
  removeLegacySubtitleTrack,
  replaceLegacySubtitleTrack,
} from './projectSnapshotAdapter';
import { SUBTITLE_CACHE_TRACK_LABEL, SubtitleProjectStoreError } from './subtitleProjectAliasIndex';

export const EDITOR_TRACK_SELECTOR = Object.freeze({
  label: SUBTITLE_CACHE_TRACK_LABEL,
  origin: 'legacyJson',
});

export const readRows = (snapshot) => (
  readLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL }) ?? []
);

export const validateSegment = (segment) => {
  const start = segment?.start;
  const end = segment?.end;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
    throw new SubtitleProjectStoreError(
      'invalidSubtitleSegment',
      'A valid subtitle segment is required'
    );
  }
  return Object.freeze({ start, end });
};

export const cloneRows = (rows) => rows.map((row) => ({ ...row }));

export const rowsTouchingSegment = (rows, segment) => rows.filter((row) => (
  row.start < segment.end && row.end > segment.start
));

export const rowsEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const mergeSegmentRows = (rows, replacement, segment) => {
  const preserved = [];
  rows.forEach((row) => {
    if (row.end <= segment.start || row.start >= segment.end) {
      preserved.push(row);
    } else if (row.start < segment.start && row.end > segment.end) {
      preserved.push({ ...row, end: segment.start });
      preserved.push({ ...row, start: segment.end });
    } else if (row.start < segment.start && row.end > segment.start) {
      preserved.push({ ...row, end: segment.start });
    } else if (row.start < segment.end && row.end > segment.end) {
      preserved.push({ ...row, start: segment.end });
    }
  });
  return [...preserved, ...replacement]
    .sort((left, right) => left.start - right.start);
};

export const writeRows = (snapshot, rows) => {
  if (!Array.isArray(rows)) {
    throw new SubtitleProjectStoreError(
      'invalidSubtitles',
      'Subtitle editor rows must be an array'
    );
  }
  if (rows.length === 0) {
    return removeLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL });
  }
  return replaceLegacySubtitleTrack(snapshot, rows, { label: SUBTITLE_CACHE_TRACK_LABEL });
};

const comparableTrack = (trackValue) => {
  if (trackValue == null) return null;
  const ordinalById = new Map(trackValue.cues.map((cue) => [cue.id, cue.ordinal]));
  return {
    label: trackValue.label,
    origin: trackValue.origin,
    cues: trackValue.cues.map((cue) => ({
      ordinal: cue.ordinal,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      speaker: cue.speaker ?? null,
      sourceOrdinal: cue.sourceId == null ? null : ordinalById.get(cue.sourceId) ?? null,
    })),
  };
};

export const cachedTrack = (snapshot) => snapshot.tracks.find((candidate) => (
  candidate.origin === 'legacyJson' && candidate.label === SUBTITLE_CACHE_TRACK_LABEL
)) ?? null;

const identityFreeTrack = (rows, snapshot) => {
  if (rows.length === 0) return null;
  const existing = cachedTrack(snapshot);
  return legacyRowsToCanonicalTrack(rows, {
    label: existing?.label ?? SUBTITLE_CACHE_TRACK_LABEL,
    origin: existing?.origin ?? 'legacyJson',
  });
};

export const rowsMatch = (snapshot, rows) => {
  // Local numeric IDs are ordinals from the revision in which the editor loaded them. Inserting
  // a UUID cue shifts later native ordinals, so canonicalizing against the *current* track can
  // bind local ID 2 to the newly inserted cue and even report a duplicate before semantics are
  // compared. Validate/canonicalize independently, then compare only timing, text and lineage.
  return JSON.stringify(comparableTrack(identityFreeTrack(rows, snapshot)))
    === JSON.stringify(comparableTrack(cachedTrack(snapshot)));
};

const localIdentityKey = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number'
      && typeof value !== 'boolean') return null;
  return `${typeof value}:${JSON.stringify(value)}`;
};

const rowStartMs = (row) => Math.round((row.start ?? row.startTime) * 1_000);
const rowEndMs = (row) => Math.round((row.end ?? row.endTime) * 1_000);

/**
 * Rebind this editor revision's local identities to the exact native baseline.
 *
 * Legacy rows expose numeric ordinals while newly-created rows already carry UUIDv7. Ordinals
 * are not identities after insert/delete/split, so pair the semantically matched, sorted baseline
 * with its authoritative native cues and translate every identity carried into the replacement.
 */
export const bindEditorRowIdentities = (beforeTrack, beforeRows, afterRows) => {
  if (beforeTrack === null) return afterRows;
  const orderedBefore = beforeRows.map((row, inputIndex) => ({ row, inputIndex }))
    .sort((left, right) => (
      rowStartMs(left.row) - rowStartMs(right.row)
        || rowEndMs(left.row) - rowEndMs(right.row)
        || left.inputIndex - right.inputIndex
    ));
  if (orderedBefore.length !== beforeTrack.cues.length) return afterRows;

  const nativeIdByLocal = new Map();
  orderedBefore.forEach(({ row }, index) => {
    const key = localIdentityKey(row.id);
    if (key !== null) nativeIdByLocal.set(key, beforeTrack.cues[index].id);
  });
  const rebound = (value) => {
    const key = localIdentityKey(value);
    return key !== null && nativeIdByLocal.has(key) ? nativeIdByLocal.get(key) : value;
  };
  return afterRows.map((row) => {
    const next = { ...row };
    if (Object.prototype.hasOwnProperty.call(next, 'id')) next.id = rebound(next.id);
    if (Object.prototype.hasOwnProperty.call(next, 'originalId')) {
      next.originalId = rebound(next.originalId);
    }
    if (Object.prototype.hasOwnProperty.call(next, 'sourceId')) {
      next.sourceId = rebound(next.sourceId);
    }
    return next;
  });
};

export const conflict = (snapshot) => new SubtitleProjectStoreError(
  'subtitleHistoryDiverged',
  'The durable subtitle track changed outside this editor history',
  { authoritativeRows: readRows(snapshot), authoritativeSnapshot: snapshot }
);

export const mapHistoryError = (error) => (
  error?.authoritativeSnapshot == null ? error : conflict(error.authoritativeSnapshot)
);
