// Project render-scene persistence: schema contract, bootstrap, A/B handoffs and CAS writes.
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createProjectRenderSceneAuthority,
  normalizeProjectRenderScene,
  normalizeProjectRenderSceneValues,
} from './projectRenderScene';
import {
  PROJECT_A,
  PROJECT_B,
  authority,
  deferred,
  project,
  response,
  values,
} from './projectRenderSceneTestFixtures';

afterEach(() => {
  delete globalThis.__OSG_FONT_READINESS__;
});

describe('project render-scene persistence', () => {
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
