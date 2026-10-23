// One translate run behind useTranslationState.handleTranslate: lease, checkpoint, optional bulk
// files, the main project track, and the complete/partial/failed terminal for that run.
import { translateSubtitles } from '../services/geminiService';
import { PartialTranslationError } from '../services/gemini/translationChunkProcessor';
import { CHECKPOINT_SOURCE } from '../events/constants';
import {
  canonicalTranslationSourcePayload,
  createTranslationAbortError,
  normalizeRunnableLanguageChain,
} from '../utils/translationOwnership';
import {
  buildTerminal,
  isAbort,
  nextRunId,
  persistOwnedTranslationTerminal,
  requireCompleteTranslationResult,
  snapshotBulkTranslationSource,
} from './translationRunHelpers';
import { writePreference } from '../platform/preferences/store';

// A hydration read yields to a new translation; any other active lease means the run is busy.
const acquireTranslationLease = (activeLeaseRef) => {
  if (activeLeaseRef.current?.kind === 'hydration') {
    activeLeaseRef.current.controller.abort(createTranslationAbortError('Translation started'));
    activeLeaseRef.current = null;
  } else if (activeLeaseRef.current !== null) {
    return null;
  }
  const controller = new AbortController();
  const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'translation' });
  activeLeaseRef.current = lease;
  return lease;
};

// Checkpoints manual edits, then resets the visible run state one owned step at a time.
const startOwnedRun = async (deps, context, hasMainSubtitles) => {
  const { assertRunOwned } = deps;
  await assertRunOwned(context);
  const { checkpointBeforeUpdate } = await deps.loadLifecycleOrchestrator();
  await assertRunOwned(context);
  await checkpointBeforeUpdate({
    source: CHECKPOINT_SOURCE.TRANSLATION_START,
    runId: context.runId,
    signal: context.signal,
  });
  await assertRunOwned(context);

  deps.setError('');
  await assertRunOwned(context);
  deps.setTranslationStatus('');
  await assertRunOwned(context);
  deps.setIsTranslating(hasMainSubtitles);
  await assertRunOwned(context);
  deps.setLoadedFromCache(false);
  await assertRunOwned(context);
};

const translateMainTrack = async (deps, run) => {
  const { assertRunOwned, settings, t } = deps;
  const { context, lease, ownership, normalizedChain, request } = run;
  const { languages, delimiter, useParentheses, bracketStyle } = request;
  const streamedRows = new Map();
  const mainOwnership = {
    ...ownership,
    publishRows: (rows) => {
      if (context.signal.aborted
          || deps.activeLeaseRef.current !== lease
          || !deps.mountedRef.current) {
        return;
      }
      rows.forEach((row) => streamedRows.set(row.originalId, row));
      deps.setTranslatedSubtitles(context.sourceSubtitles
        .map((row) => streamedRows.get(row.originalId))
        .filter(Boolean));
    },
  };
  const translationResult = requireCompleteTranslationResult(await translateSubtitles(
    context.sourceSubtitles,
    languages.length === 1 ? languages[0] : languages,
    settings.selectedModel,
    settings.customTranslationPrompt,
    settings.splitDuration,
    settings.includeRules,
    languages.length === 2 && useParentheses
      ? delimiter
      : (useParentheses ? null : delimiter),
    useParentheses,
    bracketStyle,
    normalizedChain,
    null,
    mainOwnership
  ));
  await assertRunOwned(context);
  if (translationResult.rows.length === 0) {
    throw new Error(t('translation.emptyResult', 'Translation returned no results'));
  }
  const terminal = buildTerminal({
    sourceFingerprint: context.sourceFingerprint,
    sourceEntryCount: context.sourceSubtitles.length,
    languageChain: normalizedChain,
    model: settings.selectedModel,
    status: 'complete',
    rows: translationResult.rows,
  });
  await assertRunOwned(context);
  const {
    receipt,
    acknowledged,
    deliveryAcknowledgement,
  } = await persistOwnedTranslationTerminal({
    context,
    terminal,
    deliveries: translationResult.deliveries,
    assertRunOwned,
  });
  await deps.publishComplete(context, acknowledged);
  await assertRunOwned(context);
  deps.setTranslationStatus(t('translation.translationComplete', 'Translation complete'));
  await assertRunOwned(context);
  writePreference('translation_split_duration', settings.splitDuration);
  await assertRunOwned(context);
  return {
    status: 'complete',
    receipt,
    pendingDeliveryCount: deliveryAcknowledgement.pending,
  };
};

// Persists the completed chunks of a partially failed run as its terminal.
const persistPartialTranslation = async (deps, context, normalizedChain, translationError) => {
  const { assertRunOwned, t } = deps;
  await assertRunOwned(context);
  const partialResult = translationError.result ?? Object.freeze({
    status: 'partial',
    rows: translationError.completedSubtitles,
    deliveries: Object.freeze([]),
  });
  const terminal = buildTerminal({
    sourceFingerprint: context.sourceFingerprint,
    sourceEntryCount: context.sourceSubtitles.length,
    languageChain: normalizedChain,
    model: deps.settings.selectedModel,
    status: 'partial',
    rows: partialResult.rows,
    failures: translationError.failedChunks,
  });
  const {
    receipt,
    acknowledged,
    deliveryAcknowledgement,
  } = await persistOwnedTranslationTerminal({
    context,
    terminal,
    deliveries: partialResult.deliveries,
    assertRunOwned,
  });
  await deps.publishPartial(context, acknowledged);
  await assertRunOwned(context);
  deps.setTranslationStatus(t(
    'translation.partialResult',
    'Translation stopped with {{count}} failed chunks. Retry the translation to complete it.',
    { count: acknowledged.record.failedChunks.length }
  ));
  await assertRunOwned(context);
  return {
    status: 'partial',
    receipt,
    pendingDeliveryCount: deliveryAcknowledgement.pending,
  };
};

const settleFailure = async (deps, run, translationError) => {
  const { assertRunOwned, t } = deps;
  const { context, lease, normalizedChain } = run;
  let terminalError = translationError;
  if (translationError instanceof PartialTranslationError && context && normalizedChain) {
    try {
      return await persistPartialTranslation(deps, context, normalizedChain, translationError);
    } catch (partialPersistenceError) {
      terminalError = partialPersistenceError;
    }
  }
  if (isAbort(terminalError) || lease.controller.signal.aborted) {
    return { status: 'cancelled' };
  }
  if (context) {
    try {
      await assertRunOwned(context);
    } catch {
      return { status: 'cancelled' };
    }
  }
  if (deps.mountedRef.current && deps.activeLeaseRef.current === lease) {
    deps.setError(terminalError?.message || t(
      'translation.error',
      'Error translating subtitles. Please try again.'
    ));
    if (context) {
      try {
        await assertRunOwned(context);
      } catch {
        return { status: 'cancelled' };
      }
    }
  }
  return { status: 'failed', error: terminalError };
};

const translateOwnedRun = async (deps, run) => {
  const { assertRunOwned, t } = deps;
  const { languages, delimiter, useParentheses, bracketStyle, chainItems } = run.request;
  if (!Array.isArray(languages)) throw new TypeError('Translation languages must be an array');
  if (languages.length === 0 && !chainItems) {
    deps.setError(t('translation.languageRequired', 'Please enter at least one target language'));
    return { status: 'invalid' };
  }
  const { subtitles, bulkFiles } = deps;
  const hasMainSubtitles = Array.isArray(subtitles) && subtitles.length > 0;
  const hasBulkFiles = bulkFiles.length > 0;
  if (!hasMainSubtitles && !hasBulkFiles) {
    deps.setError(t('translation.noSubtitles', 'No subtitles to translate'));
    return { status: 'invalid' };
  }
  run.normalizedChain = normalizeRunnableLanguageChain(chainItems, {
    formatOnly: languages.length === 0,
  });
  const batchSource = hasBulkFiles ? snapshotBulkTranslationSource(bulkFiles) : null;
  const batchSourcePayload = hasBulkFiles
    ? canonicalTranslationSourcePayload(batchSource)
    : null;
  const runSource = hasMainSubtitles ? deps.sourceRowsRef.current : batchSource;
  run.context = await deps.captureRunContext(run.lease, runSource, {
    scope: hasMainSubtitles ? 'project' : 'batch',
    batchSourcePayload: hasMainSubtitles ? batchSourcePayload : null,
  });
  const { context } = run;
  await startOwnedRun(deps, context, hasMainSubtitles);

  run.ownership = {
    signal: context.signal,
    assertOwned: () => assertRunOwned(context),
    publishStatus: async (message) => {
      await assertRunOwned(context);
      deps.setTranslationStatus(message);
      await assertRunOwned(context);
    },
    restTime: deps.settings.restTime,
  };
  if (hasBulkFiles) {
    const bulkOutcome = await deps.handleBulkTranslate(
      languages,
      delimiter,
      useParentheses,
      bracketStyle,
      run.normalizedChain,
      hasMainSubtitles,
      run.ownership
    );
    await assertRunOwned(context);
    if (bulkOutcome?.status === 'failed' && !hasMainSubtitles) return bulkOutcome;
  }
  if (!hasMainSubtitles) return { status: 'complete', scope: 'bulk' };
  return translateMainTrack(deps, run);
};

/**
 * @param {object} deps hook-owned refs, setters, run-ownership helpers and the current
 *   `subtitles`, `bulkFiles` and translation `settings`
 * @param {{ languages: string[], delimiter: string, useParentheses: boolean,
 *   bracketStyle: string|null, chainItems: Array|null }} request
 * @returns {Promise<{ status: string }>} busy, invalid, complete, partial, cancelled or failed
 */
export const runTranslation = async (deps, request) => {
  const lease = acquireTranslationLease(deps.activeLeaseRef);
  if (lease === null) return { status: 'busy' };
  const run = { lease, request, context: null, normalizedChain: null, ownership: null };
  try {
    return await translateOwnedRun(deps, run);
  } catch (translationError) {
    return await settleFailure(deps, run, translationError);
  } finally {
    if (deps.releaseLease(lease)) {
      if (deps.mountedRef.current) {
        deps.setIsTranslating(false);
        deps.setIsBulkTranslating(false);
        deps.setCurrentBulkFileIndex(-1);
      }
    }
  }
};
