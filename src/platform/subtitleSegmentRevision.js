// Segment-scoped subtitle revisions: capture the durable rows a segment regeneration owns, then
// compare-and-swap only that range back into the project's cached subtitle track.
import { legacyRowsToCanonicalTrack } from './projectSnapshotAdapter';
import { SUBTITLE_CACHE_TRACK_LABEL, SubtitleProjectStoreError } from './subtitleProjectAliasIndex';
import {
  EDITOR_TRACK_SELECTOR,
  cachedTrack,
  cloneRows,
  conflict,
  mergeSegmentRows,
  readRows,
  rowsEqual,
  rowsMatch,
  rowsTouchingSegment,
  validateSegment,
  writeRows,
} from './subtitleTrackRows';

const REPLACE_SEGMENT_REASON = 'Replace regenerated subtitle segment';
const segmentRevisionTokens = new WeakMap();

export const createSubtitleSegmentRevisions = ({ resolve, projects }) => {
  /**
   * Capture the exact durable rows owned by a segment operation. The public
   * token contains diagnostics only; its baseline is kept in this store so a
   * caller cannot forge or mutate the compare-and-swap precondition.
   */
  const captureSegmentRevision = async (
    cacheId,
    segment,
    { expectedProjectId = null } = {}
  ) => {
    const range = validateSegment(segment);
    const resolved = await resolve(cacheId, { create: true });
    if (!resolved?.projectId
        || (expectedProjectId !== null && resolved.projectId !== expectedProjectId)) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The active subtitle project changed before its segment could be captured'
      );
    }
    let snapshot = null;
    let status = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      snapshot = await projects.loadProject(resolved.projectId);
      if (snapshot === null) throw conflict(resolved.snapshot);
      status = await projects.getProjectTrackHistoryStatus(
        resolved.projectId,
        EDITOR_TRACK_SELECTOR
      );
      if (status.stateVersion === snapshot.stateVersion) break;
      snapshot = null;
      status = null;
    }
    if (snapshot === null || status === null) {
      throw new SubtitleProjectStoreError(
        'subtitleSegmentConflict',
        'The subtitle project changed while its segment revision was being captured'
      );
    }
    const token = Object.freeze({
      kind: 'subtitle-segment-revision',
      cacheId: resolved.cacheId,
      projectId: resolved.projectId,
      segment: range,
      stateVersion: snapshot.stateVersion,
      historyVersion: status.historyVersion,
    });
    segmentRevisionTokens.set(token, Object.freeze({
      baseline: cloneRows(rowsTouchingSegment(readRows(snapshot), range)),
    }));
    return token;
  };

  /**
   * Atomically replace only the captured range. ProjectService retries once
   * against an authoritative snapshot, so edits outside the range survive a
   * concurrent commit. A change inside the range fails closed instead of
   * overwriting newer user work.
   */
  const commitSegmentRevision = async (revision, replacement, {
    expectedProjectId = null,
  } = {}) => {
    const owned = revision && typeof revision === 'object'
      ? segmentRevisionTokens.get(revision)
      : null;
    if (!owned || revision.kind !== 'subtitle-segment-revision') {
      throw new SubtitleProjectStoreError(
        'invalidSubtitleSegmentRevision',
        'A captured subtitle segment revision is required'
      );
    }
    if (expectedProjectId !== null && revision.projectId !== expectedProjectId) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The active subtitle project changed before its segment could be saved'
      );
    }
    if (!Array.isArray(replacement)) {
      throw new SubtitleProjectStoreError(
        'invalidSubtitles',
        'A regenerated subtitle segment must be an array'
      );
    }
    if (replacement.length > 0) {
      legacyRowsToCanonicalTrack(replacement, { label: SUBTITLE_CACHE_TRACK_LABEL });
    }
    replacement.forEach((row) => {
      if (row.start < revision.segment.start || row.end > revision.segment.end) {
        throw new SubtitleProjectStoreError(
          'invalidSubtitleSegment',
          'Regenerated subtitles must stay inside the captured segment'
        );
      }
    });

    const resolved = await resolve(revision.cacheId);
    if (!resolved?.projectId || resolved.projectId !== revision.projectId) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The subtitle project alias no longer identifies the captured project'
      );
    }

    let result = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await projects.loadProject(revision.projectId);
      if (current === null) throw conflict(resolved.snapshot);
      const status = await projects.getProjectTrackHistoryStatus(
        revision.projectId,
        EDITOR_TRACK_SELECTOR
      );
      if (status.stateVersion !== current.stateVersion) {
        if (attempt < 2) continue;
        throw new SubtitleProjectStoreError(
          'subtitleSegmentConflict',
          'The subtitle project kept changing while its segment was being committed',
          { authoritativeRows: cloneRows(readRows(current)) }
        );
      }
      if (current.stateVersion < revision.stateVersion
          || status.historyVersion < revision.historyVersion) {
        throw new SubtitleProjectStoreError(
          'subtitleSegmentConflict',
          'The selected subtitle segment revision is no longer available',
          { authoritativeRows: cloneRows(readRows(current)) }
        );
      }

      const currentRows = readRows(current);
      const currentSegment = rowsTouchingSegment(currentRows, revision.segment);
      if (!rowsEqual(currentSegment, owned.baseline)) {
        throw new SubtitleProjectStoreError(
          'subtitleSegmentConflict',
          'The selected subtitle segment changed while it was being regenerated',
          { authoritativeRows: cloneRows(currentRows) }
        );
      }
      const merged = mergeSegmentRows(currentRows, replacement, revision.segment);
      if (rowsMatch(current, merged)) {
        result = { snapshot: current, status };
        break;
      }
      const candidate = writeRows(current, merged);
      try {
        result = await projects.commitProjectTrack({
          id: revision.projectId,
          selector: EDITOR_TRACK_SELECTOR,
          expectedHistoryVersion: status.historyVersion,
          beforeTrack: cachedTrack(current),
          afterTrack: cachedTrack(candidate),
          reason: REPLACE_SEGMENT_REASON,
        });
        break;
      } catch (error) {
        const retryable = error?.code === 'staleProjectVersion'
          || error?.code === 'staleProjectTrackHistory'
          || error?.code === 'projectTrackHistoryDiverged';
        if (!retryable || attempt === 2) throw error;
      }
    }
    if (result === null) {
      throw new SubtitleProjectStoreError(
        'subtitleSegmentConflict',
        'The selected subtitle segment could not be committed atomically'
      );
    }
    const rows = readRows(result.snapshot);
    return Object.freeze({
      cacheId: revision.cacheId,
      projectId: revision.projectId,
      stateVersion: result.snapshot.stateVersion,
      rows: Object.freeze(cloneRows(rows).map(Object.freeze)),
    });
  };

  return Object.freeze({ captureSegmentRevision, commitSegmentRevision });
};
