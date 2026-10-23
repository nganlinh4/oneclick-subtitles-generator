// Relaunch restore end to end on the JS side: the host-owned active-workspace record is read, its
// exact project is resolved without minting, published, and only then is its asset reopened.
import { createNativeMediaSessionHydrator } from './useNativeMediaSessionHydration';
import { createMediaProjectActivation } from '../platform/mediaProjectActivation';
import { createNativeMediaDescriptor } from '../platform/mediaService';
import {
  NATIVE_MEDIA_SESSION_KEY,
  loadDurableNativeMediaSession,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../platform/nativeMediaOwnership';

const ASSET = '018f47a2-7c20-7f70-8000-000000000011';
const OTHER_ASSET = '018f47a2-7c20-7f70-8000-000000000012';
const PROJECT = '018f47a2-7c20-7f70-8000-0000000000b1';
const OTHER_PROJECT = '018f47a2-7c20-7f70-8000-0000000000b2';
const URL_ALIAS = 'site_example_relaunch_clip_mp4';
const DOCUMENT_ALIAS = 'subtitle-document:018f47a2-7c20-4f70-8000-0000000000d1';

const MEDIA = createNativeMediaDescriptor({
  asset: { displayName: 'clip.mp4', extension: 'mp4', id: ASSET, kind: 'video', sizeBytes: 10 },
  playback: {
    byteLength: 10,
    id: '123e4567-e89b-42d3-a456-426614174010',
    mimeType: 'video/mp4',
    playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174010?token=${'c'.repeat(64)}`,
  },
});

const workspaceState = (workspace, { initialized = workspace !== null } = {}) => ({
  schemaVersion: 1,
  initialized,
  workspace: workspace === null ? null : {
    schemaVersion: 1,
    trackId: null,
    projectStateVersion: 4,
    ...workspace,
  },
});

const projectFor = (cacheId, { projectId = PROJECT, assetId = ASSET } = {}) => ({
  cacheId,
  projectId,
  snapshot: {
    metadata: { id: projectId, name: 'Relaunch fixture' },
    stateVersion: 4,
    media: [{ id: assetId, displayName: 'clip.mp4', extension: 'mp4', sizeBytes: 10, kind: 'video' }],
    tracks: [],
  },
});

/**
 * A fresh process: only durable host state exists. `aliases` is the subtitle-project alias table;
 * resolving an unknown alias returns null, and asking it to create one fails the test.
 */
const freshProcess = ({ nativeState, aliases = {} }) => {
  let published = null;
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'active_workspace_get') return nativeState;
    throw new Error(`unexpected native command ${command}`);
  });
  const resolveProject = vi.fn(async (cacheId, { create }) => {
    if (create !== false) throw new Error('relaunch must never mint a subtitle project');
    return aliases[cacheId] ?? null;
  });
  const adoptProject = vi.fn(async () => null);
  const activation = createMediaProjectActivation({
    activateSnapshot: (snapshot) => { published = snapshot; },
    deactivate: () => { published = null; return true; },
    getActiveSnapshot: () => published,
  });
  // Mirrors the native open precondition: the asset reopens only under its published owner.
  const restore = vi.fn(async (assetId) => {
    if (published?.metadata.id !== PROJECT
        || !published.media.some((asset) => asset.id === assetId)) {
      throw new Error('mediaUnavailable');
    }
    return MEDIA;
  });
  const apply = vi.fn(async () => undefined);
  const forgetStale = vi.fn(async () => true);
  const hydrator = createNativeMediaSessionHydrator({
    read: async () => null,
    restore,
    loadSession: () => loadDurableNativeMediaSession({ invokeCommand }),
    resolveOwner: (session, options) => resolveOwnedNativeMediaProject(session, {
      ...options,
      resolveProject,
      adoptProject,
    }),
    forgetStale,
    activate: activation.activateResolvedProject,
    apply,
  });
  return {
    adoptProject,
    apply,
    forgetStale,
    hydrator,
    invokeCommand,
    published: () => published,
    resolveProject,
    restore,
  };
};

beforeEach(() => {
  localStorage.clear();
});

it.each([
  ['a URL download, whose alias is its source URL', URL_ALIAS],
  ['a picked or dropped local file, whose alias is its asset', ASSET],
  ['a local file attached to a subtitle document, whose alias is the document', DOCUMENT_ALIAS],
])('reopens %s under the exact project the host recorded', async (_label, cacheId) => {
  const run = freshProcess({
    nativeState: workspaceState({ cacheId, projectId: PROJECT, mediaId: ASSET }),
    aliases: { [cacheId]: projectFor(cacheId) },
  });

  await expect(run.hydrator.hydrate()).resolves.toBe(true);

  expect(run.resolveProject).toHaveBeenCalledExactlyOnceWith(cacheId, { create: false });
  expect(run.adoptProject).not.toHaveBeenCalled();
  expect(run.restore).toHaveBeenCalledExactlyOnceWith(ASSET);
  expect(run.apply).toHaveBeenCalledExactlyOnceWith({
    media: MEDIA,
    cacheId,
    projectId: PROJECT,
    validateOwnership: expect.any(Function),
  });
  expect(run.published()?.metadata.id).toBe(PROJECT);
  expect(run.forgetStale).not.toHaveBeenCalled();
  // The browser mirror now matches the host record for synchronous ownership checks.
  expect(readNativeMediaSession()).toEqual({ assetId: ASSET, cacheId, projectId: PROJECT });
});

it('never resolves a downloaded project through its asset ID', async () => {
  // Only the URL alias names the real project; the asset alias would be a different, empty one.
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
    aliases: {
      [URL_ALIAS]: projectFor(URL_ALIAS),
      [ASSET]: projectFor(ASSET, { projectId: OTHER_PROJECT }),
    },
  });

  await expect(run.hydrator.hydrate()).resolves.toBe(true);
  expect(run.resolveProject.mock.calls.map(([alias]) => alias)).toEqual([URL_ALIAS]);
});

it('fails closed and drops a stale browser mirror when the host record no longer holds', async () => {
  // The host invalidates the record itself once its project stops owning the media.
  localStorage.setItem(NATIVE_MEDIA_SESSION_KEY, JSON.stringify({
    v: 1, assetId: ASSET, cacheId: URL_ALIAS, projectId: PROJECT,
  }));
  const run = freshProcess({
    nativeState: workspaceState(null, { initialized: true }),
    aliases: { [URL_ALIAS]: projectFor(URL_ALIAS) },
  });

  await expect(run.hydrator.hydrate()).resolves.toBe(false);

  expect(localStorage.getItem(NATIVE_MEDIA_SESSION_KEY)).toBeNull();
  expect(run.resolveProject).not.toHaveBeenCalled();
  expect(run.restore).not.toHaveBeenCalled();
  expect(run.published()).toBeNull();
});

it('does nothing on a first run with no record anywhere', async () => {
  const run = freshProcess({ nativeState: workspaceState(null) });

  await expect(run.hydrator.hydrate()).resolves.toBe(false);
  expect(run.invokeCommand).toHaveBeenCalledExactlyOnceWith('active_workspace_get', {});
  expect(run.resolveProject).not.toHaveBeenCalled();
});

it.each([
  ['its alias was deleted', {}, false],
  ['its alias now names another project', { [URL_ALIAS]: projectFor(URL_ALIAS, { projectId: OTHER_PROJECT }) }, true],
  ['its project no longer lists the asset', { [URL_ALIAS]: projectFor(URL_ALIAS, { assetId: OTHER_ASSET }) }, true],
])('fails closed without minting or publishing when %s', async (_label, aliases, provenStale) => {
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
    aliases,
  });

  await expect(run.hydrator.hydrate()).resolves.toBe(false);

  for (const [, options] of run.resolveProject.mock.calls) expect(options).toEqual({ create: false });
  expect(run.restore).not.toHaveBeenCalled();
  expect(run.apply).not.toHaveBeenCalled();
  expect(run.published()).toBeNull();
  // Only a definitive disowning withdraws the exact host record; an unanswered lookup keeps it.
  if (provenStale) {
    expect(run.forgetStale).toHaveBeenCalledExactlyOnceWith({
      assetId: ASSET, cacheId: URL_ALIAS, projectId: PROJECT,
    });
  } else {
    expect(run.forgetStale).not.toHaveBeenCalled();
  }
});

it('keeps the record when the stores cannot answer, so a later run can still restore', async () => {
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
  });
  run.resolveProject.mockRejectedValueOnce(new Error('index unavailable'));

  await expect(run.hydrator.hydrate()).resolves.toBe(false);
  expect(run.forgetStale).not.toHaveBeenCalled();
});

it('keeps the record when the host refuses to reopen the file', async () => {
  // The owner is intact but the bytes are not reachable now (for example an unplugged drive).
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
    aliases: { [URL_ALIAS]: projectFor(URL_ALIAS) },
  });
  run.restore.mockRejectedValueOnce(new Error('mediaUnavailable'));

  await expect(run.hydrator.hydrate()).resolves.toBe(false);
  expect(run.forgetStale).not.toHaveBeenCalled();
  expect(run.published()).toBeNull();
});

it('does not withdraw a record that a newer selection replaced during the lookup', async () => {
  let answer;
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
  });
  run.resolveProject.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));

  const pending = run.hydrator.hydrate();
  await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
  // A newer selection publishes its own pointer before the stale answer arrives.
  localStorage.setItem(NATIVE_MEDIA_SESSION_KEY, JSON.stringify({
    v: 1, assetId: OTHER_ASSET, cacheId: OTHER_ASSET, projectId: OTHER_PROJECT,
  }));
  answer(projectFor(URL_ALIAS, { projectId: OTHER_PROJECT }));

  await expect(pending).resolves.toBe(false);
  expect(run.forgetStale).not.toHaveBeenCalled();
});

it('still fails closed when withdrawing a stale record fails', async () => {
  const run = freshProcess({
    nativeState: workspaceState({ cacheId: URL_ALIAS, projectId: PROJECT, mediaId: ASSET }),
    aliases: { [URL_ALIAS]: projectFor(URL_ALIAS, { assetId: OTHER_ASSET }) },
  });
  run.forgetStale.mockRejectedValueOnce(new Error('staleActiveWorkspaceIntent'));

  await expect(run.hydrator.hydrate()).resolves.toBe(false);
  expect(run.forgetStale).toHaveBeenCalledTimes(1);
});
