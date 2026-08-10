import { isDesktopRuntime } from './desktopRuntime';
import {
  commitSubtitleEditorRevision,
  getSubtitleProjectHistoryStatus,
  loadProjectSubtitles,
  redoSubtitleEditorRevision,
  undoSubtitleEditorRevision,
} from './subtitleProjectStore';
import { getCurrentCacheId } from '../utils/userSubtitlesStore';

export const LYRICS_EDITOR_REVISION_PREFIX = 'OSG lyrics editor v1:';
export const MAX_DURABLE_LYRICS_HISTORY_OPERATIONS = 16;
export const MAX_DURABLE_LYRICS_HISTORY_STATE_BYTES = 64 * 1024 * 1024;
export const MAX_DURABLE_LYRICS_HISTORY_QUEUE_BYTES = 128 * 1024 * 1024;

export class DurableLyricsHistoryBackpressureError extends Error {
  constructor(limit, byteLimit, code = 'historyQueueSaturated') {
    super('The durable subtitle-history queue reached its bounded capacity');
    this.name = 'DurableLyricsHistoryBackpressureError';
    this.code = code;
    this.limit = limit;
    this.byteLimit = byteLimit;
  }
}

export const LYRICS_EDITOR_ACTIONS = Object.freeze({
  TEXT: 'text',
  DELETE: 'delete',
  INSERT: 'insert',
  MERGE: 'merge',
  SPLIT: 'split',
  TIMING_DRAG: 'timing drag',
  CLEAR_RANGE: 'clear range',
  MOVE_RANGE: 'move range',
  RESET: 'reset',
  CHECKPOINT: 'checkpoint',
  APPLY_TIMINGS: 'apply timings',
  EXTERNAL_MERGE: 'external merge',
});

const ACTIONS = new Set(Object.values(LYRICS_EDITOR_ACTIONS));
const reasonFor = (action) => `${LYRICS_EDITOR_REVISION_PREFIX} ${action}`;
const EDITOR_REASONS = new Set([...ACTIONS].map(reasonFor));
const ACTIVE_FLUSHERS = new Set();

export const registerDurableLyricsHistoryFlusher = (flusher) => {
  if (typeof flusher !== 'function') throw new TypeError('A durable history flusher is required');
  ACTIVE_FLUSHERS.add(flusher);
  return () => ACTIVE_FLUSHERS.delete(flusher);
};

export const flushDurableLyricsHistory = async () => {
  await Promise.all([...ACTIVE_FLUSHERS].map((flusher) => flusher()));
};

export const isLyricsEditorRevisionReason = (value) => (
  typeof value === 'string' && EDITOR_REASONS.has(value)
);

const EMPTY_STATUS = Object.freeze({
  stateVersion: null,
  historyVersion: null,
  diverged: false,
  canUndo: false,
  canRedo: false,
  undoReason: null,
  redoReason: null,
});

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && value.charCodeAt(index + 1) >= 0xdc00
        && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
};

const serializeRows = (rows) => {
  if (!Array.isArray(rows)) throw new TypeError('Subtitle history rows must be an array');
  const serialized = JSON.stringify(rows);
  return { serialized, bytes: utf8ByteLength(serialized) };
};

const copyRows = (rows) => {
  const { serialized } = serializeRows(rows);
  return JSON.parse(serialized);
};

const editorStatus = (status) => {
  if (status == null) return EMPTY_STATUS;
  const undoReason = isLyricsEditorRevisionReason(status.undoReason) ? status.undoReason : null;
  const redoReason = isLyricsEditorRevisionReason(status.redoReason) ? status.redoReason : null;
  const historyVersion = Number.isSafeInteger(status.historyVersion)
    && status.historyVersion >= 0
    ? status.historyVersion
    : null;
  const diverged = status.diverged === true;
  return Object.freeze({
    stateVersion: Number.isSafeInteger(status.stateVersion) ? status.stateVersion : null,
    historyVersion,
    diverged,
    canUndo: !diverged && historyVersion !== null && status.canUndo === true && undoReason !== null,
    canRedo: !diverged && historyVersion !== null && status.canRedo === true && redoReason !== null,
    undoReason: diverged ? null : undoReason,
    redoReason: diverged ? null : redoReason,
  });
};

/**
 * Serialize durable lyric revisions independently from React's immediate, optimistic state.
 * Browser preview never calls the native project store. Old-project completions are allowed to
 * finish, but their callbacks cannot overwrite the currently bound editor.
 */
export const createDurableLyricsHistory = ({
  runtimeAvailable = isDesktopRuntime,
  currentCacheId = getCurrentCacheId,
  revisions = {
    commit: commitSubtitleEditorRevision,
    load: loadProjectSubtitles,
    status: getSubtitleProjectHistoryStatus,
    undo: undoSubtitleEditorRevision,
    redo: redoSubtitleEditorRevision,
  },
  maxPendingOperations = MAX_DURABLE_LYRICS_HISTORY_OPERATIONS,
  maxPendingBytes = MAX_DURABLE_LYRICS_HISTORY_QUEUE_BYTES,
  maxStateBytes = MAX_DURABLE_LYRICS_HISTORY_STATE_BYTES,
  onStatus = () => undefined,
  onReconcile = () => undefined,
  onError = (error) => console.error('[durableLyricsHistory] Native history failed:', error),
} = {}) => {
  if (!Number.isSafeInteger(maxPendingOperations)
      || maxPendingOperations < 1
      || maxPendingOperations > MAX_DURABLE_LYRICS_HISTORY_OPERATIONS) {
    throw new TypeError('The durable subtitle-history queue limit is invalid');
  }
  if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1
      || maxPendingBytes > MAX_DURABLE_LYRICS_HISTORY_QUEUE_BYTES
      || !Number.isSafeInteger(maxStateBytes) || maxStateBytes < 1
      || maxStateBytes > MAX_DURABLE_LYRICS_HISTORY_STATE_BYTES) {
    throw new TypeError('The durable subtitle-history byte limit is invalid');
  }
  let operationTail = Promise.resolve();
  let pendingOperations = 0;
  let pendingBytes = 0;
  let boundCacheId = null;
  let bindingGeneration = 0;
  let latestSequence = 0;
  let disposed = false;
  let lastStatus = EMPTY_STATUS;
  let failureEpoch = 0;
  let acknowledgedFailureEpoch = 0;
  let latestFailure = null;
  const recoveringGenerations = new Set();
  const reconciliationRequiredGenerations = new Set();

  const publishStatus = (status, generation) => {
    const filtered = editorStatus(status);
    if (!disposed && generation === bindingGeneration) {
      lastStatus = filtered;
      try {
        onStatus(filtered);
      } catch (error) {
        console.error('[durableLyricsHistory] Status callback failed:', error);
      }
    }
    return filtered;
  };

  const bind = () => {
    let nextCacheId = null;
    try {
      if (runtimeAvailable()) nextCacheId = currentCacheId();
    } catch {
      nextCacheId = null;
    }
    if (typeof nextCacheId !== 'string' || nextCacheId.length === 0) nextCacheId = null;
    if (nextCacheId !== boundCacheId) {
      boundCacheId = nextCacheId;
      bindingGeneration += 1;
      reconciliationRequiredGenerations.clear();
      failureEpoch = 0;
      acknowledgedFailureEpoch = 0;
      latestFailure = null;
      publishStatus(EMPTY_STATUS, bindingGeneration);
    }
    return nextCacheId === null
      ? null
      : { cacheId: nextCacheId, generation: bindingGeneration };
  };

  const reserve = (generation, retainedBytes = 0) => {
    if (pendingOperations >= maxPendingOperations
        || retainedBytes > maxPendingBytes - pendingBytes
        || recoveringGenerations.has(generation)) return null;
    pendingOperations += 1;
    pendingBytes += retainedBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      pendingOperations -= 1;
      pendingBytes -= retainedBytes;
    };
  };

  const enqueueReserved = (operation, release) => {
    const result = operationTail.then(operation, operation);
    result.then(release, release);
    operationTail = result.catch(() => undefined);
    return result;
  };

  const enqueue = (operation, generation, retainedBytes = 0) => {
    const release = reserve(generation, retainedBytes);
    return release === null ? null : enqueueReserved(operation, release);
  };

  const handleFailure = (error, binding, sequence) => {
    if (!disposed && binding.generation === bindingGeneration) {
      failureEpoch += 1;
      latestFailure = error;
      publishStatus(EMPTY_STATUS, binding.generation);
      try {
        onError(error);
      } catch (callbackError) {
        console.error('[durableLyricsHistory] Error callback failed:', callbackError);
      }
      if (sequence === latestSequence && Array.isArray(error?.authoritativeRows)) {
        try {
          onReconcile(copyRows(error.authoritativeRows));
        } catch (callbackError) {
          console.error('[durableLyricsHistory] Reconciliation callback failed:', callbackError);
        }
      }
    }
    return { ok: false, error };
  };

  const scheduleAuthoritativeReconciliation = (binding) => {
    if (disposed || binding.generation !== bindingGeneration) return;
    if (recoveringGenerations.has(binding.generation)) return;
    reconciliationRequiredGenerations.add(binding.generation);
    recoveringGenerations.add(binding.generation);
    const recovery = operationTail.then(async () => {
      if (disposed || binding.generation !== bindingGeneration) return;
      const canLoad = typeof revisions.load === 'function';
      const authoritativeRows = canLoad
        ? await revisions.load(binding.cacheId)
        : null;
      const status = await revisions.status(binding.cacheId);
      if (disposed || binding.generation !== bindingGeneration) return;
      const rows = Array.isArray(status?.authoritativeRows)
        ? status.authoritativeRows
        : Array.isArray(authoritativeRows)
          ? authoritativeRows
          : canLoad && authoritativeRows === null ? [] : null;
      if (!Array.isArray(rows)) {
        const error = new Error('Authoritative subtitle-history rows are unavailable');
        error.code = 'historyReconciliationUnavailable';
        throw error;
      }
      onReconcile(copyRows(rows));
      publishStatus(status, binding.generation);
      reconciliationRequiredGenerations.delete(binding.generation);
    }).catch((error) => {
      handleFailure(error, binding, latestSequence);
    }).finally(() => {
      recoveringGenerations.delete(binding.generation);
    });
    operationTail = recovery.catch(() => undefined);
  };

  const rejectForBackpressure = (
    binding,
    sequence,
    code = 'historyQueueSaturated'
  ) => {
    const error = new DurableLyricsHistoryBackpressureError(
      maxPendingOperations,
      maxPendingBytes,
      code
    );
    const result = handleFailure(error, binding, sequence);
    scheduleAuthoritativeReconciliation(binding);
    return { ...result, backpressure: true };
  };

  const refresh = () => {
    const binding = bind();
    if (binding === null) return Promise.resolve(EMPTY_STATUS);
    const sequence = latestSequence;
    const queued = enqueue(async () => {
      const status = await revisions.status(binding.cacheId);
      const published = publishStatus(status, binding.generation);
      if (published.diverged && sequence === latestSequence
          && !disposed && binding.generation === bindingGeneration
          && Array.isArray(status?.authoritativeRows)) {
        onReconcile(copyRows(status.authoritativeRows));
      }
      return published;
    }, binding.generation);
    if (queued === null) {
      rejectForBackpressure(binding, sequence);
      return Promise.resolve(EMPTY_STATUS);
    }
    return queued.catch((error) => {
      handleFailure(error, binding, latestSequence);
      return publishStatus(EMPTY_STATUS, binding.generation);
    });
  };

  const record = (beforeRows, afterRows, action) => {
    if (!ACTIONS.has(action)) throw new TypeError('Unsupported subtitle editor revision action');
    if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) {
      throw new TypeError('Subtitle history rows must be an array');
    }
    const binding = bind();
    if (binding === null) return Promise.resolve({ ok: true, native: false });
    if (pendingOperations >= maxPendingOperations
        || pendingBytes >= maxPendingBytes
        || recoveringGenerations.has(binding.generation)) {
      latestSequence += 1;
      return Promise.resolve(rejectForBackpressure(binding, latestSequence));
    }
    const beforeEncoded = serializeRows(beforeRows);
    const afterEncoded = serializeRows(afterRows);
    if (beforeEncoded.serialized === afterEncoded.serialized) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    latestSequence += 1;
    const sequence = latestSequence;
    if (beforeEncoded.bytes > maxStateBytes || afterEncoded.bytes > maxStateBytes) {
      return Promise.resolve(rejectForBackpressure(
        binding,
        sequence,
        'historySnapshotTooLarge'
      ));
    }
    const release = reserve(
      binding.generation,
      beforeEncoded.bytes + afterEncoded.bytes
    );
    if (release === null) {
      return Promise.resolve(rejectForBackpressure(binding, sequence));
    }
    let before;
    let after;
    try {
      before = JSON.parse(beforeEncoded.serialized);
      after = JSON.parse(afterEncoded.serialized);
    } catch (error) {
      release();
      throw error;
    }
    const queued = enqueueReserved(async () => {
      const result = await revisions.commit(
        binding.cacheId,
        before,
        after,
        reasonFor(action)
      );
      publishStatus(result?.status, binding.generation);
      return { ok: true, result };
    }, release);
    publishStatus({
      ...lastStatus,
      canUndo: true,
      canRedo: false,
      undoReason: reasonFor(action),
      redoReason: null,
    }, binding.generation);
    return queued.catch((error) => {
      const failure = handleFailure(error, binding, sequence);
      if (sequence === latestSequence) scheduleAuthoritativeReconciliation(binding);
      return failure;
    });
  };

  const navigate = (direction) => {
    if (direction !== 'undo' && direction !== 'redo') {
      throw new TypeError('Unsupported subtitle history direction');
    }
    const binding = bind();
    if (binding === null) {
      return Promise.resolve({ ok: true, native: false, navigated: false, rows: null });
    }
    latestSequence += 1;
    const sequence = latestSequence;

    const queued = enqueue(async () => {
      const before = await revisions.status(binding.cacheId);
      const filtered = publishStatus(before, binding.generation);
      if (filtered.diverged && sequence === latestSequence
          && !disposed && binding.generation === bindingGeneration
          && Array.isArray(before?.authoritativeRows)) {
        onReconcile(copyRows(before.authoritativeRows));
      }
      const reason = direction === 'undo' ? filtered.undoReason : filtered.redoReason;
      if (reason === null) {
        return { ok: true, navigated: false, rows: null, status: filtered };
      }

      const result = await revisions[direction](
        binding.cacheId,
        filtered.historyVersion,
        reason
      );
      const status = publishStatus(result?.status, binding.generation);
      if (result?.rows == null) {
        return { ok: true, navigated: false, rows: null, status };
      }
      return {
        ok: true,
        navigated: true,
        rows: copyRows(result.rows),
        status,
      };
    }, binding.generation);
    if (queued === null) {
      return Promise.resolve(rejectForBackpressure(binding, sequence));
    }
    return queued.catch((error) => {
      const failure = handleFailure(error, binding, sequence);
      if (sequence === latestSequence) scheduleAuthoritativeReconciliation(binding);
      return failure;
    });
  };

  const flush = async () => {
    const startingAcknowledgedEpoch = acknowledgedFailureEpoch;
    if (reconciliationRequiredGenerations.has(bindingGeneration)
        && !recoveringGenerations.has(bindingGeneration)
        && boundCacheId !== null) {
      scheduleAuthoritativeReconciliation({
        cacheId: boundCacheId,
        generation: bindingGeneration,
      });
    }
    let observed;
    do {
      observed = operationTail;
      await observed;
    } while (observed !== operationTail);
    if (reconciliationRequiredGenerations.has(bindingGeneration)) {
      throw latestFailure ?? new Error('Durable subtitle history requires reconciliation');
    }
    if (failureEpoch > startingAcknowledgedEpoch) {
      acknowledgedFailureEpoch = Math.max(acknowledgedFailureEpoch, failureEpoch);
      throw latestFailure;
    }
  };

  return Object.freeze({
    refresh,
    record,
    undo: () => navigate('undo'),
    redo: () => navigate('redo'),
    flush,
    dispose: () => { disposed = true; },
  });
};
