import {
  applyNativeMediaSession,
  createNativeMediaSessionHydrator,
} from './useNativeMediaSessionHydration';
import { createNativeMediaDescriptor } from '../platform/mediaService';
import {
  clearBrowserMediaBlobs,
  getBrowserMediaBlob,
  registerBrowserMediaBlob,
} from '../platform/browserMediaBlobRegistry';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const ASSET_A = '018f47a2-7c20-7f70-8000-000000000001';
const ASSET_B = '018f47a2-7c20-7f70-8000-000000000002';
const PROJECT_A = '018f47a2-7c20-7f70-8000-0000000000a1';
const PROJECT_B = '018f47a2-7c20-7f70-8000-0000000000a2';
// A URL download's alias is deliberately not its asset ID; that divergence is the whole point.
const URL_ALIAS = 'site_example_test_clip_mp4';

const mediaDescriptor = ({ assetId, playbackId, token }) => createNativeMediaDescriptor({
  asset: {
    displayName: 'fixture.mp4',
    extension: 'mp4',
    id: assetId,
    kind: 'video',
    sizeBytes: 10,
  },
  playback: {
    byteLength: 10,
    id: playbackId,
    mimeType: 'video/mp4',
    playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${token}`,
  },
});

const MEDIA_A = mediaDescriptor({
  assetId: ASSET_A,
  playbackId: '123e4567-e89b-42d3-a456-426614174000',
  token: 'a'.repeat(64),
});
const MEDIA_B = mediaDescriptor({
  assetId: ASSET_B,
  playbackId: '123e4567-e89b-42d3-a456-426614174001',
  token: 'b'.repeat(64),
});

const sessionA = () => ({ assetId: ASSET_A, cacheId: URL_ALIAS, projectId: PROJECT_A });

const resolvedProject = (projectId = PROJECT_A, assetId = ASSET_A) => ({
  cacheId: URL_ALIAS,
  projectId,
  snapshot: {
    metadata: { id: projectId, name: 'Downloaded media' },
    stateVersion: 3,
    media: [{ id: assetId, displayName: 'fixture.mp4', extension: 'mp4', sizeBytes: 10, kind: 'video' }],
    tracks: [],
  },
});

// Every dependency stays observable, so an override written as a plain arrow is still a spy.
const spied = (value) => (
  typeof value === 'function' && !vi.isMockFunction(value) ? vi.fn(value) : value
);

const createHarness = (overrides = {}) => {
  const release = vi.fn(() => true);
  const state = { session: sessionA() };
  const deps = {
    read: vi.fn(async () => null),
    restore: vi.fn(async () => MEDIA_A),
    readSession: vi.fn(() => state.session),
    resolveOwner: vi.fn(async () => resolvedProject()),
    activate: vi.fn(async () => Object.freeze({ claimOptions: {}, release })),
    apply: vi.fn(),
  };
  for (const [key, value] of Object.entries(overrides)) deps[key] = spied(value);
  return { ...deps, release, state, hydrator: createNativeMediaSessionHydrator(deps) };
};

beforeEach(() => {
  localStorage.clear();
  clearBrowserMediaBlobs();
  vi.restoreAllMocks();
});

it('publishes the owning project and reopens the remembered asset on a fresh process', async () => {
  const harness = createHarness();

  await expect(harness.hydrator.hydrate()).resolves.toBe(true);

  expect(harness.resolveOwner).toHaveBeenCalledExactlyOnceWith(sessionA());
  expect(harness.activate).toHaveBeenCalledExactlyOnceWith(
    resolvedProject(),
    { validateOwnership: expect.any(Function) }
  );
  expect(harness.restore).toHaveBeenCalledExactlyOnceWith(ASSET_A);
  expect(harness.apply).toHaveBeenCalledExactlyOnceWith({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    validateOwnership: expect.any(Function),
  });
  // The reopened project is the app's active project from here on.
  expect(harness.release).not.toHaveBeenCalled();
});

it('awaits an exact-project binding receipt before publishing the restored media', async () => {
  localStorage.setItem('current_file_url', 'blob:obsolete');
  registerBrowserMediaBlob('blob:obsolete', new Blob(['obsolete']));
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const setUploadedFile = vi.fn();
  const receipt = Object.freeze({ cacheId: URL_ALIAS, projectId: PROJECT_A });
  const activateBindingImpl = vi.fn(async () => receipt);

  await applyNativeMediaSession({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    setUploadedFile,
    activateBindingImpl,
    validateBindingImpl: (value, scope) => (
      value === receipt && scope.cacheId === URL_ALIAS && scope.projectId === PROJECT_A
    ),
  });

  expect(revokeObjectUrl).toHaveBeenCalledExactlyOnceWith('blob:obsolete');
  expect(getBrowserMediaBlob('blob:obsolete')).toBeNull();
  expect(localStorage.getItem('current_file_url')).toBe(MEDIA_A.playbackUrl);
  // Native identity is held only by the validated session tuple, never a browser mirror.
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();
  expect(activateBindingImpl).toHaveBeenCalledExactlyOnceWith(URL_ALIAS, {
    expectedProjectId: PROJECT_A,
    create: false,
  });
  expect(setUploadedFile).toHaveBeenCalledExactlyOnceWith(MEDIA_A);
});

it('keeps the replaced browser source live when React publication refuses', async () => {
  const previousBlob = new Blob(['still-current']);
  localStorage.setItem('current_file_url', 'blob:still-current');
  registerBrowserMediaBlob('blob:still-current', previousBlob);
  const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  await expect(applyNativeMediaSession({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    setUploadedFile: () => { throw new Error('publication refused'); },
    activateBindingImpl: async () => Object.freeze({ cacheId: URL_ALIAS, projectId: PROJECT_A }),
    validateBindingImpl: () => true,
  })).rejects.toThrow('publication refused');

  expect(localStorage.getItem('current_file_url')).toBe('blob:still-current');
  expect(getBrowserMediaBlob('blob:still-current')).toBe(previousBlob);
  expect(revokeObjectUrl).not.toHaveBeenCalled();
});

it.each([
  ['a missing alias', { cacheId: undefined }],
  ['a blank alias', { cacheId: '' }],
  ['a forged descriptor', { media: Object.freeze({ ...MEDIA_A, assetId: 'asset-a' }) }],
])('refuses to apply a session with %s', (_label, overrides) => {
  expect(() => applyNativeMediaSession({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    setUploadedFile: vi.fn(),
    activateBindingImpl: vi.fn(),
    validateBindingImpl: vi.fn(),
    ...overrides,
  })).toThrow(TypeError);
});

it('does nothing without a remembered session', async () => {
  const harness = createHarness({ readSession: () => null });
  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.read).not.toHaveBeenCalled();
  expect(harness.restore).not.toHaveBeenCalled();
});

it('is disabled by clearing the durable media session, with no teardown of its own', async () => {
  const harness = createHarness();
  harness.state.session = null;

  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.resolveOwner).not.toHaveBeenCalled();
  expect(harness.restore).not.toHaveBeenCalled();
});

it('adopts media the native process already holds only after publishing its owning project', async () => {
  const harness = createHarness({ read: async () => MEDIA_A });

  await expect(harness.hydrator.hydrate()).resolves.toBe(true);
  expect(harness.resolveOwner).toHaveBeenCalledExactlyOnceWith(sessionA());
  expect(harness.activate).toHaveBeenCalledExactlyOnceWith(
    resolvedProject(),
    { validateOwnership: expect.any(Function) },
  );
  expect(harness.restore).not.toHaveBeenCalled();
  expect(harness.apply).toHaveBeenCalledExactlyOnceWith({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    validateOwnership: expect.any(Function),
  });
});

it.each([
  ['different media', async () => MEDIA_B],
  ['a forged descriptor', async () => Object.freeze({ ...MEDIA_A, playbackUrl: 'file:///clip.mp4' })],
])('fails closed when the native process already holds %s', async (_label, read) => {
  const harness = createHarness({ read });
  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.apply).not.toHaveBeenCalled();
});

it('never activates when the alias no longer resolves to the remembered project', async () => {
  const harness = createHarness({ resolveOwner: async () => null });

  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.activate).not.toHaveBeenCalled();
  expect(harness.restore).not.toHaveBeenCalled();
  expect(harness.apply).not.toHaveBeenCalled();
});

it('does not reopen when publishing the owning project fails', async () => {
  const harness = createHarness({
    activate: async () => { throw new Error('a newer project won'); },
  });

  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.restore).not.toHaveBeenCalled();
  expect(harness.apply).not.toHaveBeenCalled();
});

it.each([
  ['the reopen fails', { restore: async () => { throw new Error('private reopen failure'); } }],
  ['the reopen loses its only-if-empty race', { restore: async () => null }],
  ['the reopened descriptor is forged', {
    restore: async () => Object.freeze({ ...MEDIA_A, playbackUrl: 'file:///private/clip.mp4' }),
  }],
  ['the reopened asset is a different one', { restore: async () => MEDIA_B }],
  ['publication cannot be applied', { apply: () => { throw new Error('render failure'); } }],
])('withdraws its publication exactly once when %s', async (_label, overrides) => {
  const harness = createHarness(overrides);

  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.release).toHaveBeenCalledOnce();
});

it.each([
  ['a different project', () => ({ ...sessionA(), projectId: PROJECT_B })],
  ['a different alias', () => ({ ...sessionA(), cacheId: 'other-alias' })],
  ['a different asset', () => ({ ...sessionA(), assetId: ASSET_B })],
  ['no session at all', () => null],
])('discards the reopen when the session becomes %s in flight', async (_label, next) => {
  const pending = deferred();
  const harness = createHarness({ restore: () => pending.promise });

  const request = harness.hydrator.hydrate();
  await vi.waitFor(() => expect(harness.restore).toHaveBeenCalledOnce());
  harness.state.session = next();
  pending.resolve(MEDIA_A);

  await expect(request).resolves.toBe(false);
  expect(harness.apply).not.toHaveBeenCalled();
  expect(harness.release).toHaveBeenCalledOnce();
});

it('refuses to publish for a session that changed before the project was resolved', async () => {
  const pending = deferred();
  const harness = createHarness({ resolveOwner: () => pending.promise });

  const request = harness.hydrator.hydrate();
  await vi.waitFor(() => expect(harness.resolveOwner).toHaveBeenCalledOnce());
  harness.state.session = { ...sessionA(), assetId: ASSET_B };
  pending.resolve(resolvedProject());

  await expect(request).resolves.toBe(false);
  expect(harness.activate).not.toHaveBeenCalled();
});

it('supersedes an in-flight hydration with a later one', async () => {
  const first = deferred();
  const harness = createHarness({
    restore: vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => MEDIA_A),
  });

  const stale = harness.hydrator.hydrate();
  await vi.waitFor(() => expect(harness.restore).toHaveBeenCalledOnce());
  const latest = harness.hydrator.hydrate();

  await expect(latest).resolves.toBe(true);
  first.resolve(MEDIA_A);
  await expect(stale).resolves.toBe(false);
  expect(harness.apply).toHaveBeenCalledExactlyOnceWith({
    media: MEDIA_A,
    cacheId: URL_ALIAS,
    projectId: PROJECT_A,
    validateOwnership: expect.any(Function),
  });
});

it('withdraws its publication when the hook is disposed mid-reopen', async () => {
  const pending = deferred();
  const harness = createHarness({ restore: () => pending.promise });

  const request = harness.hydrator.hydrate();
  await vi.waitFor(() => expect(harness.restore).toHaveBeenCalledOnce());
  harness.hydrator.dispose();
  pending.resolve(MEDIA_A);

  await expect(request).resolves.toBe(false);
  expect(harness.apply).not.toHaveBeenCalled();
  expect(harness.release).toHaveBeenCalledOnce();
});

it.each([
  ['the native session read fails', { read: async () => { throw new Error('private detail'); } }],
  ['the session pointer is unreadable', { readSession: () => { throw new Error('storage gone'); } }],
])('fails closed when %s', async (_label, overrides) => {
  const harness = createHarness(overrides);
  await expect(harness.hydrator.hydrate()).resolves.toBe(false);
  expect(harness.apply).not.toHaveBeenCalled();
});

it('requires every reviewed dependency', () => {
  expect(() => createNativeMediaSessionHydrator({ apply: undefined })).toThrow(TypeError);
  expect(() => createNativeMediaSessionHydrator({
    apply: vi.fn(),
    resolveOwner: 'not-a-function',
  })).toThrow(TypeError);
});
