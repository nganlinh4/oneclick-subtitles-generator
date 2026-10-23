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
} from './projectSnapshotAdapter';
import { clearActiveTranscript, loadProjectTranscript } from './transcriptStore';
import {
  SUBTITLE_CACHE_TRACK_LABEL,
  SubtitleProjectStoreError,
  normalizeIndex,
  projectNameForCache,
  validateCacheId,
} from './subtitleProjectAliasIndex';
import { createSubtitleSegmentRevisions } from './subtitleSegmentRevision';
import {
  EDITOR_TRACK_SELECTOR,
  bindEditorRowIdentities,
  cachedTrack,
  conflict,
  mapHistoryError,
  readRows,
  rowsMatch,
  writeRows,
} from './subtitleTrackRows';

export {
  MAX_SUBTITLE_PROJECT_ALIASES,
  SUBTITLE_CACHE_TRACK_LABEL,
} from './subtitleProjectAliasIndex';

const SAVE_REASON = 'Save cached subtitles';
const CLEAR_REASON = 'Clear cached subtitles for retry';

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
      index = normalizeIndex(await invokeCommand('subtitle_project_index_get', {}));
    }
    return index;
  };

  const markActiveDirect = async (entry) => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new SubtitleProjectStoreError('invalidClock', 'The project clock is invalid');
    }
    const persisted = normalizeIndex(await invokeCommand('subtitle_project_alias_activate', {
      entry: {
        cacheId: entry.cacheId,
        projectId: entry.projectId,
        lastOpenedAt: timestamp,
      },
    }));
    const exact = persisted.entries.find(candidate => candidate.cacheId === entry.cacheId);
    if (persisted.activeCacheId !== entry.cacheId || exact?.projectId !== entry.projectId) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The subtitle project alias changed while it was being activated'
      );
    }
    index = persisted;
    Object.assign(entry, exact);
  };

  const removeAliasDirect = async (entry) => {
    const mutation = await invokeCommand('subtitle_project_alias_remove', {
      cacheId: entry.cacheId,
      expectedProjectId: entry.projectId,
    });
    if (typeof mutation?.changed !== 'boolean') {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The subtitle project alias could not be repaired'
      );
    }
    index = normalizeIndex(mutation.index);
  };

  const resolve = (cacheId, { create = false } = {}) => {
    const alias = validateCacheId(cacheId);
    return enqueueIndex(async () => {
      await loadIndexDirect();
      let entry = index.entries.find((candidate) => candidate.cacheId === alias) ?? null;
      let snapshot = entry == null ? null : await projects.loadProject(entry.projectId);

      if (entry !== null && snapshot === null) {
        await removeAliasDirect(entry);
        entry = null;
      }

      if (entry === null && create) {
        // The durable cache identity is also the native create idempotency key. If the WebView
        // loses an IPC response, this exact alias survives reload/restart and every retry resolves
        // the same transaction receipt instead of allocating another project.
        snapshot = await projects.createProject(projectNameForCache(alias), alias);
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

  /**
   * Rebuild the browser alias for an exact native workspace after preference reset.
   *
   * The native pointer has already been validated against project_state and its active media. This
   * method never creates or chooses a project and never compares file content: it loads only the
   * supplied UUID, replaces conflicting derivative aliases, and persists that exact mapping.
   */
  const adoptExactProjectAlias = (cacheId, projectId) => {
    const alias = validateCacheId(cacheId);
    if (!isUuidV7(projectId)) {
      throw new SubtitleProjectStoreError(
        'projectScopeMismatch',
        'The durable workspace project identity is invalid'
      );
    }
    return enqueueIndex(async () => {
      await loadIndexDirect();
      const snapshot = await projects.loadProject(projectId);
      if (snapshot?.metadata?.id !== projectId) {
        throw new SubtitleProjectStoreError(
          'projectScopeMismatch',
          'The durable workspace project is no longer available'
        );
      }
      index.entries = index.entries.filter((entry) => (
        entry.cacheId !== alias && entry.projectId !== projectId
      ));
      const entry = { cacheId: alias, projectId, lastOpenedAt: now() };
      index.entries.unshift(entry);
      await markActiveDirect(entry);
      return { cacheId: alias, projectId, snapshot };
    });
  };

  const loadSubtitles = async (cacheId) => {
    const resolved = await resolve(cacheId);
    if (resolved === null || resolved.snapshot === null) return null;
    if (resolved.projectId) {
      try {
        await loadProjectTranscript(resolved.projectId);
      } catch {
        // Hydration failure should not block subtitle loading
      }
    }
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
      try {
        await loadProjectTranscript(expectedProjectId);
      } catch {
        // Hydration failure should not block subtitle loading
      }
      return readLegacySubtitleTrack(snapshot, { label: SUBTITLE_CACHE_TRACK_LABEL });
    });
  };

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

    let baselineSnapshot = current;
    if (!rowsMatch(current, beforeRows)) {
      const hasTrack = readLegacySubtitleTrack(current, {
        label: SUBTITLE_CACHE_TRACK_LABEL,
      }) !== null;
      const canBootstrapUnsaved = !hasTrack
        && beforeRows.length > 0
        && history.historyVersion === 0;
      if (!canBootstrapUnsaved) throw conflict(current);
      // A pre-native editor could already hold unsaved rows when its project alias was created.
      // Preserve that one explicit bootstrap baseline so the first native edit remains undoable.
      baselineSnapshot = writeRows(current, beforeRows);
    }

    // `rowsMatch` deliberately compares the legacy editor's semantic rows rather than native
    // UUIDs. Rebuilding the before-track from an idless optimistic row would therefore mint a new
    // cue UUID and make Rust's exact compare-and-swap reject an otherwise valid rapid edit. Once
    // the semantic baseline has matched, the project snapshot is the only authoritative identity
    // source: pass its exact track as `beforeTrack` and derive only the replacement from it.
    const beforeTrack = cachedTrack(baselineSnapshot);
    const boundAfterRows = bindEditorRowIdentities(beforeTrack, beforeRows, afterRows);
    const afterSnapshot = writeRows(baselineSnapshot, boundAfterRows);
    let result;
    try {
      result = await projects.commitProjectTrack({
        id: resolved.projectId,
        selector: EDITOR_TRACK_SELECTOR,
        expectedHistoryVersion: history.historyVersion,
        beforeTrack,
        afterTrack: cachedTrack(afterSnapshot),
        reason,
      });
    } catch (error) {
      throw mapHistoryError(error);
    }
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

  const { captureSegmentRevision, commitSegmentRevision } = createSubtitleSegmentRevisions({
    resolve,
    projects,
  });

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
    clearActiveTranscript();
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

    await removeAliasDirect(entry);
    return null;
  });

  return Object.freeze({
    resolveProjectForCache: resolve,
    adoptExactProjectAlias,
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
export const adoptExactSubtitleProjectAlias = subtitleProjectStore.adoptExactProjectAlias;
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
