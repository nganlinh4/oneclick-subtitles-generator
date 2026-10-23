// Project render-scene font repair: failed, malformed and interleaved repairs and queued updates.
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createProjectRenderSceneAuthority } from './projectRenderScene';
import {
  PROJECT_A,
  PROJECT_B,
  authority,
  deadFontRepair,
  deferred,
  inspectDeadFont,
  project,
  response,
  values,
} from './projectRenderSceneTestFixtures';

afterEach(() => {
  delete globalThis.__OSG_FONT_READINESS__;
});

describe('project render-scene font repair', () => {
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
});
