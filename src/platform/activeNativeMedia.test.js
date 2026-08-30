import {
  ActiveNativeMediaError,
  createActiveMediaIdentityEpoch,
  createActiveNativeMediaResolver,
  resolveActiveNativeMediaAssetId,
} from './activeNativeMedia';
import { isDesktopRuntime } from './desktopRuntime';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000001';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000002';
const ASSET_A = '01890f39-7b62-7c4e-8c9a-000000000101';
const ASSET_B = '01890f39-7b62-7c4e-8c9a-000000000102';
const PLAYBACK_A = '550e8400-e29b-41d4-a716-446655440001';
const PLAYBACK_B = '550e8400-e29b-41d4-a716-446655440002';
const TOKEN = 'a'.repeat(64);

const asset = (id, name = 'clip.mp4') => Object.freeze({
  id,
  displayName: name,
  extension: 'mp4',
  sizeBytes: 4096,
  kind: 'video',
});
const descriptor = (assetId, playbackId, name = 'clip.mp4') => Object.freeze({
  __nativeMedia: true,
  assetId,
  playbackId,
  name,
  type: 'video/mp4',
  size: 4096,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${TOKEN}`,
});
const project = (projectId, stateVersion, mediaAsset) => Object.freeze({
  metadata: Object.freeze({ id: projectId, name: 'Project' }),
  stateVersion,
  media: Object.freeze([mediaAsset]),
  tracks: Object.freeze([]),
});

const createHarness = () => {
  const state = {
    active: project(PROJECT_A, 7, asset(ASSET_A)),
    session: Object.freeze({ assetId: ASSET_A, cacheId: 'alias-a', projectId: PROJECT_A }),
    playback: descriptor(ASSET_A, PLAYBACK_A),
    owner: null,
    epoch: 1,
  };
  state.owner = Object.freeze({
    cacheId: 'alias-a',
    projectId: PROJECT_A,
    snapshot: state.active,
  });
  const dependencies = {
    isDesktop: vi.fn(() => true),
    getActiveSnapshot: vi.fn(() => state.active),
    readSession: vi.fn(() => state.session),
    resolveOwner: vi.fn(async () => state.owner),
    getPlayback: vi.fn(async () => state.playback),
    restorePlayback: vi.fn(async () => state.playback),
    readActivationEpoch: vi.fn(() => state.epoch),
  };
  return { state, dependencies, resolver: createActiveNativeMediaResolver(dependencies) };
};

beforeEach(() => {
  isDesktopRuntime.mockReturnValue(true);
});

it('advances its activation epoch only when the active project or media identity changes', () => {
  const epoch = createActiveMediaIdentityEpoch();
  const mediaA = asset(ASSET_A);

  expect(epoch.read()).toBe(0);
  expect(epoch.publish(project(PROJECT_A, 7, mediaA))).toBe(1);
  expect(epoch.publish(project(PROJECT_A, 8, mediaA))).toBe(1);
  expect(epoch.publish(project(PROJECT_A, 8, mediaA))).toBe(1);

  expect(epoch.publish(project(PROJECT_B, 1, asset(ASSET_B)))).toBe(2);
  expect(epoch.publish(project(PROJECT_A, 8, mediaA))).toBe(3);
  expect(epoch.publish(project(PROJECT_A, 9, asset(ASSET_B)))).toBe(4);
  expect(epoch.publish(null)).toBe(5);
  expect(epoch.publish(null)).toBe(5);
});

it('returns a frozen capability only when project, alias owner, and native playback agree', async () => {
  const { resolver } = createHarness();
  const result = await resolver.resolve();
  expect(result).toEqual({
    projectId: PROJECT_A,
    stateVersion: 7,
    cacheId: 'alias-a',
    assetId: ASSET_A,
    media: descriptor(ASSET_A, PLAYBACK_A),
  });
  expect(Object.isFrozen(result)).toBe(true);
});

it('refuses an A to B switch while the native playback read is in flight', async () => {
  const { state, dependencies, resolver } = createHarness();
  dependencies.getPlayback.mockImplementationOnce(async () => {
    state.active = project(PROJECT_B, 1, asset(ASSET_B, 'other.mp4'));
    state.session = Object.freeze({ assetId: ASSET_B, cacheId: 'alias-b', projectId: PROJECT_B });
    state.epoch += 1;
    return state.playback;
  });

  await expect(resolver.resolve()).rejects.toMatchObject({
    name: 'ActiveNativeMediaError',
    code: 'activeNativeMediaChanged',
  });
});

it('refuses an A to B to A activation even when every visible identifier returns to its old value', async () => {
  const { state, dependencies, resolver } = createHarness();
  dependencies.getPlayback.mockImplementationOnce(async () => {
    // The snapshots and session are byte-for-byte A again by the time the call resolves. Only the
    // monotonic publication epoch can distinguish this ABA replacement from an uninterrupted A.
    state.epoch += 2;
    return state.playback;
  });
  await expect(resolver.resolve()).rejects.toMatchObject({
    code: 'activeNativeMediaChanged',
  });
});

it('converges when its own project publication lands while resolution is in flight', async () => {
  const { state, dependencies, resolver } = createHarness();
  // A cue write commits durable revision 8 while the local snapshot still says 7 — the exact race
  // that made a successful transcription toast "media changed". The local publication (and its
  // epoch bump) lands before the bounded re-capture, which must then succeed on the new revision.
  dependencies.resolveOwner.mockImplementationOnce(async () => {
    const advanced = project(PROJECT_A, 8, asset(ASSET_A));
    setTimeout(() => {
      state.active = advanced;
      state.owner = Object.freeze({ cacheId: 'alias-a', projectId: PROJECT_A, snapshot: advanced });
      state.epoch += 1;
    }, 0);
    return Object.freeze({ cacheId: 'alias-a', projectId: PROJECT_A, snapshot: advanced });
  });
  const result = await resolver.resolve();
  expect(result.stateVersion).toBe(8);
});

it('still refuses a mid-flight revision regression such as an undo', async () => {
  const { state, dependencies, resolver } = createHarness();
  dependencies.getPlayback.mockImplementationOnce(async () => {
    const regressed = project(PROJECT_A, 6, asset(ASSET_A));
    state.active = regressed;
    state.owner = Object.freeze({ cacheId: 'alias-a', projectId: PROJECT_A, snapshot: regressed });
    state.epoch += 1;
    return state.playback;
  });
  await expect(resolver.resolve()).rejects.toMatchObject({
    code: 'activeNativeMediaChanged',
  });
});

it('refuses an alias remap that wins after native playback resolution', async () => {
  const { state, dependencies, resolver } = createHarness();
  dependencies.resolveOwner
    .mockResolvedValueOnce(state.owner)
    .mockResolvedValueOnce(Object.freeze({
      cacheId: 'alias-a',
      projectId: PROJECT_B,
      snapshot: project(PROJECT_B, 1, asset(ASSET_B, 'other.mp4')),
    }));

  await expect(resolver.resolve()).rejects.toMatchObject({
    name: 'ActiveNativeMediaError',
    code: 'activeNativeMediaChanged',
  });
});

it('restores relaunch playback only from media owned by the exact native project', async () => {
  const { state, dependencies, resolver } = createHarness();
  dependencies.getPlayback.mockResolvedValueOnce(null);
  const result = await resolver.resolve({ restore: true });
  expect(dependencies.restorePlayback).toHaveBeenCalledWith(ASSET_A);
  expect(result.assetId).toBe(ASSET_A);

  state.owner = null;
  dependencies.getPlayback.mockResolvedValueOnce(null);
  await expect(resolver.resolve({ restore: true })).rejects.toBeInstanceOf(ActiveNativeMediaError);
});

it('rejects a stale URL or descriptor even when another native media is active', async () => {
  const { resolver } = createHarness();
  await expect(resolver.resolve({ candidate: descriptor(ASSET_B, PLAYBACK_B, 'other.mp4') }))
    .rejects.toMatchObject({ code: 'activeNativeMediaUnavailable' });
  await expect(resolver.resolve({ candidate: 'blob:https://example.test/stale' }))
    .rejects.toMatchObject({ code: 'activeNativeMediaUnavailable' });
});

it('revalidates a capability against a fresh project, alias, and playback read', async () => {
  const { state, resolver } = createHarness();
  const capability = await resolver.resolve();
  await expect(resolver.revalidate(capability)).resolves.toEqual(capability);
  state.active = project(PROJECT_A, 8, asset(ASSET_A));
  await expect(resolver.revalidate(capability)).rejects.toMatchObject({
    code: 'activeNativeMediaChanged',
  });
});

it('refreshes the same media capability after its own durable project revision advances', async () => {
  const { state, resolver } = createHarness();
  const capability = await resolver.resolve();
  state.active = project(PROJECT_A, 8, asset(ASSET_A));
  state.owner = Object.freeze({ cacheId: 'alias-a', projectId: PROJECT_A, snapshot: state.active });
  const refreshed = await resolver.refresh(capability);
  expect(refreshed.stateVersion).toBe(8);

  state.active = project(PROJECT_A, 6, asset(ASSET_A));
  state.owner = Object.freeze({ cacheId: 'alias-a', projectId: PROJECT_A, snapshot: state.active });
  await expect(resolver.refresh(capability)).rejects.toMatchObject({
    code: 'activeNativeMediaChanged',
  });
});

it('never upgrades a bare URL or anything outside the desktop runtime', () => {
  const media = descriptor(ASSET_A, PLAYBACK_A);
  expect(resolveActiveNativeMediaAssetId(media.playbackUrl)).toBeNull();
  expect(resolveActiveNativeMediaAssetId(media)).toBe(ASSET_A);
  isDesktopRuntime.mockReturnValue(false);
  expect(resolveActiveNativeMediaAssetId(media)).toBeNull();
});
