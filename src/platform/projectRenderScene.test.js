import { describe, expect, test, vi } from 'vitest';

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
  schedule: extras.schedule ?? (() => 1),
  cancel: extras.cancel ?? (() => undefined),
  debounceMs: 0,
});

describe('strict project render-scene contract', () => {
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

  test('a delayed A write may finish A but cannot publish over active B', async () => {
    const delayedPut = deferred();
    const invoke = vi.fn(async (command, args) => {
      if (command === 'project_render_scene_get') return response(args.projectId);
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
    delayedPut.resolve(response(PROJECT_A, 1, values({
      renderSettings: { ...values().renderSettings, frameRate: 60 },
    })));
    await writingA;
    expect(store.getSnapshot()).toMatchObject({
      status: 'ready', projectId: PROJECT_B, scene: { projectId: PROJECT_B, sceneRevision: 0 },
    });
  });

  test('coalesces edits and a flush returns the exact durable revision used by a queue item', async () => {
    let durable = response(PROJECT_A);
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
    expect(flushed).toMatchObject({ projectId: PROJECT_A, sceneRevision: 1, crop: { width: 80 } });
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
      if (command === 'project_render_scene_get') return response(PROJECT_A);
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
});
