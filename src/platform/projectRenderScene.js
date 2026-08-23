import { useEffect, useSyncExternalStore } from 'react';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  DEFAULT_CROP_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  consumeLegacyRenderScene,
} from '../components/VideoRenderingSection/renderPreferences';
import { registerDurableLyricsHistoryFlusher } from './durableLyricsCheckpoint';
import { invokeDesktop } from './desktopRuntime';
import {
  getActiveProjectSnapshot,
  subscribeToActiveProject,
} from './projectService';
import { isUuidV7 } from './projectSnapshotAdapter';
import {
  normalizeNativeRenderCrop,
  normalizeNativeRenderSettings,
  normalizeNativeSubtitleCustomization,
} from './renderService';

export const PROJECT_RENDER_SCENE_SCHEMA_VERSION = 1;
export const PROJECT_RENDER_SCENE_DEBOUNCE_MS = 175;

const SCENE_VALUE_KEYS = Object.freeze([
  'selectedSubtitles', 'selectedNarration', 'renderSettings', 'customization', 'crop',
]);
const SCENE_RESPONSE_KEYS = Object.freeze([
  'schemaVersion', 'projectId', 'sceneRevision', ...SCENE_VALUE_KEYS,
]);
const RENDER_SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_RENDER_SETTINGS));
const CUSTOMIZATION_KEYS = Object.freeze(Object.keys(defaultCustomization));
const CROP_KEYS = Object.freeze(Object.keys(DEFAULT_CROP_SETTINGS));
const SUBTITLE_SOURCES = new Set(['original', 'translated']);
const NARRATION_SOURCES = new Set(['none', 'generated']);

export class ProjectRenderSceneError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectRenderSceneError';
    this.code = code;
    Object.assign(this, details);
  }
}

const invalidScene = (message = 'The project render scene is invalid') => (
  new ProjectRenderSceneError('invalidProjectRenderScene', message)
);

const invalidHostScene = () => new ProjectRenderSceneError(
  'invalidProjectRenderSceneResponse',
  'The desktop host returned an invalid project render scene',
);

const plainSnapshot = (value) => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    )) return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch {
    return null;
  }
};

const exactSnapshot = (value, keys) => {
  const snapshot = plainSnapshot(value);
  if (snapshot === null || Object.keys(snapshot).length !== keys.length
      || !keys.every((key) => Object.hasOwn(snapshot, key))) return null;
  return snapshot;
};

const freezeTree = (value) => {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeTree);
  return Object.freeze(value);
};

const cloneTree = (value) => {
  if (Array.isArray(value)) return value.map(cloneTree);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneTree(child)]));
  }
  return value;
};

const sameValues = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const valuesOf = (scene) => Object.fromEntries(
  SCENE_VALUE_KEYS.map((key) => [key, scene[key]]),
);

export const defaultProjectRenderSceneValues = () => freezeTree({
  selectedSubtitles: 'original',
  selectedNarration: 'none',
  renderSettings: { ...DEFAULT_RENDER_SETTINGS },
  customization: { ...defaultCustomization },
  crop: { ...DEFAULT_CROP_SETTINGS },
});

/**
 * Strictly own the exact UI scene that both the render-tab preview and export consume.
 *
 * The three native normalizers are the export boundary's own validators. We convert the settings
 * timestamps back to seconds only because React's trim control is denominated in seconds; no value
 * is repaired or defaulted here. Missing, unknown, hostile-accessor and out-of-range values refuse.
 */
export const normalizeProjectRenderSceneValues = (candidate) => {
  const scene = exactSnapshot(candidate, SCENE_VALUE_KEYS);
  if (scene === null
      || !SUBTITLE_SOURCES.has(scene.selectedSubtitles)
      || !NARRATION_SOURCES.has(scene.selectedNarration)) throw invalidScene();

  const rawSettings = exactSnapshot(scene.renderSettings, RENDER_SETTING_KEYS);
  const rawCustomization = exactSnapshot(scene.customization, CUSTOMIZATION_KEYS);
  const rawCrop = exactSnapshot(scene.crop, CROP_KEYS);
  if (rawSettings === null || rawCustomization === null || rawCrop === null
      || rawSettings.videoType !== 'Subtitled Video') throw invalidScene();

  let settings;
  let customization;
  let crop;
  try {
    settings = normalizeNativeRenderSettings(rawSettings);
    customization = normalizeNativeSubtitleCustomization(rawCustomization);
    crop = normalizeNativeRenderCrop(rawCrop);
  } catch (cause) {
    throw new ProjectRenderSceneError(
      'invalidProjectRenderScene',
      'The project render scene contains a value the native renderer cannot use',
      { cause },
    );
  }

  return freezeTree({
    selectedSubtitles: scene.selectedSubtitles,
    selectedNarration: scene.selectedNarration,
    renderSettings: {
      resolution: settings.resolution,
      frameRate: settings.frameRate,
      videoType: 'Subtitled Video',
      originalAudioVolume: settings.originalAudioVolume,
      narrationVolume: settings.narrationVolume,
      trimStart: settings.trimStartUs / 1_000_000,
      trimEnd: settings.trimEndUs === null ? 0 : settings.trimEndUs / 1_000_000,
    },
    customization: { ...customization },
    crop: { ...crop },
  });
};

export const normalizeProjectRenderScene = (candidate) => {
  const response = exactSnapshot(candidate, SCENE_RESPONSE_KEYS);
  if (response === null
      || response.schemaVersion !== PROJECT_RENDER_SCENE_SCHEMA_VERSION
      || !isUuidV7(response.projectId)
      || !Number.isSafeInteger(response.sceneRevision)
      || response.sceneRevision < 0) throw invalidHostScene();
  const values = normalizeProjectRenderSceneValues(valuesOf(response));
  return freezeTree({
    schemaVersion: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
    projectId: response.projectId,
    sceneRevision: response.sceneRevision,
    ...values,
  });
};

const sceneResponse = (projectId, sceneRevision, values) => freezeTree({
  schemaVersion: PROJECT_RENDER_SCENE_SCHEMA_VERSION,
  projectId,
  sceneRevision,
  ...values,
});

const activeProjectId = (snapshot) => {
  const id = plainSnapshot(plainSnapshot(snapshot)?.metadata)?.id;
  return isUuidV7(id) ? id : null;
};

const inactiveView = Object.freeze({
  status: 'inactive', projectId: null, scene: null, error: null, dirty: false,
});

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
  schedule = setTimeout,
  cancel = clearTimeout,
  debounceMs = PROJECT_RENDER_SCENE_DEBOUNCE_MS,
} = {}) => {
  if (typeof invoke !== 'function' || typeof subscribeProject !== 'function'
      || typeof getProject !== 'function' || typeof consumeLegacy !== 'function'
      || typeof schedule !== 'function' || typeof cancel !== 'function'
      || !Number.isSafeInteger(debounceMs) || debounceMs < 0 || debounceMs > 10_000) {
    throw new TypeError('The project render-scene authority requires reviewed dependencies');
  }

  let view = inactiveView;
  let generation = 0;
  let active = null;
  let started = false;
  let unsubscribeProject = null;
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
    publish({
      status: owner.error === null ? 'ready' : 'failed',
      projectId: owner.projectId,
      scene: sceneResponse(owner.projectId, owner.persistedRevision, owner.values),
      error: owner.error,
      dirty: owner.mutation !== owner.persistedMutation,
    });
  };

  const readAuthoritative = async (projectId) => {
    const scene = normalizeProjectRenderScene(await invoke('project_render_scene_get', { projectId }));
    if (scene.projectId !== projectId) throw invalidHostScene();
    return scene;
  };

  const reloadAfterConflict = async (owner, cause) => {
    const authoritative = await readAuthoritative(owner.projectId);
    if (active === owner) {
      owner.persistedRevision = authoritative.sceneRevision;
      owner.values = normalizeProjectRenderSceneValues(valuesOf(authoritative));
      owner.mutation += 1;
      owner.persistedMutation = owner.mutation;
      owner.error = new ProjectRenderSceneError(
        'staleProjectRenderScene',
        'The render settings changed elsewhere and were reloaded',
        { cause, authoritativeScene: authoritative },
      );
      publishOwner(owner);
    }
    throw owner.error ?? cause;
  };

  const persistOwner = async (owner) => {
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
            return reloadAfterConflict(owner, error);
          }
          if (active === owner) {
            owner.error = new ProjectRenderSceneError(
              'projectRenderSceneWriteFailed',
              'The render settings could not be saved',
              { cause: error },
            );
            publishOwner(owner);
          }
          throw owner.error ?? error;
        }
        if (receipt.projectId !== owner.projectId
            || receipt.sceneRevision !== expectedSceneRevision + 1
            || !sameValues(normalizeProjectRenderSceneValues(valuesOf(receipt)), capturedValues)) {
          const error = invalidHostScene();
          if (active === owner) {
            owner.error = error;
            publishOwner(owner);
          }
          throw error;
        }
        owner.persistedRevision = receipt.sceneRevision;
        owner.persistedMutation = capturedMutation;
        owner.error = null;
        publishOwner(owner);
      }
      return sceneResponse(owner.projectId, owner.persistedRevision, owner.values);
    })().finally(() => {
      owner.writing = null;
    });
    return owner.writing;
  };

  const flush = async () => {
    const owner = active;
    if (owner === null) return null;
    cancelTimer(owner);
    if (owner.loading !== null) await owner.loading;
    if (active !== owner) return flush();
    if (owner.error !== null && owner.mutation === owner.persistedMutation) throw owner.error;
    return persistOwner(owner);
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
    if (active !== null) cancelTimer(active);
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
      pendingUpdates: [],
    };
    active = owner;
    publish({ status: 'loading', projectId, scene: null, error: null, dirty: false });
    owner.loading = (async () => {
      let loaded = await readAuthoritative(projectId);
      if (active !== owner) return null;

      // One bounded compatibility import. The global legacy record can belong only to the first
      // project that observes it; it is consumed and deleted before any later project can see it.
      if (loaded.sceneRevision === 0) {
        const legacy = consumeLegacy();
        if (legacy !== null && active === owner) {
          owner.values = normalizeProjectRenderSceneValues(legacy);
          owner.mutation = 1;
          loaded = await persistOwner(owner);
        }
      }
      if (active !== owner) return null;
      owner.persistedRevision = loaded.sceneRevision;
      owner.values = normalizeProjectRenderSceneValues(valuesOf(loaded));
      owner.mutation += 1;
      owner.persistedMutation = owner.mutation;
      for (const pendingUpdate of owner.pendingUpdates.splice(0)) {
        const mutable = cloneTree(owner.values);
        const proposed = typeof pendingUpdate === 'function'
          ? pendingUpdate(mutable)
          : pendingUpdate;
        const next = normalizeProjectRenderSceneValues(proposed);
        if (!sameValues(next, owner.values)) {
          owner.values = next;
          owner.mutation += 1;
        }
      }
      owner.error = null;
      publishOwner(owner);
      if (owner.mutation !== owner.persistedMutation) schedulePersist(owner);
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
        publishOwner(owner);
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
    if (view.status === 'loading') {
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
    publishOwner(owner);
    schedulePersist(owner);
    return view.scene;
  };

  const start = () => {
    if (started) return;
    started = true;
    unsubscribeProject = subscribeProject(activate);
    unregisterCheckpoint = registerDurableLyricsHistoryFlusher(flush);
    void activate(getProject()).catch(() => undefined);
  };

  const stop = () => {
    if (!started) return;
    started = false;
    unsubscribeProject?.();
    unregisterCheckpoint?.();
    unsubscribeProject = null;
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
    subscribe,
    getSnapshot: () => view,
  });
};

const projectRenderSceneAuthority = createProjectRenderSceneAuthority();

export const flushProjectRenderScene = (...args) => {
  projectRenderSceneAuthority.start();
  return projectRenderSceneAuthority.flush(...args);
};
export const updateProjectRenderScene = (...args) => {
  projectRenderSceneAuthority.start();
  return projectRenderSceneAuthority.update(...args);
};

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
