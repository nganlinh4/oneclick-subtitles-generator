// Clears the active project's durable translation under its own reset lease.
import { useCallback } from 'react';
import {
  assertTranslationPersistenceReceipt,
  clearTranslationForIdentity,
} from '../platform/translationPersistence';
import { createTranslationAbortError } from '../utils/translationOwnership';
import { isAbort, nextRunId } from './translationRunHelpers';

export const useTranslationReset = ({
  mountedRef,
  activeLeaseRef,
  hydrationControllerRef,
  captureRunContext,
  assertRunOwned,
  clearPublishedState,
  releaseLease,
  setError,
  setTranslationStatus,
  t,
}) => useCallback(async () => {
  if (activeLeaseRef.current?.kind === 'reset') return { status: 'busy' };
  activeLeaseRef.current?.controller.abort(createTranslationAbortError('Translation reset'));
  hydrationControllerRef.current?.abort(createTranslationAbortError('Translation reset'));
  const controller = new AbortController();
  const lease = Object.freeze({ runId: nextRunId(), controller, kind: 'reset' });
  activeLeaseRef.current = lease;
  try {
    const context = await captureRunContext(lease);
    await assertRunOwned(context);
    const receipt = await clearTranslationForIdentity(context.identity);
    await assertRunOwned(context);
    assertTranslationPersistenceReceipt(receipt, context.identity);
    await assertRunOwned(context);
    clearPublishedState();
    await assertRunOwned(context);
    setError('');
    await assertRunOwned(context);
    setTranslationStatus('');
    await assertRunOwned(context);
    return { status: 'cleared', receipt };
  } catch (resetError) {
    if (!isAbort(resetError) && mountedRef.current && activeLeaseRef.current === lease) {
      setError(resetError?.message || t('translation.error', 'Could not reset translation'));
    }
    return { status: isAbort(resetError) ? 'cancelled' : 'failed', error: resetError };
  } finally {
    releaseLease(lease);
  }
}, [
  activeLeaseRef,
  assertRunOwned,
  captureRunContext,
  clearPublishedState,
  hydrationControllerRef,
  mountedRef,
  releaseLease,
  setError,
  setTranslationStatus,
  t,
]);
