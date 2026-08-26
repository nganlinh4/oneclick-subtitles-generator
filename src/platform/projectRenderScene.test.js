import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FONT_READINESS_EVENT,
  FONT_READINESS_SCHEMA,
  FONT_READINESS_STATE,
  fontCapabilitySnapshot,
  subscribeToFontReadiness,
} from '../services/fontCapability';
import { inspectProjectSubtitleFontAdmission } from '../services/projectSubtitleFontRepair';

import {
  createProjectRenderSceneAuthority,
  defaultProjectRenderSceneValues,
  normalizeProjectRenderScene,
  normalizeProjectRenderSceneValues,
} from './projectRenderScene';

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000001';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000002';

const project = (id) => ({ metadata: { id } });
const values = (overrides = {}) => ({
  ...defaultProjectRenderSceneValues(),
  ...overrides,
});
const response = (projectId, sceneRevision = 0, scene = values()) => ({
  schemaVersion: 1,
  projectId,
  sceneRevision,
  ...scene,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const authority = (invoke, extras = {}) => createProjectRenderSceneAuthority({
  invoke,
  subscribeProject: () => () => undefined,
  getProject: () => null,
  consumeLegacy: () => null,
  ...(extras.inspectFontAdmission ? { inspectFontAdmission: extras.inspectFontAdmission } : {}),
  ...(extras.subscribeFontCapability
    ? { subscribeFontCapability: extras.subscribeFontCapability }
    : {}),
  schedule: extras.schedule ?? (() => 1),
  cancel: extras.cancel ?? (() => undefined),
  debounceMs: 0,
});

const deadFontRepair = Object.freeze({
  from: Object.freeze({ fontFamily: "'Dead Face', fantasy", fontWeight: 800 }),
  to: Object.freeze({ fontFamily: "'Google Sans', sans-serif", fontWeight: 400 }),
  reason: 'managedDefault',
});
const inspectDeadFont = (scene) => (
  scene.customization.fontFamily === deadFontRepair.from.fontFamily
    ? { status: 'repairing', repair: deadFontRepair, resolution: { status: 'unavailable' } }
    : { status: 'ready', repair: null, resolution: { status: 'exact' } }
);

const fontRecord = (state, extra = {}) => ({
  schema: FONT_READINESS_SCHEMA,
  epoch: 1,
  state,
  family: 'Google Sans',
  version: state === FONT_READINESS_STATE.ready ? 'v22-ui4' : null,
  reason: null,
  retryable: false,
  ...extra,
});

afterEach(() => {
  delete globalThis.__OSG_FONT_READINESS__;
});

describe('strict project render-scene contract', () => {
  test('never publishes or flushes a loaded dead face before its repair is durable', async () => {
    const repairWrite = deferred();
    const deadValues = values({
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A, 7, deadValues);
      expect(args).toMatchObject({
        expectedSceneRevision: 7,
        scene: {
          customization: {
            fontFamily: deadFontRepair.to.fontFamily,
            fontWeight: deadFontRepair.to.fontWeight,
          },
        },
      });
      return repairWrite.promise;
    });
    const store = authority(invoke, { inspectFontAdmission: inspectDeadFont });
    const readyFonts = [];
    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === 'ready') readyFonts.push(snapshot.scene.customization.fontFamily);
    });

    const activation = store.activate(project(PROJECT_A));
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'repairing', projectId: PROJECT_A, scene: null, error: null,
    }));
    const exportBarrier = store.flush();
    let exportSettled = false;
    void exportBarrier.finally(() => { exportSettled = true; });
    await Promise.resolve();
    expect(exportSettled).toBe(false);
    expect(readyFonts).toEqual([]);

    repairWrite.resolve(response(PROJECT_A, 8, {
      ...deadValues,
      customization: {
        ...deadValues.customization,
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
        preset: 'custom',
      },
    }));
    await activation;
    await expect(exportBarrier).resolves.toMatchObject({
      sceneRevision: 8,
      customization: {
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
      },
    });
    expect(readyFonts).toEqual([deadFontRepair.to.fontFamily]);
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false,
      fontRepair: { ...deadFontRepair, sceneRevision: 8 },
    });
  });

  test('a readiness publication resumes a prepared scene through repair to durable admission', async () => {
    let fontListener = null;
    let readiness = 'preparing';
    const deadValues = values({
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A, 7, deadValues);
      return response(PROJECT_A, 8, args.scene);
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: (candidate) => readiness === 'preparing'
        ? { status: 'preparing', repair: null, resolution: null }
        : inspectDeadFont(candidate),
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });

    store.start();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'preparing', projectId: PROJECT_A, scene: null,
    }));
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['project_render_scene_get']);

    readiness = 'settled';
    fontListener();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false,
      scene: {
        sceneRevision: 8,
        customization: { fontFamily: deadFontRepair.to.fontFamily, fontWeight: 400 },
      },
    }));
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'project_render_scene_get',
      'project_render_scene_put',
    ]);
    store.stop();
    expect(fontListener).toBeNull();
  });

  test('a present incompatible font contract terminates project admission instead of waiting', async () => {
    globalThis.__OSG_FONT_READINESS__ = fontRecord(FONT_READINESS_STATE.ready, {
      schema: FONT_READINESS_SCHEMA + 1,
    });
    const invoke = vi.fn(async (_command, args) => response(args.projectId, 4));
    const store = authority(invoke, {
      inspectFontAdmission: (scene) => inspectProjectSubtitleFontAdmission({
        fontFamily: scene.customization.fontFamily,
        fontWeight: scene.customization.fontWeight,
        capability: fontCapabilitySnapshot(globalThis),
        platform: 'windows',
        isSystemFaceInstalled: () => false,
      }),
    });

    await expect(store.activate(project(PROJECT_A))).rejects.toMatchObject({
      code: 'projectSubtitleFontUnavailable',
    });
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed', projectId: PROJECT_A, scene: null,
      error: {
        code: 'projectSubtitleFontUnavailable',
        fontReason: 'contract-mismatch',
      },
    });
    await expect(store.flush()).rejects.toMatchObject({ code: 'projectSubtitleFontUnavailable' });
  });

  test('stale and duplicate native epochs cannot withdraw an admitted project scene', async () => {
    globalThis.__OSG_FONT_READINESS__ = fontRecord(FONT_READINESS_STATE.ready, { epoch: 5 });
    const invoke = vi.fn(async (_command, args) => response(args.projectId, 4));
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: () => fontCapabilitySnapshot(globalThis).managedPackInstalled
        ? { status: 'ready', repair: null, resolution: { status: 'exact' } }
        : { status: 'preparing', repair: null, resolution: null },
      subscribeFontCapability: (listener) => subscribeToFontReadiness(listener, {
        globalScope: globalThis,
      }),
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_A, scene: { sceneRevision: 4 },
    }));

    for (const detail of [
      fontRecord(FONT_READINESS_STATE.repairing, { epoch: 4 }),
      fontRecord(FONT_READINESS_STATE.ready, { epoch: 5 }),
    ]) {
      globalThis.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, { detail }));
    }
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_A, scene: { sceneRevision: 4 },
    });
    expect(fontCapabilitySnapshot(globalThis)).toMatchObject({ epoch: 5, managedPackInstalled: true });
    store.stop();
  });

  test('publishes an exact face directly without a preparing or repair state', async () => {
    const statuses = [];
    const invoke = vi.fn(async (command, args) => {
      expect(command).toBe('project_render_scene_get');
      return response(args.projectId, 4);
    });
    const store = authority(invoke, { inspectFontAdmission: inspectDeadFont });
    store.subscribe(() => statuses.push(store.getSnapshot().status));

    await store.activate(project(PROJECT_A));

    expect(statuses).toEqual(['loading', 'ready']);
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', dirty: false, fontRepair: null });
    expect(invoke).toHaveBeenCalledOnce();
  });

  test('a shutdown checkpoint persists queued state without waiting forever for readiness', async () => {
    let durable = response(PROJECT_A, 1);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return durable;
      durable = response(PROJECT_A, durable.sceneRevision + 1, args.scene);
      return durable;
    });
    const store = authority(invoke, {
      inspectFontAdmission: () => ({ status: 'preparing', repair: null, resolution: null }),
    });
    await store.activate(project(PROJECT_A));
    expect(store.getSnapshot()).toMatchObject({ status: 'preparing', scene: null });
    expect(store.update((current) => ({
      ...current,
      crop: { ...current.crop, width: 73 },
    }))).toBeNull();

    await expect(store.checkpoint()).resolves.toMatchObject({
      sceneRevision: 2,
      crop: { width: 73 },
    });
    expect(store.getSnapshot()).toMatchObject({
      status: 'preparing', scene: null, error: null, dirty: false,
    });
  });

  test('an invalid live font update closes admission synchronously before its repair write', async () => {
    const repairWrite = deferred();
    const readyFonts = [];
    const invoke = vi.fn(async (command, _args) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A, 4);
      return repairWrite.promise;
    });
    const store = authority(invoke, { inspectFontAdmission: inspectDeadFont });
    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === 'ready') readyFonts.push(snapshot.scene.customization.fontFamily);
    });
    await store.activate(project(PROJECT_A));

    store.update((current) => ({
      ...current,
      customization: {
        ...current.customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    }));
    expect(store.getSnapshot()).toMatchObject({ status: 'repairing', scene: null, error: null });
    expect(readyFonts).toEqual([values().customization.fontFamily]);

    repairWrite.resolve(response(PROJECT_A, 5, {
      ...values(),
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
        preset: 'custom',
      },
    }));
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false,
      scene: { sceneRevision: 5, customization: { fontFamily: deadFontRepair.to.fontFamily } },
    }));
    expect(readyFonts).toEqual([
      values().customization.fontFamily,
      deadFontRepair.to.fontFamily,
    ]);
  });

  test('a rejected repair write stays failed across capability events and every barrier refuses', async () => {
    let fontListener = null;
    let repairPuts = 0;
    const writeCause = new Error('repair disk full');
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId, 4);
      repairPuts += 1;
      throw writeCause;
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: inspectDeadFont,
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    const readyScenes = [];
    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === 'ready') readyScenes.push(snapshot.scene);
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'));

    store.update((current) => ({
      ...current,
      customization: {
        ...current.customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    }));
    expect(store.getSnapshot()).toMatchObject({ status: 'repairing', scene: null, error: null });
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'failed',
      scene: null,
      dirty: true,
      fontRepair: null,
      error: { code: 'projectRenderSceneWriteFailed', cause: writeCause },
    }));
    const failure = store.getSnapshot().error;
    expect(readyScenes).toHaveLength(1);
    expect(readyScenes[0].customization.fontFamily).not.toBe(deadFontRepair.from.fontFamily);
    expect(repairPuts).toBe(1);

    // Native may publish another capability epoch after the failed CAS. The repaired local values
    // now inspect as exact, but they remain inadmissible because their mutation has no durable ack.
    fontListener();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed', scene: null, error: failure, fontRepair: null,
    });
    expect(readyScenes).toHaveLength(1);

    await expect(store.flush()).rejects.toBe(failure);
    await expect(store.checkpoint()).rejects.toBe(failure);
    expect(repairPuts).toBe(1);
    store.stop();
    expect(fontListener).toBeNull();
  });

  test('a later capability epoch may recover an admission refusal but never a persistence failure', async () => {
    let fontListener = null;
    let capabilityReady = false;
    const invoke = vi.fn(async (command, args) => {
      expect(command).toBe('project_render_scene_get');
      return response(args.projectId, 4);
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: () => capabilityReady
        ? { status: 'ready', repair: null, resolution: { status: 'exact' } }
        : { status: 'refused', repair: null, resolution: { reason: 'managed-pack-unavailable' } },
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'failed', scene: null, error: { code: 'projectSubtitleFontUnavailable' },
    }));

    capabilityReady = true;
    fontListener();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', error: null, scene: { sceneRevision: 4 },
    }));
    expect(invoke).toHaveBeenCalledOnce();
    store.stop();
  });

  test('a throwing queued update fails a preparing owner once and every barrier is bounded', async () => {
    let fontListener = null;
    let ready = false;
    const cause = new Error('hostile queued updater');
    const invoke = vi.fn(async (_command, args) => response(args.projectId, 4));
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: () => ready
        ? { status: 'ready', repair: null, resolution: { status: 'exact' } }
        : { status: 'preparing', repair: null, resolution: null },
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('preparing'));
    store.update(() => { throw cause; });

    ready = true;
    fontListener();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'failed', scene: null,
      error: { code: 'projectRenderSceneQueuedUpdateFailed', cause },
    }));
    const failure = store.getSnapshot().error;
    fontListener();
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ status: 'failed', scene: null, error: failure });
    await expect(store.flush()).rejects.toBe(failure);
    await expect(store.checkpoint()).rejects.toBe(failure);
    expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put'))
      .toHaveLength(0);

    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { projectId: PROJECT_B },
    });
    store.stop();
  });

  test('a valid update queued while preparing is durably scheduled when readiness opens', async () => {
    let fontListener = null;
    let ready = false;
    const scheduled = [];
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId, 4);
      return response(args.projectId, args.expectedSceneRevision + 1, args.scene);
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: () => ready
        ? { status: 'ready', repair: null, resolution: { status: 'exact' } }
        : { status: 'preparing', repair: null, resolution: null },
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('preparing'));

    expect(store.update((current) => ({
      ...current,
      crop: { ...current.crop, width: 73 },
    }))).toBeNull();
    ready = true;
    fontListener();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: true, scene: { crop: { width: 73 } },
    }));
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));

    scheduled.shift()();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false, scene: { sceneRevision: 5, crop: { width: 73 } },
    }));
    expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put'))
      .toHaveLength(1);
    store.stop();
  });

  test('a malformed repair result fails once instead of looping or stranding flush', async () => {
    let fontListener = null;
    let admission = { status: 'preparing', repair: null, resolution: null };
    const invoke = vi.fn(async (_command, args) => response(args.projectId, 4));
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: () => admission,
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('preparing'));
    admission = {
      status: 'repairing',
      repair: {
        from: { fontFamily: "'Another Face', sans-serif", fontWeight: 400 },
        to: { fontFamily: "'Arial', sans-serif", fontWeight: 400 },
        reason: 'hostileMismatch',
      },
      resolution: { status: 'unavailable' },
    };

    fontListener();
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'failed', scene: null,
      error: { code: 'projectSubtitleFontAdmissionFailed' },
    }));
    const failure = store.getSnapshot().error;
    await expect(store.flush()).rejects.toBe(failure);
    await expect(store.checkpoint()).rejects.toBe(failure);
    expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put'))
      .toHaveLength(0);
    store.stop();
  });

  test('an invalid update queued during repair cannot hang or be cleared by readiness', async () => {
    let fontListener = null;
    const repairWrite = deferred();
    const deadValues = values({
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId, 7, deadValues);
      return repairWrite.promise;
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => project(PROJECT_A),
      consumeLegacy: () => null,
      inspectFontAdmission: inspectDeadFont,
      subscribeFontCapability: (listener) => {
        fontListener = listener;
        return () => { fontListener = null; };
      },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    store.start();
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('repairing'));
    store.update({ invalid: 'not a scene' });
    repairWrite.resolve(response(PROJECT_A, 8, {
      ...deadValues,
      customization: {
        ...deadValues.customization,
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
        preset: 'custom',
      },
    }));
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'failed', scene: null,
      error: { code: 'projectRenderSceneQueuedUpdateFailed' },
    }));
    const failure = store.getSnapshot().error;
    fontListener();
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ status: 'failed', scene: null, error: failure });
    await expect(store.flush()).rejects.toBe(failure);
    await expect(store.checkpoint()).rejects.toBe(failure);
    store.stop();
  });

  test('a newer exact user choice queued during repair wins without deadlocking admission', async () => {
    const repairWrite = deferred();
    let durable = null;
    const deadValues = values({
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A, 7, deadValues);
      if (durable === null) return repairWrite.promise;
      durable = response(PROJECT_A, durable.sceneRevision + 1, args.scene);
      return durable;
    });
    const store = authority(invoke, { inspectFontAdmission: inspectDeadFont });
    const activation = store.activate(project(PROJECT_A));
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('repairing'));

    expect(store.update((current) => ({
      ...current,
      customization: {
        ...current.customization,
        fontFamily: "'Arial', sans-serif",
        fontWeight: 400,
      },
    }))).toBeNull();
    durable = response(PROJECT_A, 8, {
      ...deadValues,
      customization: {
        ...deadValues.customization,
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
        preset: 'custom',
      },
    });
    repairWrite.resolve(durable);
    await activation;

    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: true,
      scene: { customization: { fontFamily: "'Arial', sans-serif", fontWeight: 400 } },
      fontRepair: null,
    });
    await expect(store.flush()).resolves.toMatchObject({
      sceneRevision: 9,
      customization: { fontFamily: "'Arial', sans-serif", fontWeight: 400 },
    });
  });

  test('a detached project repair cannot publish over the newly active exact project', async () => {
    const repairWrite = deferred();
    const deadValues = values({
      customization: {
        ...values().customization,
        fontFamily: deadFontRepair.from.fontFamily,
        fontWeight: deadFontRepair.from.fontWeight,
      },
    });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') {
        return args.projectId === PROJECT_A
          ? response(PROJECT_A, 7, deadValues)
          : response(PROJECT_B, 3);
      }
      expect(args.projectId).toBe(PROJECT_A);
      return repairWrite.promise;
    });
    const store = authority(invoke, { inspectFontAdmission: inspectDeadFont });
    const readyProjects = [];
    store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (snapshot.status === 'ready') readyProjects.push(snapshot.projectId);
    });

    const activationA = store.activate(project(PROJECT_A));
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('repairing'));
    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { projectId: PROJECT_B, sceneRevision: 3 },
    });

    repairWrite.resolve(response(PROJECT_A, 8, {
      ...deadValues,
      customization: {
        ...deadValues.customization,
        fontFamily: deadFontRepair.to.fontFamily,
        fontWeight: deadFontRepair.to.fontWeight,
        preset: 'custom',
      },
    }));
    await activationA;
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', projectId: PROJECT_B });
    expect(readyProjects).toEqual([PROJECT_B]);
  });

  test('accepts only the exact schema and renderer-owned bounded values', () => {
    const scene = response(PROJECT_A);
    expect(normalizeProjectRenderScene(scene)).toEqual(scene);

    expect(() => normalizeProjectRenderScene({ ...scene, unknown: true })).toThrow();
    expect(() => normalizeProjectRenderScene({ ...scene, schemaVersion: 2 })).toThrow();
    expect(() => normalizeProjectRenderSceneValues({
      ...values(),
      renderSettings: { ...values().renderSettings, trimStart: 5, trimEnd: 4 },
    })).toThrow();
    expect(() => normalizeProjectRenderSceneValues({
      ...values(),
      customization: { ...values().customization, fontSize: Number.NaN },
    })).toThrow();
    expect(() => normalizeProjectRenderSceneValues({
      ...values(),
      crop: { ...values().crop, surprise: 1 },
    })).toThrow();
  });

  test('materializes Rust virtual defaults before publishing a new project as ready', async () => {
    const rustDefault = values({ selectedSubtitles: 'translated' });
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId, 0, rustDefault);
      expect(command).toBe('project_render_scene_put');
      expect(args).toMatchObject({
        projectId: PROJECT_A,
        expectedSceneRevision: 0,
        scene: { schemaVersion: 1, selectedSubtitles: 'translated' },
      });
      return response(PROJECT_A, 1, args.scene);
    });
    const store = authority(invoke);

    const activation = store.activate(project(PROJECT_A));
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', scene: null });
    await activation;

    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false,
      scene: { projectId: PROJECT_A, sceneRevision: 1, selectedSubtitles: 'translated' },
    });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'project_render_scene_get',
      'project_render_scene_put',
    ]);
  });

  test('adopts an equivalent concurrent bootstrap winner without replay or visible failure', async () => {
    let reads = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') {
        reads += 1;
        return response(args.projectId, reads === 1 ? 0 : 1);
      }
      const error = new Error('another process created the same default');
      error.code = 'staleProjectRenderScene';
      throw error;
    });
    const store = authority(invoke);

    await expect(store.activate(project(PROJECT_A))).resolves.toMatchObject({ sceneRevision: 1 });
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false, error: null,
      scene: { projectId: PROJECT_A, sceneRevision: 1 },
    });
    expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put'))
      .toHaveLength(1);
  });

  test('queues an edit during bootstrap and flushes its exact subsequent revision', async () => {
    const firstPut = deferred();
    let puts = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId);
      puts += 1;
      if (puts === 1) return firstPut.promise;
      return response(args.projectId, 2, args.scene);
    });
    const store = authority(invoke);

    const activation = store.activate(project(PROJECT_A));
    await vi.waitFor(() => {
      expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put'))
        .toHaveLength(1);
    });
    expect(store.update((scene) => ({
      ...scene,
      crop: { ...scene.crop, width: 73 },
    }))).toBeNull();

    firstPut.resolve(response(PROJECT_A, 1));
    await activation;
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: true, scene: { sceneRevision: 1, crop: { width: 73 } },
    });

    const flushed = await store.flush();
    expect(flushed).toMatchObject({ sceneRevision: 2, crop: { width: 73 } });
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', dirty: false, scene: flushed });
  });

  test('A loading edit is durably handed off through B before returning to A', async () => {
    const firstARead = deferred();
    const stored = new Map([
      [PROJECT_A, response(PROJECT_A, 4)],
      [PROJECT_B, response(PROJECT_B, 9)],
    ]);
    let aReads = 0;
    let aPuts = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') {
        if (args.projectId === PROJECT_A && aReads++ === 0) return firstARead.promise;
        return stored.get(args.projectId);
      }
      expect(command).toBe('project_render_scene_put');
      expect(args.projectId).toBe(PROJECT_A);
      aPuts += 1;
      const next = response(PROJECT_A, args.expectedSceneRevision + 1, args.scene);
      stored.set(PROJECT_A, next);
      return next;
    });
    const store = authority(invoke);

    const initialA = store.activate(project(PROJECT_A));
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', projectId: PROJECT_A, scene: null });
    expect(store.update((scene) => ({
      ...scene,
      crop: { ...scene.crop, width: 73 },
    }))).toBeNull();

    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { sceneRevision: 9 },
    });
    const returnToA = store.activate(project(PROJECT_A));
    await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', projectId: PROJECT_A, scene: null });
    expect(aPuts).toBe(0);

    firstARead.resolve(stored.get(PROJECT_A));
    await initialA;
    await returnToA;
    expect(aPuts).toBe(1);
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false, projectId: PROJECT_A,
      scene: { sceneRevision: 5, crop: { width: 73 } },
    });
    expect(stored.get(PROJECT_A)).toMatchObject({ sceneRevision: 5, crop: { width: 73 } });
  });

  test('shutdown joins detached A before acknowledging the active B checkpoint', async () => {
    const releaseAWrite = deferred();
    const stored = new Map([
      [PROJECT_A, response(PROJECT_A, 1)],
      [PROJECT_B, response(PROJECT_B, 6)],
    ]);
    const writes = [];
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return stored.get(args.projectId);
      writes.push(args.projectId);
      if (args.projectId === PROJECT_A) await releaseAWrite.promise;
      const next = response(args.projectId, args.expectedSceneRevision + 1, args.scene);
      stored.set(args.projectId, next);
      return next;
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({
      ...scene,
      customization: { ...scene.customization, fontSize: 123 },
    }));
    await store.activate(project(PROJECT_B));
    store.update((scene) => ({
      ...scene,
      crop: { ...scene.crop, width: 73 },
    }));

    const closing = store.checkpoint();
    let settled = false;
    void closing.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(writes).toEqual([PROJECT_A]);

    releaseAWrite.resolve();
    await expect(closing).resolves.toMatchObject({
      projectId: PROJECT_B, sceneRevision: 7, crop: { width: 73 },
    });
    expect(writes).toEqual([PROJECT_A, PROJECT_B]);
    expect(stored.get(PROJECT_A)).toMatchObject({
      sceneRevision: 2, customization: { fontSize: 123 },
    });
  });

  test('switching during revision-zero materialization keeps that native write in the close barrier', async () => {
    const releaseBootstrap = deferred();
    const bootstrapStarted = deferred();
    const stored = new Map([[PROJECT_B, response(PROJECT_B, 6)]]);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') {
        return args.projectId === PROJECT_A
          ? response(PROJECT_A, 0)
          : stored.get(PROJECT_B);
      }
      if (args.projectId === PROJECT_A) {
        bootstrapStarted.resolve();
        await releaseBootstrap.promise;
      }
      const next = response(args.projectId, args.expectedSceneRevision + 1, args.scene);
      stored.set(args.projectId, next);
      return next;
    });
    const store = authority(invoke);
    const initialA = store.activate(project(PROJECT_A));
    await bootstrapStarted.promise;

    await store.activate(project(PROJECT_B));
    const closing = store.checkpoint();
    let settled = false;
    void closing.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseBootstrap.resolve();
    await initialA;
    await expect(closing).resolves.toMatchObject({ projectId: PROJECT_B, sceneRevision: 6 });
    expect(stored.get(PROJECT_A)).toMatchObject({ projectId: PROJECT_A, sceneRevision: 1 });
  });

  test('A/B/A loads independent durable scenes and never leaves the old scene visible', async () => {
    const stored = new Map([
      [PROJECT_A, response(PROJECT_A, 4, values({ selectedSubtitles: 'translated' }))],
      [PROJECT_B, response(PROJECT_B, 9, values({ selectedNarration: 'generated' }))],
    ]);
    const invoke = vi.fn(async (command, args) => {
      expect(command).toBe('project_render_scene_get');
      return stored.get(args.projectId);
    });
    const store = authority(invoke);

    const firstA = store.activate(project(PROJECT_A));
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', projectId: PROJECT_A, scene: null });
    await firstA;
    expect(store.getSnapshot().scene).toMatchObject({
      projectId: PROJECT_A, sceneRevision: 4, selectedSubtitles: 'translated',
    });

    const b = store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', projectId: PROJECT_B, scene: null });
    await b;
    expect(store.getSnapshot().scene).toMatchObject({
      projectId: PROJECT_B, sceneRevision: 9, selectedNarration: 'generated',
    });

    await store.activate(project(PROJECT_A));
    expect(store.getSnapshot().scene).toMatchObject({
      projectId: PROJECT_A, sceneRevision: 4, selectedSubtitles: 'translated',
    });
  });

  test('A dirty debounce handoff persists during B and returning to A loads the exact revision', async () => {
    const releaseAWrite = deferred();
    const stored = new Map([
      [PROJECT_A, response(PROJECT_A, 1)],
      [PROJECT_B, response(PROJECT_B, 6)],
    ]);
    let aPuts = 0;
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return stored.get(args.projectId);
      expect(command).toBe('project_render_scene_put');
      expect(args.projectId).toBe(PROJECT_A);
      aPuts += 1;
      await releaseAWrite.promise;
      const next = response(PROJECT_A, args.expectedSceneRevision + 1, args.scene);
      stored.set(PROJECT_A, next);
      return next;
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({
      ...scene,
      customization: { ...scene.customization, fontSize: 123 },
    }));
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', dirty: true });
    expect(aPuts).toBe(0);

    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { sceneRevision: 6 },
    });
    expect(aPuts).toBe(1);

    const returnToA = store.activate(project(PROJECT_A));
    expect(store.getSnapshot()).toMatchObject({ status: 'loading', projectId: PROJECT_A, scene: null });
    let returned = false;
    void returnToA.finally(() => { returned = true; });
    await Promise.resolve();
    expect(returned).toBe(false);

    releaseAWrite.resolve();
    await returnToA;
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false, projectId: PROJECT_A,
      scene: { sceneRevision: 2, customization: { fontSize: 123 } },
    });
    expect(aPuts).toBe(1);
  });

  test('a failed detached handoff cannot poison B and is surfaced when A is revisited', async () => {
    const rejectAWrite = deferred();
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') {
        return response(args.projectId, args.projectId === PROJECT_A ? 1 : 6);
      }
      expect(args.projectId).toBe(PROJECT_A);
      return rejectAWrite.promise;
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({
      ...scene,
      customization: { ...scene.customization, fontSize: 123 },
    }));
    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', projectId: PROJECT_B });

    const cause = new Error('A disk disappeared');
    rejectAWrite.reject(cause);
    await vi.waitFor(() => expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B,
    }));

    await expect(store.activate(project(PROJECT_A))).rejects.toMatchObject({
      code: 'projectRenderSceneHandoffFailed', cause,
    });
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed', projectId: PROJECT_A, scene: null,
      error: { code: 'projectRenderSceneHandoffFailed', cause },
    });

    await store.activate(project(PROJECT_B));
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', projectId: PROJECT_B });
  });

  test('a delayed A write may finish A but cannot publish over active B', async () => {
    const delayedPut = deferred();
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId, 1);
      if (args.projectId === PROJECT_A) return delayedPut.promise;
      throw new Error('unexpected B write');
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({
      ...scene,
      renderSettings: { ...scene.renderSettings, frameRate: 60 },
    }));
    const writingA = store.flush();

    await store.activate(project(PROJECT_B));
    delayedPut.resolve(response(PROJECT_A, 2, values({
      renderSettings: { ...values().renderSettings, frameRate: 60 },
    })));
    await writingA;
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { projectId: PROJECT_B, sceneRevision: 1 },
    });
  });

  test('coalesces edits and a flush returns the exact durable revision used by a queue item', async () => {
    let durable = response(PROJECT_A, 1);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return durable;
      expect(args.expectedSceneRevision).toBe(durable.sceneRevision);
      durable = response(PROJECT_A, durable.sceneRevision + 1, args.scene);
      return durable;
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({
      ...scene,
      crop: { ...scene.crop, width: 90 },
    }));
    store.update((scene) => ({
      ...scene,
      crop: { ...scene.crop, width: 80 },
    }));
    const flushed = await store.flush();
    expect(flushed).toMatchObject({ projectId: PROJECT_A, sceneRevision: 2, crop: { width: 80 } });
    expect(invoke.mock.calls.filter(([command]) => command === 'project_render_scene_put')).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({ dirty: false, scene: flushed });
  });

  test('reloads on a CAS conflict instead of replaying stale local state', async () => {
    const authoritative = response(PROJECT_A, 8, values({ selectedSubtitles: 'translated' }));
    let reads = 0;
    const invoke = vi.fn(async (command) => {
      if (command === 'project_render_scene_get') {
        reads += 1;
        return reads === 1 ? response(PROJECT_A, 7) : authoritative;
      }
      const error = new Error('conflict');
      error.code = 'staleProjectRenderScene';
      throw error;
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({ ...scene, selectedNarration: 'generated' }));
    await expect(store.flush()).rejects.toMatchObject({ code: 'staleProjectRenderScene' });
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed', dirty: false,
      scene: { sceneRevision: 8, selectedSubtitles: 'translated', selectedNarration: 'none' },
    });
  });

  test('a failed write is sticky and the render flush barrier refuses', async () => {
    const invoke = vi.fn(async (command) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A, 1);
      throw new Error('disk full');
    });
    const store = authority(invoke);
    await store.activate(project(PROJECT_A));
    store.update((scene) => ({ ...scene, selectedNarration: 'generated' }));
    await expect(store.flush()).rejects.toMatchObject({ code: 'projectRenderSceneWriteFailed' });
    expect(store.getSnapshot()).toMatchObject({ status: 'failed', dirty: true });
    await expect(store.flush()).rejects.toMatchObject({ code: 'projectRenderSceneWriteFailed' });
  });

  test('consumes a bounded first-upgrade scene once and commits it before ready', async () => {
    const legacy = values({ selectedSubtitles: 'translated' });
    const consumeLegacy = vi.fn(() => legacy);
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(PROJECT_A);
      return response(PROJECT_A, 1, args.scene);
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => null,
      consumeLegacy,
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });
    await store.activate(project(PROJECT_A));
    expect(consumeLegacy).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', dirty: false,
      scene: { sceneRevision: 1, selectedSubtitles: 'translated' },
    });
  });

  test('fails activation instead of materializing defaults when legacy consumption is unsafe', async () => {
    const cause = new Error('localStorage deletion blocked');
    const invoke = vi.fn(async (command) => {
      expect(command).toBe('project_render_scene_get');
      return response(PROJECT_A);
    });
    const store = createProjectRenderSceneAuthority({
      invoke,
      subscribeProject: () => () => undefined,
      getProject: () => null,
      consumeLegacy: () => { throw cause; },
      schedule: () => 1,
      cancel: () => undefined,
      debounceMs: 0,
    });

    await expect(store.activate(project(PROJECT_A))).rejects.toBe(cause);
    expect(store.getSnapshot()).toMatchObject({
      status: 'failed', projectId: PROJECT_A, scene: null,
      error: { code: 'projectRenderSceneLoadFailed', cause },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
