import { abortedFailure, fixedFailure } from './nativeUrlDownloadContract';
import {
  assertListenerLive,
  attachAbortBinding,
  detachAbortBinding,
  replayListenerCallback,
} from './nativeUrlDownloadSubscriber';

/**
 * Reopen an asset this adapter already downloaded for the same operation key, without downloading
 * again. Only a genuine native open failure may invalidate the shared cached capability: a project
 * publication failure says nothing about the capability, and a subscriber's own abort or ownership
 * loss is local to that subscriber.
 */
export const createCompletedAssetReopener = ({
  activateProject,
  forgetCompletedAsset,
  openAsset,
  resolveCandidateProject,
}) => async (key, url, completed, {
  onStarted,
  onProgress,
  onSubtitle,
  signalBinding,
  validateOwnership,
}) => {
  const listener = {
    aborted: false,
    handleAbort: null,
    onProgress,
    onStarted,
    onSubtitle,
    settlementError: null,
    settled: false,
    signalAttached: false,
    signalBinding,
    validateOwnership,
  };
  let resolveAbort;
  const aborted = new Promise((resolve) => { resolveAbort = resolve; });
  listener.handleAbort = () => {
    listener.aborted = true;
    resolveAbort(null);
  };
  attachAbortBinding(listener, signalBinding, listener.handleAbort);

  let media;
  let opened = false;
  let activation = null;
  try {
    try {
      await assertListenerLive(listener);
      // The cached asset is owned by the project this URL resolves to, and the native open
      // requires that project to be active.
      activation = await activateProject(await resolveCandidateProject(url), {
        validateOwnership: () => assertListenerLive(listener),
      });
    } catch {
      // activateProject withdraws its own publication before it rejects, so only the subscriber's
      // own abort/ownership loss may replace this fixed failure. The capability is kept.
      await assertListenerLive(listener);
      throw fixedFailure('mediaCandidateProjectFailed');
    }
    try {
      const opening = Promise.resolve().then(() => openAsset(completed.assetId));
      if (signalBinding === null) media = await opening;
      else {
        const race = await Promise.race([
          opening.then((value) => Object.freeze({ value })),
          aborted,
        ]);
        if (race === null) throw abortedFailure();
        media = race.value;
      }
      opened = true;
    } catch {
      activation.release();
      activation = null;
      await assertListenerLive(listener);
      forgetCompletedAsset(key);
    }
    // The caller falls back to a fresh download once the capability is gone.
    if (!opened) return null;
    try {
      await replayListenerCallback(listener, 'onProgress', 100);
      if (completed.subtitle !== null) {
        await replayListenerCallback(listener, 'onSubtitle', completed.subtitle);
      }
      await assertListenerLive(listener);
    } catch (error) {
      activation.release();
      throw error;
    }
    return Object.freeze({ media });
  } finally {
    detachAbortBinding(listener);
  }
};
