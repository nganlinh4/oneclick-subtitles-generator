// Hydrates the durable translation of the exact active project/source into presentation state.
import { useEffect } from 'react';
import {
  assertActiveTranslationIdentity,
  getActiveTranslationCacheId,
  readTranslationForIdentity,
  resolveTranslationIdentity,
} from '../platform/translationPersistence';
import {
  assertTranslationTerminalMatchesSource,
  createTranslationAbortError,
  fingerprintTranslationSourcePayload,
  snapshotTranslationSource,
} from '../utils/translationOwnership';
import { isAbort, nextRunId } from './translationRunHelpers';

/** Hydrate only the exact active project/source. Starting another hydration aborts the old one. */
export const useTranslationHydration = ({
  renderedCacheId,
  renderedSourcePayload,
  scopeEpoch,
  mountedRef,
  activeLeaseRef,
  hydrationControllerRef,
  pendingHydrationRef,
  sourcePayloadRef,
  sourceRowsRef,
  assertRunOwned,
  publishComplete,
  publishPartial,
  releaseLease,
  setTranslationStatus,
  t,
}) => {
  useEffect(() => {
    pendingHydrationRef.current = false;
    if (!renderedCacheId || !renderedSourcePayload
        || renderedSourcePayload === '!invalid-translation-source') return undefined;
    if (activeLeaseRef.current !== null) {
      pendingHydrationRef.current = true;
      return undefined;
    }
    const controller = new AbortController();
    const lease = Object.freeze({
      runId: nextRunId(),
      controller,
      kind: 'hydration',
    });
    activeLeaseRef.current = lease;
    hydrationControllerRef.current?.abort(createTranslationAbortError('New translation hydration'));
    hydrationControllerRef.current = controller;
    const hydrationScope = { cacheId: renderedCacheId, sourcePayload: renderedSourcePayload };
    const assertHydration = async (identity = null) => {
      if (!mountedRef.current || activeLeaseRef.current !== lease || controller.signal.aborted
          || getActiveTranslationCacheId() !== hydrationScope.cacheId
          || sourcePayloadRef.current !== hydrationScope.sourcePayload) {
        throw createTranslationAbortError('Translation hydration ownership changed');
      }
      if (identity) await assertActiveTranslationIdentity(identity);
      if (!mountedRef.current || activeLeaseRef.current !== lease || controller.signal.aborted
          || getActiveTranslationCacheId() !== hydrationScope.cacheId
          || sourcePayloadRef.current !== hydrationScope.sourcePayload) {
        throw createTranslationAbortError('Translation hydration ownership changed');
      }
    };

    void (async () => {
      try {
        await assertHydration();
        const identity = await resolveTranslationIdentity(hydrationScope.cacheId, { create: false });
        await assertHydration(identity);
        const fingerprint = await fingerprintTranslationSourcePayload(hydrationScope.sourcePayload);
        await assertHydration(identity);
        const record = await readTranslationForIdentity(identity);
        await assertHydration(identity);
        const hydrationSource = snapshotTranslationSource(sourceRowsRef.current);
        if (record === null || record.sourceFingerprint !== fingerprint
            || record.sourceEntryCount !== hydrationSource.length) return;
        try {
          assertTranslationTerminalMatchesSource(record, hydrationSource);
        } catch {
          return;
        }
        const context = Object.freeze({
          runId: lease.runId,
          cacheId: identity.cacheId,
          projectId: identity.projectId,
          sourceFingerprint: fingerprint,
          sourceSubtitles: hydrationSource,
          signal: controller.signal,
          identity,
          sourcePayload: hydrationScope.sourcePayload,
          scope: 'project',
          batchSourcePayload: null,
          lease,
        });
        if (record.status === 'partial') {
          await publishPartial(context, { record }, { loaded: true });
          await assertRunOwned(context);
          setTranslationStatus(t(
            'translation.partialResult',
            'Translation stopped with {{count}} failed chunks. Retry the translation to complete it.',
            { count: record.failedChunks.length }
          ));
          await assertRunOwned(context);
          return;
        }
        const acknowledged = { record };
        await publishComplete(context, acknowledged, { loaded: true });
        await assertRunOwned(context);
        setTranslationStatus(t('translation.loadedFromCache', 'Translations loaded from cache'));
        await assertRunOwned(context);
      } catch (hydrationError) {
        if (!isAbort(hydrationError)) {
          console.error('Error hydrating the active project translation:', hydrationError);
        }
      } finally {
        releaseLease(lease);
      }
    })();
    return () => {
      controller.abort(createTranslationAbortError('Translation hydration changed'));
      if (activeLeaseRef.current === lease) activeLeaseRef.current = null;
    };
  }, [
    activeLeaseRef,
    assertRunOwned,
    hydrationControllerRef,
    mountedRef,
    pendingHydrationRef,
    publishComplete,
    publishPartial,
    releaseLease,
    renderedCacheId,
    renderedSourcePayload,
    scopeEpoch,
    setTranslationStatus,
    sourcePayloadRef,
    sourceRowsRef,
    t,
  ]);
};
