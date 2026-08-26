import { useEffect, useSyncExternalStore } from 'react';

import { defaultCustomization } from '../components/subtitleCustomization/defaultCustomization';
import {
  DEFAULT_CROP_SETTINGS,
  DEFAULT_RENDER_SETTINGS,
  consumeLegacyRenderScene,
} from '../components/VideoRenderingSection/renderPreferences';
import {
  PROJECT_SUBTITLE_FONT_ADMISSION,
  inspectProjectSubtitleFontAdmission,
} from '../services/projectSubtitleFontRepair';
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
const FONT_ADMISSION_KEYS = Object.freeze(['status', 'repair', 'resolution']);
const FONT_REPAIR_KEYS = Object.freeze(['from', 'to', 'reason']);
const FONT_SELECTION_KEYS = Object.freeze(['fontFamily', 'fontWeight']);
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
  status: 'inactive', projectId: null, scene: null, error: null, dirty: false, fontRepair: null,
});

const admittedFont = () => Object.freeze({
  status: PROJECT_SUBTITLE_FONT_ADMISSION.ready,
  repair: null,
  resolution: null,
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
  // A project switch must not make a debounced edit evaporate. Detached handoffs may finish while
  // another project is visible, but only a later activation of their own project joins them.
  const detachedHandoffs = new Map();

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

  const failInvalidFontAdmission = (owner, cause) => {
    const error = new ProjectRenderSceneError(
      'projectSubtitleFontAdmissionFailed',
      'The saved subtitle font could not be checked',
      { cause },
    );
    publishFontAdmissionFailure(owner, error);
    return error;
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
    if (active === owner) {
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
          if (active === owner) {
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
          if (active === owner) {
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

  const admitOwner = async (owner) => {
    if (active !== owner || owner.initialized !== true) return null;
    if (owner.admitting !== null) return owner.admitting;

    const admissionWork = (async () => {
      while (active === owner) {
        if (owner.pendingUpdateError !== null) {
          publishFontAdmissionFailure(owner, owner.pendingUpdateError);
          throw owner.pendingUpdateError;
        }
        if (owner.persistenceError !== null) {
          publishFontAdmissionFailure(owner, owner.persistenceError);
          throw owner.persistenceError;
        }
        if (owner.requiredFontRepairMutation !== null
            && owner.persistedMutation < owner.requiredFontRepairMutation) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontRepairNotDurable',
            'The repaired subtitle font was not durably acknowledged',
          );
          owner.persistenceError = error;
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        // Admission failures (an unavailable capability or a failed synchronous inspection) may
        // become answerable on a later native epoch. Persistence failures above may not.
        owner.error = null;
        applyPendingUpdates(owner);
        const inspectedScene = sceneResponse(
          owner.projectId,
          owner.persistedRevision,
          owner.values,
        );
        let admission;
        try {
          admission = inspectFontAdmission(inspectedScene);
        } catch (cause) {
          throw failInvalidFontAdmission(owner, cause);
        }
        const admissionRecord = exactSnapshot(admission, FONT_ADMISSION_KEYS);
        if (admissionRecord === null) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font admission inspector returned an invalid record',
          ));
        }

        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.preparing
            && admissionRecord.repair === null) {
          publishFontAdmission(owner, 'preparing');
          return null;
        }
        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.refused
            && admissionRecord.repair === null) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontUnavailable',
            'The saved subtitle font is unavailable on this computer',
            { fontReason: plainSnapshot(admissionRecord.resolution)?.reason ?? null },
          );
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        if (admissionRecord.status === PROJECT_SUBTITLE_FONT_ADMISSION.ready
            && admissionRecord.repair === null) {
          owner.error = null;
          owner.fontAdmissionStatus = 'ready';
          if (owner.lastFontRepair !== null
              && (owner.values.customization.fontFamily !== owner.lastFontRepair.to.fontFamily
                || owner.values.customization.fontWeight !== owner.lastFontRepair.to.fontWeight)) {
            // A user choice queued behind the repair owns the scene now. Publishing the older
            // receipt would truthfully describe a CAS write but falsely describe what is on screen.
            owner.lastFontRepair = null;
          }
          publishOwner(owner);
          return sceneResponse(owner.projectId, owner.persistedRevision, owner.values);
        }
        if (admissionRecord.status !== PROJECT_SUBTITLE_FONT_ADMISSION.repairing) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font admission inspector returned an invalid state',
          ));
        }

        const repair = exactSnapshot(admissionRecord.repair, FONT_REPAIR_KEYS);
        const repairFrom = exactSnapshot(repair?.from, FONT_SELECTION_KEYS);
        const repairTo = exactSnapshot(repair?.to, FONT_SELECTION_KEYS);
        const customization = owner.values.customization;
        if (repair === null || repairFrom === null || repairTo === null
            || typeof repair.reason !== 'string' || repair.reason.length === 0
            || customization.fontFamily !== repairFrom.fontFamily
            || customization.fontWeight !== repairFrom.fontWeight) {
          throw failInvalidFontAdmission(owner, new TypeError(
            'The subtitle-font repair does not own the inspected selection',
          ));
        }
        // Publish the barrier before changing the local scene. Subscribers can therefore observe
        // either the old admitted scene or no scene, never a repaired-but-not-durable intermediate.
        cancelTimer(owner);
        publishFontAdmission(owner, 'repairing');
        try {
          owner.values = normalizeProjectRenderSceneValues({
            ...owner.values,
            customization: {
              ...customization,
              fontFamily: repairTo.fontFamily,
              fontWeight: repairTo.fontWeight,
              preset: 'custom',
            },
          });
        } catch (cause) {
          throw failInvalidFontAdmission(owner, cause);
        }
        owner.mutation += 1;
        const repairMutation = owner.mutation;
        owner.requiredFontRepairMutation = repairMutation;
        try {
          await persistOwner(owner, { publish: false });
        } catch (cause) {
          const error = owner.error ?? new ProjectRenderSceneError(
            'projectSubtitleFontRepairWriteFailed',
            'The repaired subtitle font could not be saved',
            { cause },
          );
          owner.persistenceError = error;
          if (active === owner) {
            publishFontAdmissionFailure(owner, error);
          }
          throw error;
        }
        if (active !== owner) return null;
        if (owner.persistedMutation < repairMutation) {
          const error = new ProjectRenderSceneError(
            'projectSubtitleFontRepairNotDurable',
            'The repaired subtitle font was not durably acknowledged',
          );
          owner.persistenceError = error;
          publishFontAdmissionFailure(owner, error);
          throw error;
        }
        owner.requiredFontRepairMutation = null;
        owner.lastFontRepair = Object.freeze({
          ...repair,
          sceneRevision: owner.persistedRevision,
        });
        // Re-inspect the exact persisted values. This closes capability changes and any update that
        // queued while the CAS write was in flight without inventing a second font authority.
      }
      return null;
    })();
    owner.admitting = admissionWork;
    try {
      return await admissionWork;
    } finally {
      if (owner.admitting === admissionWork) owner.admitting = null;
    }
  };

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
