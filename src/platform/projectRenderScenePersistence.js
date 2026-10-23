// Durable persistence for the project render scene: CAS writes with conflict reload, the queued
// update batch, and the detached handoffs that keep a project switch from dropping an edit.
import {
  PROJECT_RENDER_SCENE_SCHEMA_VERSION,
  ProjectRenderSceneError,
  cloneTree,
  invalidHostScene,
  normalizeProjectRenderScene,
  normalizeProjectRenderSceneValues,
  sameValues,
  sceneResponse,
  valuesOf,
} from './projectRenderSceneValues';

/**
 * The persistence half of one render-scene authority. `isActive(owner)` is read at every decision
 * point, exactly where the authority used to compare its own `active` binding.
 */
export const createProjectRenderScenePersistence = ({
  invoke,
  isActive,
  cancelTimer,
  publishOwner,
  publishFontAdmissionFailure,
}) => {
  // A project switch must not make a debounced edit evaporate. Detached handoffs may finish while
  // another project is visible, but only a later activation of their own project joins them.
  const detachedHandoffs = new Map();

  const readAuthoritative = async (projectId) => {
    const scene = normalizeProjectRenderScene(await invoke('project_render_scene_get', { projectId }));
    if (scene.projectId !== projectId) throw invalidHostScene();
    return scene;
  };

  const applyPendingUpdates = (owner, { publishFailure = true } = {}) => {
    const pendingUpdates = owner.pendingUpdates.splice(0);
    if (pendingUpdates.length === 0) return;
    let nextValues = owner.values;
    let nextMutation = owner.mutation;
    try {
      for (const pendingUpdate of pendingUpdates) {
        const mutable = cloneTree(nextValues);
        const proposed = typeof pendingUpdate === 'function'
          ? pendingUpdate(mutable)
          : pendingUpdate;
        const next = normalizeProjectRenderSceneValues(proposed);
        if (!sameValues(next, nextValues)) {
          nextValues = next;
          nextMutation += 1;
        }
      }
    } catch (cause) {
      // The batch is transactional: one hostile updater discards the whole queued batch instead of
      // leaving an undocumented prefix applied. Its failure is sticky for this owner so a later
      // capability epoch cannot clear it and strand flush behind the old preparing view.
      const error = new ProjectRenderSceneError(
        'projectRenderSceneQueuedUpdateFailed',
        'A queued render settings update could not be applied',
        { cause },
      );
      owner.pendingUpdateError = error;
      if (publishFailure) publishFontAdmissionFailure(owner, error);
      throw error;
    }
    owner.values = nextValues;
    owner.mutation = nextMutation;
  };

  const reloadAfterConflict = async (
    owner,
    cause,
    { capturedMutation, capturedValues, publish = true },
  ) => {
    const authoritative = await readAuthoritative(owner.projectId);
    const authoritativeValues = normalizeProjectRenderSceneValues(valuesOf(authoritative));
    // Two processes can materialize the same revision-zero default concurrently. The first PUT
    // wins; the loser must adopt that exact durable row rather than report a false conflict or
    // replay its local values over the winner. This is safe only for an exact semantic match.
    if (sameValues(authoritativeValues, capturedValues)) {
      owner.persistedRevision = authoritative.sceneRevision;
      owner.persistedMutation = capturedMutation;
      owner.error = null;
      owner.persistenceError = null;
      if (publish) publishOwner(owner);
      return authoritative;
    }
    if (isActive(owner)) {
      owner.persistedRevision = authoritative.sceneRevision;
      owner.values = authoritativeValues;
      owner.mutation += 1;
      owner.persistedMutation = owner.mutation;
      owner.error = new ProjectRenderSceneError(
        'staleProjectRenderScene',
        'The render settings changed elsewhere and were reloaded',
        { cause, authoritativeScene: authoritative },
      );
      owner.persistenceError = owner.error;
      publishOwner(owner);
    }
    throw owner.error ?? cause;
  };

  const persistOwner = async (owner, { publish = true } = {}) => {
    if (owner.writing !== null) return owner.writing;
    owner.writing = (async () => {
      while (owner.mutation !== owner.persistedMutation) {
        const capturedMutation = owner.mutation;
        const capturedValues = normalizeProjectRenderSceneValues(owner.values);
        const expectedSceneRevision = owner.persistedRevision;
        let receipt;
        try {
          receipt = normalizeProjectRenderScene(await invoke('project_render_scene_put', {
            projectId: owner.projectId,
            expectedSceneRevision,
            scene: {
              schemaVersion: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
              ...capturedValues,
            },
          }));
        } catch (error) {
          if (error?.code === 'staleProjectRenderScene') {
            await reloadAfterConflict(owner, error, {
              capturedMutation,
              capturedValues,
              publish,
            });
            continue;
          }
          if (isActive(owner)) {
            owner.error = new ProjectRenderSceneError(
              'projectRenderSceneWriteFailed',
              'The render settings could not be saved',
              { cause: error },
            );
            owner.persistenceError = owner.error;
            if (publish) publishOwner(owner);
          }
          throw owner.error ?? error;
        }
        if (receipt.projectId !== owner.projectId
            || receipt.sceneRevision !== expectedSceneRevision + 1
            || !sameValues(normalizeProjectRenderSceneValues(valuesOf(receipt)), capturedValues)) {
          const error = invalidHostScene();
          if (isActive(owner)) {
            owner.error = error;
            owner.persistenceError = error;
            if (publish) publishOwner(owner);
          }
          throw error;
        }
        owner.persistedRevision = receipt.sceneRevision;
        owner.persistedMutation = capturedMutation;
        owner.error = null;
        owner.persistenceError = null;
        if (publish) publishOwner(owner);
      }
      return sceneResponse(owner.projectId, owner.persistedRevision, owner.values);
    })().finally(() => {
      owner.writing = null;
    });
    return owner.writing;
  };

  const registerDetachedHandoff = (owner, work) => {
    const existing = detachedHandoffs.get(owner.projectId);
    if (existing?.owner === owner) return existing.promise;
    const record = { owner, promise: null, error: null };
    let pending;
    try {
      pending = work();
    } catch (cause) {
      pending = Promise.reject(cause);
    }
    record.promise = Promise.resolve(pending)
      .then((scene) => {
        if (detachedHandoffs.get(owner.projectId) === record) {
          detachedHandoffs.delete(owner.projectId);
        }
        return scene;
      })
      .catch((cause) => {
        record.error = cause instanceof ProjectRenderSceneError
          ? cause
          : new ProjectRenderSceneError(
            'projectRenderSceneHandoffFailed',
            'The previous project render settings could not be saved during project switch',
            { cause, projectId: owner.projectId },
          );
        throw record.error;
      });
    detachedHandoffs.set(owner.projectId, record);
    // Project publication is not the rejection channel. A later activation of this exact project
    // joins and surfaces the typed failure; the currently visible project remains isolated.
    void record.promise.catch(() => undefined);
    return record.promise;
  };

  const startDetachedHandoff = (owner) => {
    cancelTimer(owner);
    if (owner.initialized !== true) {
      if (owner.loading === null
          || (owner.pendingUpdates.length === 0 && owner.writing === null)) return null;
      // `update()` explicitly accepts state while the native row is loading. Once accepted, a
      // project switch cannot silently discard it. Let this owner finish initialization without
      // publication, then persist the queued mutation; B remains visible and only a return to this
      // exact project waits for the handoff.
      owner.detached = true;
      return registerDetachedHandoff(owner, async () => {
        await owner.loading;
        if (owner.initialized !== true) {
          throw new ProjectRenderSceneError(
            'projectRenderSceneHandoffFailed',
            'The previous project render settings could not finish loading during project switch',
            { projectId: owner.projectId },
          );
        }
        return persistOwner(owner, { publish: false });
      });
    }

    let queuedFailure = null;
    if (owner.pendingUpdates.length > 0) {
      try {
        applyPendingUpdates(owner, { publishFailure: false });
      } catch (error) {
        queuedFailure = error;
      }
    }
    if (queuedFailure === null
        && owner.writing === null
        && owner.mutation === owner.persistedMutation) return null;
    return registerDetachedHandoff(owner, () => (queuedFailure === null
      ? persistOwner(owner, { publish: false })
      : Promise.reject(queuedFailure)));
  };

  const joinDetachedHandoff = async (projectId) => {
    const record = detachedHandoffs.get(projectId);
    if (record === undefined) return;
    await record.promise;
  };

  const joinAllDetachedHandoffs = async () => {
    // A completed record removes itself. Loop because a project switch may replace or add a record
    // while this checkpoint is awaiting an older one. A failed record deliberately remains and its
    // typed rejection stops shutdown rather than claiming edits were durable when they were not.
    while (detachedHandoffs.size > 0) {
      const pending = [...new Set(
        [...detachedHandoffs.values()].map((record) => record.promise),
      )];
      await Promise.all(pending);
    }
  };

  return Object.freeze({
    readAuthoritative,
    applyPendingUpdates,
    persistOwner,
    startDetachedHandoff,
    joinDetachedHandoff,
    joinAllDetachedHandoffs,
  });
};
