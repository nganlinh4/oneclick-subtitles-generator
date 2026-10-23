// Run-ownership guards for translation: lease/source/project checks, run capture and publication.
import { useCallback } from 'react';
import {
  assertActiveTranslationIdentity,
  getActiveTranslationCacheId,
  resolveTranslationIdentity,
} from '../platform/translationPersistence';
import {
  canonicalTranslationSourcePayload,
  createTranslationAbortError,
  fingerprintTranslationSourcePayload,
  snapshotTranslationSource,
} from '../utils/translationOwnership';
import {
  callCompletion,
  partialRowsForPresentation,
  snapshotBulkTranslationSource,
} from './translationRunHelpers';

/**
 * Every async publisher is guarded by the captured project, source payload, SHA-256 fingerprint,
 * run lease, and translation-only AbortSignal.
 */
export const useTranslationRunOwnership = ({
  mountedRef,
  activeLeaseRef,
  sourcePayloadRef,
  sourceRowsRef,
  bulkFilesRef,
  completionRef,
  clearPublishedState,
  setBulkTranslations,
  setTranslatedSubtitles,
  setLoadedFromCache,
}) => {
  const assertLeaseSync = useCallback((
    lease,
    cacheId,
    sourcePayload,
    scope = 'project'
  ) => {
    let liveSourcePayload = '!invalid-translation-source';
    try {
      if (scope === 'batch') {
        liveSourcePayload = canonicalTranslationSourcePayload(
          snapshotBulkTranslationSource(bulkFilesRef.current)
        );
      } else {
        liveSourcePayload = Array.isArray(sourceRowsRef.current) && sourceRowsRef.current.length > 0
          ? canonicalTranslationSourcePayload(sourceRowsRef.current)
          : '';
      }
    } catch {
      // The invalid sentinel below fails the exact-payload comparison.
    }
    const sourceChanged = liveSourcePayload !== sourcePayload
      || (scope === 'project' && sourcePayloadRef.current !== sourcePayload);
    const cacheChanged = scope === 'project' && getActiveTranslationCacheId() !== cacheId;
    if (!mountedRef.current || activeLeaseRef.current !== lease || lease.controller.signal.aborted
        || cacheChanged || sourceChanged) {
      if (sourceChanged || cacheChanged) {
        if (mountedRef.current && activeLeaseRef.current === lease) {
          clearPublishedState();
          setBulkTranslations([]);
        }
      }
      lease.controller.abort(createTranslationAbortError('Translation ownership changed'));
      throw createTranslationAbortError('Translation ownership changed');
    }
  }, [
    activeLeaseRef,
    bulkFilesRef,
    clearPublishedState,
    mountedRef,
    setBulkTranslations,
    sourcePayloadRef,
    sourceRowsRef,
  ]);

  const assertRunOwned = useCallback(async (context) => {
    assertLeaseSync(context.lease, context.cacheId, context.sourcePayload, context.scope);
    if (context.scope === 'batch') return;
    if (typeof context.batchSourcePayload === 'string') {
      assertLeaseSync(context.lease, null, context.batchSourcePayload, 'batch');
    }
    try {
      await assertActiveTranslationIdentity(context.identity);
    } catch (ownershipError) {
      context.lease.controller.abort(createTranslationAbortError('Translation project changed'));
      if (ownershipError?.code === 'projectScopeMismatch') {
        if (mountedRef.current && activeLeaseRef.current === context.lease) {
          clearPublishedState();
          setBulkTranslations([]);
        }
      }
      throw ownershipError;
    }
    assertLeaseSync(context.lease, context.cacheId, context.sourcePayload, context.scope);
    if (typeof context.batchSourcePayload === 'string') {
      assertLeaseSync(context.lease, null, context.batchSourcePayload, 'batch');
    }
  }, [activeLeaseRef, assertLeaseSync, clearPublishedState, mountedRef, setBulkTranslations]);

  const captureRunContext = useCallback(async (
    lease,
    runSourceRows = sourceRowsRef.current,
    { scope = 'project', batchSourcePayload = null } = {}
  ) => {
    const sourceSubtitles = snapshotTranslationSource(runSourceRows);
    const fingerprintPayload = canonicalTranslationSourcePayload(sourceSubtitles);
    if (scope === 'batch') {
      assertLeaseSync(lease, null, fingerprintPayload, scope);
      const sourceFingerprint = await fingerprintTranslationSourcePayload(fingerprintPayload);
      assertLeaseSync(lease, null, fingerprintPayload, scope);
      return Object.freeze({
        runId: lease.runId,
        cacheId: null,
        projectId: null,
        sourceFingerprint,
        sourceSubtitles,
        signal: lease.controller.signal,
        identity: null,
        sourcePayload: fingerprintPayload,
        scope,
        batchSourcePayload: null,
        lease,
      });
    }
    const cacheId = getActiveTranslationCacheId();
    const activeSourcePayload = sourcePayloadRef.current;
    const assertCapturedSources = () => {
      assertLeaseSync(lease, cacheId, activeSourcePayload, scope);
      if (typeof batchSourcePayload === 'string') {
        assertLeaseSync(lease, null, batchSourcePayload, 'batch');
      }
    };
    assertCapturedSources();
    const identity = await resolveTranslationIdentity(cacheId, { create: false });
    assertCapturedSources();
    const sourceFingerprint = await fingerprintTranslationSourcePayload(fingerprintPayload);
    assertCapturedSources();
    await assertActiveTranslationIdentity(identity);
    assertCapturedSources();
    return Object.freeze({
      runId: lease.runId,
      cacheId,
      projectId: identity.projectId,
      sourceFingerprint,
      sourceSubtitles,
      signal: lease.controller.signal,
      identity,
      sourcePayload: activeSourcePayload,
      scope,
      batchSourcePayload,
      lease,
    });
  }, [assertLeaseSync, sourcePayloadRef, sourceRowsRef]);

  const publishComplete = useCallback(async (context, acknowledged, {
    loaded = false,
  } = {}) => {
    const rows = acknowledged.record.baseSubtitles;
    await assertRunOwned(context);
    setTranslatedSubtitles(rows);
    await assertRunOwned(context);
    setLoadedFromCache(loaded);
    await assertRunOwned(context);
    callCompletion(completionRef.current, rows);
    await assertRunOwned(context);
  }, [assertRunOwned, completionRef, setLoadedFromCache, setTranslatedSubtitles]);

  const publishPartial = useCallback(async (context, acknowledged, {
    loaded = false,
  } = {}) => {
    const rows = partialRowsForPresentation(acknowledged.record, context.sourceSubtitles);
    await assertRunOwned(context);
    setTranslatedSubtitles(rows);
    await assertRunOwned(context);
    setLoadedFromCache(loaded);
    await assertRunOwned(context);
    // A mixed translated/original projection must never become the editor/export translation.
    callCompletion(completionRef.current, null);
    await assertRunOwned(context);
  }, [assertRunOwned, completionRef, setLoadedFromCache, setTranslatedSubtitles]);

  return { assertRunOwned, captureRunContext, publishComplete, publishPartial };
};
