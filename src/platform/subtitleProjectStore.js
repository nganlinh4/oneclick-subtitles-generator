import { invokeDesktop } from './desktopRuntime';
import {
  commitProjectTrack,
  createProject,
  getProjectTrackHistoryStatus,
  loadProject,
  mutateProject,
  redoProjectTrack,
  undoProjectTrack,
} from './projectService';
import {
  isUuidV7,
  legacyRowsToCanonicalTrack,
  readLegacySubtitleTrack,
  removeLegacySubtitleTrack,
  replaceLegacySubtitleTrack,
} from './projectSnapshotAdapter';

export const SUBTITLE_PROJECT_INDEX_KEY = 'project.subtitleCacheIndex.v1';
export const SUBTITLE_CACHE_TRACK_LABEL = 'Cached subtitles';
export const MAX_SUBTITLE_PROJECT_ALIASES = 2_048;
export const MAX_SUBTITLE_PROJECT_INDEX_BYTES = 900 * 1024;

const INDEX_SCHEMA_VERSION = 1;
const SAVE_REASON = 'Save cached subtitles';
const CLEAR_REASON = 'Clear cached subtitles for retry';
const REPLACE_SEGMENT_REASON = 'Replace regenerated subtitle segment';
const EDITOR_TRACK_SELECTOR = Object.freeze({
  label: SUBTITLE_CACHE_TRACK_LABEL,
  origin: 'legacyJson',
});
const segmentRevisionTokens = new WeakMap();

const isControlCharacter = (character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
};

export class SubtitleProjectStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SubtitleProjectStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

const validateCacheId = (cacheId) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192) {
    throw new SubtitleProjectStoreError('invalidCacheId', 'A bounded subtitle cache ID is required');
  }
  return cacheId;
};

const projectNameForCache = (cacheId) => {
  const cleaned = Array.from(cacheId, (character) => (
    isControlCharacter(character) ? ' ' : character
  )).join('').trim();
  const name = Array.from(cleaned).slice(0, 200).join('').trim();
  return name || 'Subtitles';
};

const emptyIndex = () => ({
  schemaVersion: INDEX_SCHEMA_VERSION,
  activeCacheId: null,
  entries: [],
});

const indexSize = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

const parseSerializedIndex = (value) => {
  if (typeof value !== 'string' || value.length === 0
      || value.length > MAX_SUBTITLE_PROJECT_INDEX_BYTES) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeIndex = (rawValue) => {
  const value = parseSerializedIndex(rawValue);
  if (!value || value.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(value.entries)) {
    return emptyIndex();
  }

  const entries = [];
  const seenCacheIds = new Set();
  const seenProjectIds = new Set();
  value.entries.forEach((entry) => {
    if (!entry || typeof entry.cacheId !== 'string' || entry.cacheId.length === 0
        || entry.cacheId.length > 8_192 || !isUuidV7(entry.projectId)
        || !Number.isSafeInteger(entry.lastOpenedAt) || entry.lastOpenedAt < 0
        || seenCacheIds.has(entry.cacheId) || seenProjectIds.has(entry.projectId)) {
      return;
    }
    seenCacheIds.add(entry.cacheId);
    seenProjectIds.add(entry.projectId);
    entries.push({
      cacheId: entry.cacheId,
      projectId: entry.projectId,
      lastOpenedAt: entry.lastOpenedAt,
    });
  });

  entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
  const bounded = entries.slice(0, MAX_SUBTITLE_PROJECT_ALIASES);
  const activeCacheId = typeof value.activeCacheId === 'string'
      && bounded.some((entry) => entry.cacheId === value.activeCacheId)
    ? value.activeCacheId
    : null;
  return { schemaVersion: INDEX_SCHEMA_VERSION, activeCacheId, entries: bounded };
};

export const createSubtitleProjectStore = ({
  invokeCommand = invokeDesktop,
  projects = {
    commitProjectTrack,
    createProject,
    getProjectTrackHistoryStatus,
    loadProject,
    mutateProject,
    redoProjectTrack,
    undoProjectTrack,
  },
  now = Date.now,
} = {}) => {
  let index = null;
  let indexTail = Promise.resolve();

  const enqueueIndex = (operation) => {
    const result = indexTail.then(operation, operation);
    indexTail = result.catch(() => undefined);
    return result;
  };

  const loadIndexDirect = async () => {
    if (index === null) {
      index = normalizeIndex(await invokeCommand('setting_get', {
        key: SUBTITLE_PROJECT_INDEX_KEY,
      }));
    }
    return index;
  };

  const persistIndexDirect = async () => {
    index = normalizeIndex(index);
    while (index.entries.length > 1 && indexSize(index) > MAX_SUBTITLE_PROJECT_INDEX_BYTES) {
      index.entries.pop();
    }
    if (!index.entries.some((entry) => entry.cacheId === index.activeCacheId)) {
      index.activeCacheId = null;
    }
    if (indexSize(index) > MAX_SUBTITLE_PROJECT_INDEX_BYTES) {
      throw new SubtitleProjectStoreError(
        'projectIndexTooLarge',
        'The subtitle project alias is too large to persist safely'
      );
    }
    await invokeCommand('setting_set', {
      key: SUBTITLE_PROJECT_INDEX_KEY,
      value: index,
    });
  };

  const markActiveDirect = async (entry) => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new SubtitleProjectStoreError('invalidClock', 'The project clock is invalid');
    }
    entry.lastOpenedAt = timestamp;
    index.activeCacheId = entry.cacheId;
    index.entries.sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    index.entries = index.entries.slice(0, MAX_SUBTITLE_PROJECT_ALIASES);
    await persistIndexDirect();
  };

  const resolve = (cacheId, { create = false } = {}) => {
    const alias = validateCacheId(cacheId);
    return enqueueIndex(async () => {
      await loadIndexDirect();
      let entry = index.entries.find((candidate) => candidate.cacheId === alias) ?? null;
      let snapshot = entry == null ? null : await projects.loadProject(entry.projectId);

      if (entry !== null && snapshot === null) {
        index.entries = index.entries.filter((candidate) => candidate !== entry);
        if (index.activeCacheId === alias) index.activeCacheId = null;
        entry = null;
        await persistIndexDirect();
      }

      if (entry === null && create) {
        snapshot = await projects.createProject(projectNameForCache(alias));
        entry = {
          cacheId: alias,
          projectId: snapshot.metadata.id,
          lastOpenedAt: now(),
        };
        index.entries.unshift(entry);
      }

      if (entry === null) return null;
      await markActiveDirect(entry);
      return { cacheId: alias, projectId: entry.projectId, snapshot };
    });
  };

  const loadSubtitles = async (cacheId) => {
    const resolved = await resolve(cacheId);
    if (resolved === null || resolved.snapshot === null) return null;
    return readLegacySubtitleTrack(resolved.snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL });
  };

  /**
   * Load only from the project captured by the caller. This deliberately does
   * not call `resolve`, because resolving an alias after an asynchronous gap
   * could silently follow a repaired/recreated alias to a different project.
   */
  const loadExactProjectSubtitles = (cacheId, expectedProjectId) => {
    const alias = validateCacheId(cacheId);
    if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The subtitle project changed before its subtitles could be loaded'
      );
    }
    return enqueueIndex(async () => {
      await loadIndexDirect();
      const captured = index.entries.find((candidate) => candidate.cacheId === alias) ?? null;
      if (captured?.projectId !== expectedProjectId) {
        throw new SubtitleProjectStoreError(
          'projectScopeMismatch',
          'The subtitle project changed before its subtitles could be loaded'
        );
      }

      const snapshot = await projects.loadProject(expectedProjectId);
      // Re-resolve the alias after the native read. A deletion/repair or an
      // alias remap must invalidate this candidate even if the old snapshot
      // happened to finish loading successfully.
      const current = index.entries.find((candidate) => candidate.cacheId === alias) ?? null;
      if (current?.projectId !== expectedProjectId
          || snapshot?.metadata?.id !== expectedProjectId) {
        throw new SubtitleProjectStoreError(
          'projectScopeMismatch',
          'The subtitle project changed before its subtitles could be loaded'
        );
      }
      return readLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL });
    });
  };

  const readRows = (snapshot) => (
    readLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL }) ?? []
  );

  const validateSegment = (segment) => {
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

  const cloneRows = (rows) => rows.map((row) => ({ ...row }));

  const rowsTouchingSegment = (rows, segment) => rows.filter((row) => (
    row.start < segment.end && row.end > segment.start
  ));

  const rowsEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const mergeSegmentRows = (rows, replacement, segment) => {
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

  const writeRows = (snapshot, rows) => {
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
        sourceOrdinal: cue.sourceId == null ? null : ordinalById.get(cue.sourceId) ?? null,
      })),
    };
  };

  const cachedTrack = (snapshot) => snapshot.tracks.find((candidate) => (
    candidate.origin === 'legacyJson' && candidate.label === SUBTITLE_CACHE_TRACK_LABEL
  )) ?? null;

  const rowsMatch = (snapshot, rows) => {
    const candidate = writeRows(snapshot, rows);
    return JSON.stringify(comparableTrack(cachedTrack(candidate)))
      === JSON.stringify(comparableTrack(cachedTrack(snapshot)));
  };

  const conflict = (snapshot) => new SubtitleProjectStoreError(
    'subtitleHistoryDiverged',
    'The durable subtitle track changed outside this editor history',
    { authoritativeRows: readRows(snapshot), authoritativeSnapshot: snapshot }
  );

  const mapHistoryError = (error) => (
    error?.authoritativeSnapshot == null ? error : conflict(error.authoritativeSnapshot)
  );

  const commitEditorRevision = async (cacheId, beforeRows, afterRows, reason) => {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new SubtitleProjectStoreError(
        'invalidRevisionReason',
        'A subtitle editor revision reason is required'
      );
    }
    if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
      throw new SubtitleProjectStoreError(
        'invalidSubtitles',
        'Subtitle editor revisions require before and after arrays'
      );
    }
    // Validate both sides before an empty cache alias can create a durable project.
    if (beforeRows.length > 0) {
      legacyRowsToCanonicalTrack(beforeRows, { label: SUBTITLE_CACHE_TRACK_LABEL });
    }
    if (afterRows.length > 0) {
      legacyRowsToCanonicalTrack(afterRows, { label: SUBTITLE_CACHE_TRACK_LABEL });
    }

    const resolved = await resolve(cacheId, { create: true });
    const history = await projects.getProjectTrackHistoryStatus(
      resolved.projectId,
      EDITOR_TRACK_SELECTOR
    );
    const current = await projects.loadProject(resolved.projectId);
    if (current === null) throw conflict(resolved.snapshot);
    if (rowsMatch(current, afterRows)) {
      if (history.undoReason === reason || rowsMatch(current, beforeRows)) {
        return { snapshot: current, status: history };
      }
    }

    if (!rowsMatch(current, beforeRows)) {
      const hasTrack = readLegacySubtitleTrack(current, {
        label: SUBTITLE_CACHE_TRACK_LABEL,
      }) !== null;
      const canBootstrapUnsaved = !hasTrack
        && beforeRows.length > 0
        && history.historyVersion === 0;
      if (!canBootstrapUnsaved) throw conflict(current);
    }

    const beforeSnapshot = writeRows(current, beforeRows);
    const afterSnapshot = writeRows(beforeSnapshot, afterRows);
    const result = await projects.commitProjectTrack({
      id: resolved.projectId,
      selector: EDITOR_TRACK_SELECTOR,
      expectedHistoryVersion: history.historyVersion,
      beforeTrack: cachedTrack(beforeSnapshot),
      afterTrack: cachedTrack(afterSnapshot),
      reason,
    });
    return {
      snapshot: result.snapshot,
      status: result.status,
    };
  };

  const historyStatus = async (cacheId) => {
    const resolved = await resolve(cacheId);
    if (resolved === null || resolved.snapshot === null) return null;
    try {
      const status = await projects.getProjectTrackHistoryStatus(
        resolved.projectId,
        EDITOR_TRACK_SELECTOR
      );
      const result = {
        projectId: resolved.projectId,
        ...status,
      };
      if (status.diverged) {
        const authoritative = await projects.loadProject(resolved.projectId);
        if (authoritative === null) throw conflict(resolved.snapshot);
        result.authoritativeRows = readRows(authoritative);
      }
      return result;
    } catch (error) {
      throw mapHistoryError(error);
    }
  };

  const navigateHistory = async (
    cacheId,
    direction,
    expectedHistoryVersion,
    expectedReason
  ) => {
    const resolved = await resolve(cacheId);
    if (resolved === null || resolved.snapshot === null) return null;
    const navigate = direction === 'undo'
      ? projects.undoProjectTrack
      : projects.redoProjectTrack;
    if (typeof navigate !== 'function') {
      throw new SubtitleProjectStoreError(
        'invalidHistoryDirection',
        'The subtitle history direction is invalid'
      );
    }
    try {
      const result = await navigate({
        id: resolved.projectId,
        selector: EDITOR_TRACK_SELECTOR,
        expectedHistoryVersion,
        expectedReason,
      });
      return {
        rows: result === null ? null : readRows(result.snapshot),
        status: result?.status ?? await projects.getProjectTrackHistoryStatus(
          resolved.projectId,
          EDITOR_TRACK_SELECTOR
        ),
      };
    } catch (error) {
      throw mapHistoryError(error);
    }
  };

  const saveSubtitles = async (cacheId, rows, { expectedProjectId = null } = {}) => {
    // Validate before creating an alias/project so malformed or empty legacy data cannot leave an
    // orphan durable project behind.
    legacyRowsToCanonicalTrack(rows, { label: SUBTITLE_CACHE_TRACK_LABEL });
    const resolved = await resolve(cacheId, { create: true });
    if (expectedProjectId !== null && resolved.projectId !== expectedProjectId) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The active subtitle project changed before it could be saved'
      );
    }
    const result = await projects.mutateProject(
      resolved.projectId,
      SAVE_REASON,
      (snapshot) => (rowsMatch(snapshot, rows) ? snapshot : writeRows(snapshot, rows)),
      { retryOnConflict: true }
    );
    return result.snapshot;
  };

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
    if (!Array.isArray(replacement) || replacement.length === 0) {
      throw new SubtitleProjectStoreError(
        'invalidSubtitles',
        'A regenerated subtitle segment must contain subtitles'
      );
    }
    legacyRowsToCanonicalTrack(replacement, { label: SUBTITLE_CACHE_TRACK_LABEL });
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

  const clearSubtitles = async (
    cacheId = null,
    { expectedProjectId = null } = {}
  ) => {
    const resolved = cacheId == null
      ? await restoreActiveProject()
      : await resolve(cacheId);
    if (expectedProjectId !== null && resolved?.projectId !== expectedProjectId) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The active subtitle project changed before it could be cleared'
      );
    }
    if (resolved === null || resolved.snapshot === null
        || readLegacySubtitleTrack(resolved.snapshot, {
          label: SUBTITLE_CACHE_TRACK_LABEL,
        }) === null) {
      return false;
    }
    await projects.mutateProject(
      resolved.projectId,
      CLEAR_REASON,
      (project) => removeLegacySubtitleTrack(project, {
        label: SUBTITLE_CACHE_TRACK_LABEL,
      }),
      { retryOnConflict: true }
    );
    return true;
  };

  const restoreActiveProject = () => enqueueIndex(async () => {
    await loadIndexDirect();
    const cacheId = index.activeCacheId;
    if (cacheId === null) return null;
    const entry = index.entries.find((candidate) => candidate.cacheId === cacheId);
    if (entry == null) return null;
    const snapshot = await projects.loadProject(entry.projectId);
    if (snapshot !== null) return { cacheId, projectId: entry.projectId, snapshot };

    index.entries = index.entries.filter((candidate) => candidate !== entry);
    index.activeCacheId = null;
    await persistIndexDirect();
    return null;
  });

  return Object.freeze({
    resolveProjectForCache: resolve,
    loadSubtitles,
    loadExactProjectSubtitles,
    saveSubtitles,
    captureSegmentRevision,
    commitSegmentRevision,
    commitEditorRevision,
    getHistoryStatus: historyStatus,
    undoEditorRevision: (cacheId, expectedHistoryVersion, expectedReason) => (
      navigateHistory(cacheId, 'undo', expectedHistoryVersion, expectedReason)
    ),
    redoEditorRevision: (cacheId, expectedHistoryVersion, expectedReason) => (
      navigateHistory(cacheId, 'redo', expectedHistoryVersion, expectedReason)
    ),
    clearSubtitles,
    restoreActiveProject,
  });
};

const subtitleProjectStore = createSubtitleProjectStore();

export const resolveProjectForCache = subtitleProjectStore.resolveProjectForCache;
export const loadProjectSubtitles = subtitleProjectStore.loadSubtitles;
export const loadExactProjectSubtitles = subtitleProjectStore.loadExactProjectSubtitles;
export const saveProjectSubtitles = subtitleProjectStore.saveSubtitles;
export const captureProjectSubtitleSegmentRevision = subtitleProjectStore.captureSegmentRevision;
export const commitProjectSubtitleSegmentRevision = subtitleProjectStore.commitSegmentRevision;
export const commitSubtitleEditorRevision = subtitleProjectStore.commitEditorRevision;
export const getSubtitleProjectHistoryStatus = subtitleProjectStore.getHistoryStatus;
export const undoSubtitleEditorRevision = subtitleProjectStore.undoEditorRevision;
export const redoSubtitleEditorRevision = subtitleProjectStore.redoEditorRevision;
export const clearProjectSubtitles = subtitleProjectStore.clearSubtitles;
export const restoreActiveSubtitleProject = subtitleProjectStore.restoreActiveProject;
