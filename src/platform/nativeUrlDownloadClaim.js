import { candidateAssetId, fixedFailure } from './nativeUrlDownloadContract';
import { assertListenerLive } from './nativeUrlDownloadSubscriber';
import {
  isSubtitleProjectBindingReceipt,
  rollbackSubtitleProjectBinding,
} from './subtitleProjectBinding';

/**
 * Turns one completed native download candidate into project-bound media, or discards it. The
 * candidate is claimed only while a live subscriber still owns the operation: through the owner's
 * admit/publish/rollback transaction when it supplies one, else through the legacy test activator.
 */
export const createCandidateClaimer = ({
  activateProject,
  claimCandidate,
  discardCandidate,
  operation,
  publishToLiveListeners,
  resolveCandidateProject,
  revalidateListeners,
  url,
}) => {
  const discardCandidateOnce = async (candidate) => {
    const assetId = candidateAssetId(candidate);
    if (operation.discardedCandidateIds.has(assetId)) return;
    try {
      const discarded = await Promise.resolve(discardCandidate(assetId));
      if (discarded !== true) throw fixedFailure('mediaCandidateDiscardFailed');
      operation.discardedCandidateIds.add(assetId);
    } catch {
      throw fixedFailure('mediaCandidateDiscardFailed');
    }
  };

  // Ownership hook for steps which must fail closed rather than return a boolean. Losing
  // subscribers are settled with their own abort/ownership error before this throws.
  const assertOperationOwned = async () => {
    if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
      throw fixedFailure('mediaCandidateOwnershipLost');
    }
  };

  const transactionalOwner = () => (
    [...operation.listeners].find((listener) => (
      typeof listener.admitActivation === 'function'
      && typeof listener.publishActivation === 'function'
      && typeof listener.rollbackActivation === 'function'
      && typeof listener.validateOwnership === 'function'
    )) ?? null
  );

  const claimCompletedCandidate = async (event, settle) => {
    const candidate = event.media;
    try {
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        await discardCandidateOnce(candidate);
        return;
      }
      operation.subtitle = event.subtitle ?? null;
      if (operation.subtitle !== null
          && !await publishToLiveListeners(operation, 'onSubtitle', operation.subtitle)) {
        await discardCandidateOnce(candidate);
        return;
      }
      // Resolving creates the durable project on demand, so never resolve for an operation
      // which has already lost every subscriber. It is still detached: neither project
      // publication nor native media selection may happen until the caller's admission below.
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        await discardCandidateOnce(candidate);
        return;
      }
      const resolved = await resolveCandidateProject(url);
      await assertOperationOwned();
      let media;
      const owner = transactionalOwner();
      if (owner !== null) {
        let binding = null;
        try {
          await assertListenerLive(owner);
          binding = await owner.admitActivation(Object.freeze({
            assetId: candidateAssetId(candidate),
            resolvedProject: resolved,
            url,
          }), { validateOwnership: assertOperationOwned });
          await assertOperationOwned();
          if (!isSubtitleProjectBindingReceipt(binding, {
            cacheId: resolved?.cacheId,
            projectId: resolved?.projectId,
          }) || !Number.isSafeInteger(binding.stateVersion) || binding.stateVersion < 0) {
            throw fixedFailure('mediaCandidateProjectFailed');
          }
          media = await claimCandidate(candidate, {
            expectedStateVersion: binding.stateVersion,
            projectId: binding.projectId,
          }, { validateOwnership: assertOperationOwned });
          await assertOperationOwned();
          await owner.publishActivation(media, binding, {
            validateOwnership: assertOperationOwned,
          });
          await assertOperationOwned();
        } catch (error) {
          if (binding !== null && rollbackSubtitleProjectBinding(binding)) {
            try {
              await owner.rollbackActivation({ validateOwnership: assertOperationOwned });
            } catch {
              throw fixedFailure('mediaActivationRollbackFailed');
            }
          }
          throw error;
        }
      } else {
        if (typeof activateProject !== 'function') {
          throw fixedFailure('mediaActivationAdmissionRequired');
        }
        // Test-only compatibility for the reviewed legacy adapter contract. The shipping
        // singleton has no activator and therefore cannot enter this branch.
        const activation = await activateProject(resolved, {
          validateOwnership: assertOperationOwned,
        });
        try {
          media = await claimCandidate(candidate, activation.claimOptions, {
            validateOwnership: assertOperationOwned,
          });
        } catch (error) {
          activation.release();
          throw error;
        }
      }
      settle({
        kind: 'completed',
        media,
        assetId: candidateAssetId(candidate),
        subtitle: operation.subtitle,
      });
    } catch (error) {
      try {
        await discardCandidateOnce(candidate);
        settle({
          kind: 'failed',
          error: error?.code === 'mediaActivationRollbackFailed'
            ? error
            : fixedFailure('mediaOpenFailed'),
        });
      } catch (discardError) {
        settle({ kind: 'failed', error: discardError });
      }
    }
  };

  return claimCompletedCandidate;
};
