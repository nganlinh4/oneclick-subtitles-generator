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
const EDITOR_TRACK_SELECTOR = Object.freeze({
  label: SUBTITLE_CACHE_TRACK_LABEL,
  origin: 'legacyJson',
});

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

const normalizeIndex = (value) => {
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

  const readRows = (snapshot) => (
    readLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL }) ?? []
  );

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

  const saveSubtitles = async (cacheId, rows) => {
    // Validate before creating an alias/project so malformed or empty legacy data cannot leave an
    // orphan durable project behind.
    legacyRowsToCanonicalTrack(rows, { label: SUBTITLE_CACHE_TRACK_LABEL });
    const resolved = await resolve(cacheId, { create: true });
    const result = await projects.mutateProject(
      resolved.projectId,
      SAVE_REASON,
      (snapshot) => (rowsMatch(snapshot, rows) ? snapshot : writeRows(snapshot, rows)),
      { retryOnConflict: true }
    );
    return result.snapshot;
  };

  const clearSubtitles = async (cacheId = null) => {
    const resolved = cacheId == null
      ? await restoreActiveProject()
      : await resolve(cacheId);
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
    saveSubtitles,
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
export const saveProjectSubtitles = subtitleProjectStore.saveSubtitles;
export const commitSubtitleEditorRevision = subtitleProjectStore.commitEditorRevision;
export const getSubtitleProjectHistoryStatus = subtitleProjectStore.getHistoryStatus;
export const undoSubtitleEditorRevision = subtitleProjectStore.undoEditorRevision;
export const redoSubtitleEditorRevision = subtitleProjectStore.redoEditorRevision;
export const clearProjectSubtitles = subtitleProjectStore.clearSubtitles;
export const restoreActiveSubtitleProject = subtitleProjectStore.restoreActiveProject;
