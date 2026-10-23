// Project render-scene font admission: the barrier between a saved face and preview/export.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FONT_READINESS_EVENT,
  FONT_READINESS_SCHEMA,
  FONT_READINESS_STATE,
  fontCapabilitySnapshot,
  subscribeToFontReadiness,
} from '../services/fontCapability';
import { inspectProjectSubtitleFontAdmission } from '../services/projectSubtitleFontRepair';

import { createProjectRenderSceneAuthority } from './projectRenderScene';
import {
  PROJECT_A,
  authority,
  deadFontRepair,
  deferred,
  fontRecord,
  inspectDeadFont,
  project,
  response,
  values,
} from './projectRenderSceneTestFixtures';

afterEach(() => {
  delete globalThis.__OSG_FONT_READINESS__;
});

describe('project render-scene font admission', () => {
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
});
