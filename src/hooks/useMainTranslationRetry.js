// Provider retry of failed or selected main-track translation rows against the durable revision.
import { useCallback } from 'react';
import { translateSubtitles } from '../services/geminiService';
import { CHECKPOINT_SOURCE } from '../events/constants';
import {
  assertTranslationPersistenceReceipt,
  captureTranslationRevision,
  commitTranslationRevision,
  getActiveTranslationCacheId,
  readTranslationForIdentity,
} from '../platform/translationPersistence';
import {
  assertTranslationTerminalMatchesSource,
  createTranslationAbortError,
} from '../utils/translationOwnership';
import {
  acknowledgePersistedDeliveries,
  buildTerminal,
  failuresAfterRetry,
  isAbort,
  languageOptionsFromChain,
  nextRunId,
  requireCompleteTranslationResult,
} from './translationRunHelpers';

/** `loadLifecycleOrchestrator` is passed in so the async boundary stays owned by the caller. */
export const useMainTranslationRetry = ({
  loadLifecycleOrchestrator,
  mountedRef,
  activeLeaseRef,
  sourcePayloadRef,
  captureRunContext,
  assertRunOwned,
  publishComplete,
  publishPartial,
  releaseLease,
  customTranslationPrompt,
  includeRules,
  setError,
  setTranslationStatus,
  t,
}) => useCallback(async (segment) => {
  if (activeLeaseRef.current?.kind === 'hydration') {
    activeLeaseRef.current.controller.abort(createTranslationAbortError('Translation retry started'));
    activeLeaseRef.current = null;
  } else if (activeLeaseRef.current !== null) {
    return { status: 'busy' };
  }
  const requestedIds = Array.isArray(segment?.originalIds)
    ? [...segment.originalIds]
    : (segment?.originalId === undefined ? [] : [segment.originalId]);
  if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
    return { status: 'invalid', error: new Error('A retry requires exact original subtitle IDs') };
  }
  const controller = new AbortController();
  const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'retry' });
  activeLeaseRef.current = lease;
  let context = null;
  try {
    context = await captureRunContext(lease);
    await assertRunOwned(context);
    const { checkpointBeforeUpdate } = await loadLifecycleOrchestrator();
    await assertRunOwned(context);
    await checkpointBeforeUpdate({
      source: CHECKPOINT_SOURCE.TRANSLATION_START,
      runId: context.runId,
      signal: context.signal,
    });
    await assertRunOwned(context);
    const revision = await captureTranslationRevision(context.identity);
    await assertRunOwned(context);
    const record = await readTranslationForIdentity(context.identity);
    await assertRunOwned(context);
    if ((record?.status !== 'complete' && record?.status !== 'partial')
        || record.sourceFingerprint !== context.sourceFingerprint
        || record.revision !== revision.revision) {
      throw new Error('The durable translation changed before retry');
    }
    const sourceById = new Map(context.sourceSubtitles.map((row) => [row.originalId, row]));
    const retrySource = requestedIds.map((id) => sourceById.get(id));
    if (retrySource.some((row) => row === undefined)) {
      throw new Error('The retry subtitle no longer belongs to this source');
    }
    const options = languageOptionsFromChain(record.languageChain);
    if (options.languages.length === 0) {
      throw new Error('Formatted-only translations do not require provider retry');
    }
    const ownership = {
      signal: context.signal,
      assertOwned: () => assertRunOwned(context),
      publishStatus: async (message) => {
        await assertRunOwned(context);
        setTranslationStatus(message);
        await assertRunOwned(context);
      },
      restTime: 0,
    };
    const translationResult = requireCompleteTranslationResult(await translateSubtitles(
      retrySource,
      options.languages.length === 1 ? options.languages[0] : options.languages,
      record.model,
      customTranslationPrompt,
      0,
      includeRules,
      options.delimiter,
      options.useParentheses,
      options.bracketStyle,
      record.languageChain,
      null,
      ownership
    ));
    await assertRunOwned(context);
    if (translationResult.rows.length !== requestedIds.length) {
      throw new Error('Retry result did not match the captured original IDs');
    }
    const replacement = new Map(translationResult.rows.map((row) => [row.originalId, row]));
    if (replacement.size !== requestedIds.length
        || requestedIds.some((id) => !replacement.has(id))) {
      throw new Error('Retry result lost its original subtitle identity');
    }
    const rows = [...record.baseSubtitles.filter((row) => !replacement.has(row.originalId)),
      ...translationResult.rows].sort((left, right) => left.sourceOrder - right.sourceOrder);
    const failures = failuresAfterRetry(record, translationResult.rows);
    const nextStatus = failures.length === 0 ? 'complete' : 'partial';
    const terminal = buildTerminal({
      sourceFingerprint: context.sourceFingerprint,
      sourceEntryCount: context.sourceSubtitles.length,
      languageChain: record.languageChain,
      model: record.model,
      status: nextStatus,
      rows,
      failures,
    });
    assertTranslationTerminalMatchesSource(terminal, context.sourceSubtitles);
    await assertRunOwned(context);
    const receipt = await commitTranslationRevision(context.identity, revision, terminal);
    await assertRunOwned(context);
    const acknowledged = assertTranslationPersistenceReceipt(receipt, context.identity, {
      revision: record.revision + 1,
      sourceFingerprint: context.sourceFingerprint,
      status: nextStatus,
    });
    await assertRunOwned(context);
    const deliveryAcknowledgement = await acknowledgePersistedDeliveries(
      translationResult.deliveries
    );
    await assertRunOwned(context);
    if (nextStatus === 'complete') {
      await publishComplete(context, acknowledged);
    } else {
      await publishPartial(context, acknowledged);
    }
    await assertRunOwned(context);
    setTranslationStatus(nextStatus === 'complete'
      ? t('translation.translationComplete', 'Translation complete')
      : t(
        'translation.partialResult',
        'Translation stopped with {{count}} failed chunks. Retry the translation to complete it.',
        { count: failures.length }
      ));
    await assertRunOwned(context);
    return {
      status: nextStatus,
      receipt,
      pendingDeliveryCount: deliveryAcknowledgement.pending,
    };
  } catch (retryError) {
    if (isAbort(retryError) || controller.signal.aborted) return { status: 'cancelled' };
    if (context) {
      try {
        await assertRunOwned(context);
      } catch {
        return { status: 'cancelled' };
      }
    }
    if (mountedRef.current && activeLeaseRef.current === lease
        && getActiveTranslationCacheId() === context?.cacheId
        && sourcePayloadRef.current === context?.sourcePayload) {
      setError(retryError?.message || t('translation.error', 'Translation retry failed'));
      try {
        await assertRunOwned(context);
      } catch {
        return { status: 'cancelled' };
      }
    }
    return { status: 'failed', error: retryError };
  } finally {
    releaseLease(lease);
  }
}, [
  activeLeaseRef,
  assertRunOwned,
  captureRunContext,
  customTranslationPrompt,
  includeRules,
  loadLifecycleOrchestrator,
  mountedRef,
  publishComplete,
  publishPartial,
  releaseLease,
  setError,
  setTranslationStatus,
  sourcePayloadRef,
  t,
]);
