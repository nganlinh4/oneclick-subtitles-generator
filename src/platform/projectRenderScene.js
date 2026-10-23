// The active project's render-scene authority and its React hook. Values, persistence and font
// admission live in the sibling projectRenderScene*.js modules.
import { useEffect, useSyncExternalStore } from 'react';

import { consumeLegacyRenderScene } from '../components/VideoRenderingSection/renderPreferences';
import { inspectProjectSubtitleFontAdmission } from '../services/projectSubtitleFontRepair';
import {
  fontCapabilitySnapshot,
  subscribeToFontReadiness,
} from '../services/fontCapability';
import { registerDurableLyricsHistoryFlusher } from './durableLyricsCheckpoint';
import { invokeDesktop } from './desktopRuntime';
import {
  getActiveProjectSnapshot,
  subscribeToActiveProject,
} from './projectService';
import { createProjectRenderSceneAdmission } from './projectRenderSceneAdmission';
import { createProjectRenderScenePersistence } from './projectRenderScenePersistence';
import {
  PROJECT_RENDER_SCENE_DEBOUNCE_MS,
  ProjectRenderSceneError,
  activeProjectId,
  admittedFont,
  cloneTree,
  defaultProjectRenderSceneValues,
  freezeTree,
  inactiveView,
  normalizeProjectRenderSceneValues,
  sameValues,
  sceneResponse,
  valuesOf,
} from './projectRenderSceneValues';

export {
  defaultProjectRenderSceneValues,
  normalizeProjectRenderScene,
  normalizeProjectRenderSceneValues,
} from './projectRenderSceneValues';

/**
 * One process authority for the active project's independently-versioned render scene.
 *
 * Writes are coalesced, but they are never detached promises: `flush()` joins the exact active
 * generation, and app close/update/render all use that barrier. A request that finishes after an
 * A→B switch may durably finish A's CAS, but it cannot publish into B's state. Returning to A loads
 * Rust again, so even that legitimate detached completion cannot be hidden by a stale JS cache.
 */
export const createProjectRenderSceneAuthority = ({
  invoke = invokeDesktop,
  subscribeProject = subscribeToActiveProject,
  getProject = getActiveProjectSnapshot,
  consumeLegacy = consumeLegacyRenderScene,
  inspectFontAdmission = admittedFont,
  subscribeFontCapability = () => () => undefined,
  schedule = setTimeout,
  cancel = clearTimeout,
  debounceMs = PROJECT_RENDER_SCENE_DEBOUNCE_MS,
} = {}) => {
  if (typeof invoke !== 'function' || typeof subscribeProject !== 'function'
      || typeof getProject !== 'function' || typeof consumeLegacy !== 'function'
      || typeof inspectFontAdmission !== 'function' || typeof subscribeFontCapability !== 'function'
      || typeof schedule !== 'function' || typeof cancel !== 'function'
      || !Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 10_000) {
    throw new TypeError('The project render-scene authority requires reviewed dependencies');
  }

  let view = inactiveView;
  let generation = 0;
  let active = null;
  let started = false;
  let unsubscribeProject = null;
  let unsubscribeFontCapability = null;
  let unregisterCheckpoint = null;
  const subscribers = new Set();

  const publish = (next) => {
    view = freezeTree(next);
    for (const subscriber of [...subscribers]) {
      if (!subscribers.has(subscriber)) continue;
      try {
        subscriber();
      } catch (error) {
        console.error('[projectRenderScene] Subscriber failed:', error);
      }
    }
  };

  const cancelTimer = (owner) => {
    if (owner?.timer === null || owner?.timer === undefined) return;
    cancel(owner.timer);
    owner.timer = null;
  };

  const publishOwner = (owner) => {
    if (active !== owner) return;
    if (owner.fontAdmissionStatus === 'preparing'
        || owner.fontAdmissionStatus === 'repairing') return;
    const status = owner.error === null ? 'ready' : 'failed';
    const dirty = owner.mutation !== owner.persistedMutation;
    if (view.status === status
        && view.projectId === owner.projectId
        && view.scene?.sceneRevision === owner.persistedRevision
        && sameValues(valuesOf(view.scene), owner.values)
        && view.error === owner.error
        && view.dirty === dirty
        && view.fontRepair === owner.lastFontRepair) return;
    publish({
      status,
      projectId: owner.projectId,
      scene: sceneResponse(owner.projectId, owner.persistedRevision, owner.values),
      error: owner.error,
      dirty,
      fontRepair: owner.lastFontRepair,
    });
  };

  const publishFontAdmission = (owner, status) => {
    if (active !== owner) return;
    owner.fontAdmissionStatus = status;
    publish({
      status,
      projectId: owner.projectId,
      // A blocked scene is deliberately not exposed. Supplying its stale face to even one preview
      // frame would recreate the failure this admission barrier exists to prevent.
      scene: null,
      error: null,
      dirty: owner.mutation !== owner.persistedMutation,
      fontRepair: null,
    });
  };

  const publishFontAdmissionFailure = (owner, error) => {
    if (active !== owner) return;
    owner.fontAdmissionStatus = 'failed';
    owner.error = error;
    const dirty = owner.mutation !== owner.persistedMutation;
    if (view.status === 'failed'
        && view.projectId === owner.projectId
        && view.scene === null
        && view.error === error
        && view.dirty === dirty
        && view.fontRepair === null) return;
    publish({
      status: 'failed',
      projectId: owner.projectId,
      scene: null,
      error,
      dirty,
      fontRepair: null,
    });
  };
  const waitForAdmissionChange = (owner) => new Promise((resolve) => {
    const stop = (() => {
      const subscriber = () => {
        if (active === owner && (view.status === 'preparing' || view.status === 'repairing')) return;
        subscribers.delete(subscriber);
        resolve();
      };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    })();
    // Close the race between the caller's status read and subscriber registration.
    if (active !== owner || (view.status !== 'preparing' && view.status !== 'repairing')) {
      stop();
      resolve();
    }
  });
  const isActive = (owner) => active === owner;
  const {
    readAuthoritative,
    applyPendingUpdates,
    persistOwner,
    startDetachedHandoff,
    joinDetachedHandoff,
    joinAllDetachedHandoffs,
  } = createProjectRenderScenePersistence({
    invoke,
    isActive,
    cancelTimer,
    publishOwner,
    publishFontAdmissionFailure,
  });
  const admitOwner = createProjectRenderSceneAdmission({
    isActive,
    inspectFontAdmission,
    cancelTimer,
    applyPendingUpdates,
    persistOwner,
    publishOwner,
    publishFontAdmission,
    publishFontAdmissionFailure,
  });

  const flush = async () => {
    let owner = active;
    if (owner === null) return null;
    cancelTimer(owner);
    if (owner.loading !== null) await owner.loading;
    if (active !== owner) return flush();
    while (view.status === 'preparing' || view.status === 'repairing') {
      await waitForAdmissionChange(owner);
      if (active !== owner) return flush();
    }
    if (owner.error !== null) throw owner.error;
    const persisted = await persistOwner(owner);
    if (active !== owner) return flush();
    // A normal user update can change the face between the first admission and this flush. Inspect
    // once more before handing the scene to export; if it needs repair, the same barrier owns it.
    await admitOwner(owner);
    if (active !== owner) return flush();
    while (view.status === 'preparing' || view.status === 'repairing') {
      await waitForAdmissionChange(owner);
      if (active !== owner) return flush();
    }
    if (view.status !== 'ready' || view.scene === null) throw owner.error ?? new ProjectRenderSceneError(
      'projectRenderSceneUnavailable',
      'The active project render settings are not ready',
    );
    return view.scene.sceneRevision === persisted.sceneRevision
      ? persisted
      : view.scene;
  };

  /**
   * Persist editor state for app-close/update without waiting on an unrelated font capability.
   *
   * Export uses `flush`, whose admission barrier is intentionally strict. A shutdown checkpoint
   * has a different obligation: save bytes and finish. If native never publishes readiness, making
   * close wait forever would turn a non-error preparing state into an application deadlock.
   */
  const checkpoint = async () => {
    await joinAllDetachedHandoffs();
    const owner = active;
    if (owner === null) return null;
    cancelTimer(owner);
    if (owner.loading !== null) await owner.loading;
    if (active !== owner) return checkpoint();
    applyPendingUpdates(owner);
    if (owner.error !== null) throw owner.error;
    const persisted = await persistOwner(owner, { publish: view.status === 'ready' });
    if (active !== owner) return checkpoint();
    if (active === owner && (view.status === 'preparing' || view.status === 'repairing')) {
      publishFontAdmission(owner, view.status);
    }
    return persisted;
  };

  const schedulePersist = (owner) => {
    cancelTimer(owner);
    owner.timer = schedule(() => {
      owner.timer = null;
      void persistOwner(owner).catch(() => undefined);
    }, debounceMs);
  };

  const activate = (snapshot) => {
    const projectId = activeProjectId(snapshot);
    generation += 1;
    if (active !== null) startDetachedHandoff(active);
    active = null;
    if (projectId === null) {
      publish(inactiveView);
      return Promise.resolve(null);
    }
    const owner = {
      projectId,
      generation,
      persistedRevision: 0,
      values: defaultProjectRenderSceneValues(),
      mutation: 0,
      persistedMutation: 0,
      timer: null,
      writing: null,
      loading: null,
      error: null,
      persistenceError: null,
      pendingUpdateError: null,
      pendingUpdates: [],
      initialized: false,
      detached: false,
      admitting: null,
      lastFontRepair: null,
      requiredFontRepairMutation: null,
      fontAdmissionStatus: 'loading',
    };
    active = owner;
    publish({
      status: 'loading', projectId, scene: null, error: null, dirty: false, fontRepair: null,
    });
    owner.loading = (async () => {
      await joinDetachedHandoff(projectId);
      if (active !== owner && owner.detached !== true) return null;
      let loaded = await readAuthoritative(projectId);
      if (active !== owner && owner.detached !== true) return null;

      // Revision zero is a Rust-owned virtual default, not a durable project row. Materialize either
      // the one bounded legacy import or Rust's exact returned values before publishing ready. An
      // untouched project's appearance must not silently change when a later binary changes its
      // built-in defaults.
      if (loaded.sceneRevision === 0) {
        const legacy = consumeLegacy();
        if (active !== owner && owner.detached !== true) return null;
        owner.values = normalizeProjectRenderSceneValues(
          legacy === null ? valuesOf(loaded) : legacy,
        );
        owner.mutation = 1;
        loaded = await persistOwner(owner, { publish: false });
      }
      if (active !== owner && owner.detached !== true) return null;
      owner.persistedRevision = loaded.sceneRevision;
      owner.values = normalizeProjectRenderSceneValues(valuesOf(loaded));
      owner.mutation += 1;
      owner.persistedMutation = owner.mutation;
      applyPendingUpdates(owner);
      owner.error = null;
      owner.initialized = true;
      await admitOwner(owner);
      if (active === owner && view.status === 'ready'
          && owner.mutation !== owner.persistedMutation) schedulePersist(owner);
      return loaded;
    })().catch((cause) => {
      if (active === owner) {
        owner.error = cause instanceof ProjectRenderSceneError
          ? cause
          : new ProjectRenderSceneError(
            'projectRenderSceneLoadFailed',
            'The project render settings could not be loaded',
            { cause },
          );
        if (owner.initialized === true && owner.requiredFontRepairMutation !== null) {
          publishFontAdmissionFailure(owner, owner.error);
          throw cause;
        }
        // Loading never established an authoritative scene. Exposing the owner's provisional
        // revision-zero defaults beside a failed status lets consumers accidentally render the
        // very undurable state this activation barrier exists to prevent.
        publish({
          status: 'failed',
          projectId: owner.projectId,
          scene: null,
          error: owner.error,
          dirty: false,
          fontRepair: null,
        });
      }
      throw cause;
    }).finally(() => {
      owner.loading = null;
    });
    // Project publication is not an error-delivery channel; the failed view is authoritative and
    // the render barrier will surface it. Avoid an unhandled rejection from a subscription callback.
    void owner.loading.catch(() => undefined);
    return owner.loading;
  };

  const update = (updater) => {
    const owner = active;
    if (owner === null) {
      throw new ProjectRenderSceneError(
        'projectRenderSceneUnavailable',
        'The active project render settings are not ready',
      );
    }
    if (view.status === 'loading' || view.status === 'preparing' || view.status === 'repairing') {
      owner.pendingUpdates.push(updater);
      return null;
    }
    if (view.status !== 'ready') {
      throw new ProjectRenderSceneError(
        'projectRenderSceneUnavailable',
        'The active project render settings are not ready',
      );
    }
    const mutable = cloneTree(owner.values);
    const proposed = typeof updater === 'function' ? updater(mutable) : updater;
    const next = normalizeProjectRenderSceneValues(proposed);
    if (sameValues(next, owner.values)) return view.scene;
    owner.values = next;
    owner.mutation += 1;
    owner.error = null;
    // Admission is synchronous through its first state publication. An invalid font update moves
    // the shared view directly to `repairing`; no subscriber can receive a ready scene containing
    // the dead face, even for one React frame.
    void admitOwner(owner).then(() => {
      if (active === owner && view.status === 'ready'
          && owner.mutation !== owner.persistedMutation) schedulePersist(owner);
    }).catch(() => undefined);
    return view.scene;
  };

  const start = () => {
    if (started) return;
    started = true;
    unsubscribeProject = subscribeProject(activate);
    unsubscribeFontCapability = subscribeFontCapability(() => {
      const owner = active;
      if (owner?.initialized !== true) return;
      void admitOwner(owner).then(() => {
        // Updates accepted while readiness was preparing had no caller waiting to schedule their
        // write: their `update()` returned after queueing, and this capability callback is what
        // eventually applies them. Once admission opens, give those mutations the same durable
        // debounce every ordinary ready-state edit receives.
        if (active === owner && view.status === 'ready'
            && owner.mutation !== owner.persistedMutation) schedulePersist(owner);
      }).catch(() => undefined);
    });
    unregisterCheckpoint = registerDurableLyricsHistoryFlusher(checkpoint);
    void activate(getProject()).catch(() => undefined);
  };

  const stop = () => {
    if (!started) return;
    started = false;
    unsubscribeProject?.();
    unsubscribeFontCapability?.();
    unregisterCheckpoint?.();
    unsubscribeProject = null;
    unsubscribeFontCapability = null;
    unregisterCheckpoint = null;
    generation += 1;
    if (active !== null) cancelTimer(active);
    active = null;
    publish(inactiveView);
  };

  const subscribe = (subscriber) => {
    if (typeof subscriber !== 'function') throw new TypeError('A render-scene subscriber is required');
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  };

  return Object.freeze({
    start,
    stop,
    activate,
    update,
    flush,
    checkpoint,
    subscribe,
    getSnapshot: () => view,
  });
};

const projectRenderSceneAuthority = createProjectRenderSceneAuthority({
  inspectFontAdmission: (scene) => inspectProjectSubtitleFontAdmission({
    fontFamily: scene.customization.fontFamily,
    fontWeight: scene.customization.fontWeight,
    capability: fontCapabilitySnapshot(),
  }),
  subscribeFontCapability: subscribeToFontReadiness,
});

export const useProjectRenderScene = () => {
  useEffect(() => {
    projectRenderSceneAuthority.start();
  }, []);
  const snapshot = useSyncExternalStore(
    projectRenderSceneAuthority.subscribe,
    projectRenderSceneAuthority.getSnapshot,
    () => inactiveView,
  );
  return Object.freeze({
    ...snapshot,
    updateScene: projectRenderSceneAuthority.update,
    flushScene: projectRenderSceneAuthority.flush,
  });
};
