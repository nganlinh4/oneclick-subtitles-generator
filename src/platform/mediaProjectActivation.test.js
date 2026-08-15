import { createMediaCandidateLifecycle, createNativeMediaDescriptor } from './mediaService';
import { createProjectService } from './projectService';
import {
  createMediaProjectActivation,
  normalizeResolvedMediaProject,
} from './mediaProjectActivation';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000201';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000401';
const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const REVISION_ID = '01890f39-7b62-7c4e-8c9a-000000000301';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;

const projectSnapshot = (id, stateVersion, media = []) => ({
  metadata: { id, name: 'Downloaded media' },
  stateVersion,
  media,
  tracks: [],
});

const resolution = (id, stateVersion, media = []) => ({
  cacheId: 'url-cache',
  projectId: id,
  snapshot: projectSnapshot(id, stateVersion, media),
});

const candidateAsset = () => ({
  displayName: 'download.mp4',
  extension: 'mp4',
  id: ASSET_ID,
  kind: 'video',
  sizeBytes: 4096,
});

const mediaCandidate = () => ({
  asset: candidateAsset(),
  contentIdentity: {
    algorithm: 'blake3-256',
    digest: 'c'.repeat(64),
    sizeBytes: 4096,
  },
});

const nativeDescriptor = () => createNativeMediaDescriptor({
  asset: candidateAsset(),
  playback: {
    id: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
    mimeType: 'video/mp4',
    byteLength: 4096,
  },
});

/** Publication double which records exactly what projectService would be asked to publish. */
const createPublicationDouble = () => {
  const state = { active: null };
  const activateSnapshot = vi.fn((snapshot) => {
    state.active = snapshot;
    return snapshot;
  });
  const deactivate = vi.fn(({ expectedProjectId } = {}) => {
    if (expectedProjectId !== undefined && state.active?.metadata?.id !== expectedProjectId) {
      return false;
    }
    state.active = null;
    return true;
  });
  return {
    state,
    activateSnapshot,
    deactivate,
    activation: createMediaProjectActivation({
      activateSnapshot,
      deactivate,
      getActiveSnapshot: () => state.active,
    }),
  };
};

it('exposes only the exact claim identity from a resolved project', () => {
  const normalized = normalizeResolvedMediaProject(resolution(PROJECT_A, 4));

  expect(normalized.projectId).toBe(PROJECT_A);
  expect(normalized.expectedStateVersion).toBe(4);
  expect(Object.isFrozen(normalized)).toBe(true);
});

it.each([
  ['null', () => null],
  ['array', () => []],
  ['prototype-bearing record', () => Object.assign(Object.create({ evil: true }), resolution(PROJECT_A, 4))],
  ['unknown key', () => ({ ...resolution(PROJECT_A, 4), path: 'C:\\private\\clip.mp4' })],
  ['non-UUIDv7 project ID', () => ({ ...resolution(PROJECT_A, 4), projectId: PLAYBACK_ID })],
  ['metadata mismatch', () => resolution(PROJECT_A, 4, []).snapshot
    && { ...resolution(PROJECT_A, 4), snapshot: projectSnapshot(PROJECT_B, 4) }],
  ['blank metadata name', () => {
    const value = resolution(PROJECT_A, 4);
    value.snapshot.metadata.name = 7;
    return value;
  }],
  ['negative state version', () => ({ ...resolution(PROJECT_A, 4), snapshot: projectSnapshot(PROJECT_A, -1) })],
  ['unsafe state version', () => ({
    ...resolution(PROJECT_A, 4),
    snapshot: projectSnapshot(PROJECT_A, Number.MAX_SAFE_INTEGER + 1),
  })],
  ['missing snapshot key', () => {
    const value = resolution(PROJECT_A, 4);
    delete value.snapshot.tracks;
    return value;
  }],
  ['extra snapshot key', () => {
    const value = resolution(PROJECT_A, 4);
    value.snapshot.path = '/secret/clip.mp4';
    return value;
  }],
  ['non-array media', () => {
    const value = resolution(PROJECT_A, 4);
    value.snapshot.media = {};
    return value;
  }],
  ['accessor state version', () => {
    const value = resolution(PROJECT_A, 4);
    Object.defineProperty(value.snapshot, 'stateVersion', { enumerable: true, get: () => 4 });
    return value;
  }],
  ['accessor project ID', () => {
    const value = resolution(PROJECT_A, 4);
    Object.defineProperty(value, 'projectId', { enumerable: true, get: () => PROJECT_A });
    return value;
  }],
  ['non-enumerable project ID', () => {
    const value = resolution(PROJECT_A, 4);
    Object.defineProperty(value, 'projectId', { enumerable: false, value: PROJECT_A });
    return value;
  }],
])('rejects a hostile resolved project: %s', (_label, build) => {
  expect(() => normalizeResolvedMediaProject(build())).toThrow(
    expect.objectContaining({ code: 'invalidMediaProject' })
  );
});

it('publishes the exact resolved project on a clean session', async () => {
  const { activation, activateSnapshot, state } = createPublicationDouble();

  const handle = await activation.activateResolvedProject(resolution(PROJECT_A, 4));

  expect(activateSnapshot).toHaveBeenCalledExactlyOnceWith(projectSnapshot(PROJECT_A, 4));
  expect(state.active.metadata.id).toBe(PROJECT_A);
  expect(handle.claimOptions).toEqual({ expectedStateVersion: 4, projectId: PROJECT_A });
  expect(Object.isFrozen(handle.claimOptions)).toBe(true);
  expect(Object.keys(handle.claimOptions).sort()).toEqual(['expectedStateVersion', 'projectId']);
});

it('revalidates ownership before and after publication', async () => {
  const { activation, activateSnapshot, state } = createPublicationDouble();
  const order = [];
  activateSnapshot.mockImplementation((snapshot) => {
    order.push('publish');
    state.active = snapshot;
  });

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4), {
    validateOwnership: () => { order.push('ownership'); },
  })).resolves.toEqual(expect.objectContaining({ claimOptions: expect.any(Object) }));

  expect(order).toEqual(['ownership', 'publish', 'ownership']);
});

it('never publishes when ownership is already lost', async () => {
  const { activation, activateSnapshot, deactivate } = createPublicationDouble();
  const lost = new Error('source switched');

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4), {
    validateOwnership: () => { throw lost; },
  })).rejects.toBe(lost);

  expect(activateSnapshot).not.toHaveBeenCalled();
  expect(deactivate).not.toHaveBeenCalled();
});

it('releases its own publication when ownership is lost immediately after it', async () => {
  const { activation, deactivate, state } = createPublicationDouble();
  const lost = new Error('source switched');
  let published = false;

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4), {
    validateOwnership: () => {
      if (published) throw lost;
      published = true;
    },
  })).rejects.toBe(lost);

  expect(deactivate).toHaveBeenCalledExactlyOnceWith({ expectedProjectId: PROJECT_A });
  expect(state.active).toBeNull();
});

it('refuses to republish an older revision of the already active project', async () => {
  const { activation, activateSnapshot, state } = createPublicationDouble();
  state.active = projectSnapshot(PROJECT_A, 9);

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4))).rejects.toMatchObject({
    code: 'mediaProjectActivationLost',
  });
  expect(activateSnapshot).not.toHaveBeenCalled();
  expect(state.active.stateVersion).toBe(9);
});

it('fails closed when a subscriber hijacks the publication', async () => {
  const { activation, activateSnapshot, deactivate, state } = createPublicationDouble();
  activateSnapshot.mockImplementation(() => { state.active = projectSnapshot(PROJECT_B, 1); });

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4))).rejects.toMatchObject({
    code: 'mediaProjectActivationLost',
  });
  // Releasing here would clobber the project the hijacking subscriber published.
  expect(deactivate).not.toHaveBeenCalled();
  expect(state.active.metadata.id).toBe(PROJECT_B);
});

it('never withdraws a publication a concurrent operation already committed on top of', async () => {
  const { activation, deactivate, state } = createPublicationDouble();

  const winner = await activation.activateResolvedProject(resolution(PROJECT_A, 4));
  const loser = await activation.activateResolvedProject(resolution(PROJECT_A, 4));
  // The winner's claim commits and projectService republishes the same project one revision on.
  state.active = projectSnapshot(PROJECT_A, 5);

  expect(loser.release()).toBe(false);
  expect(winner.release()).toBe(false);
  expect(deactivate).not.toHaveBeenCalled();
  expect(state.active.stateVersion).toBe(5);
});

it('never lets a stale release clobber the project a newer intent owns', async () => {
  const { activation, deactivate, state } = createPublicationDouble();

  const staleHandle = await activation.activateResolvedProject(resolution(PROJECT_A, 4));
  const currentHandle = await activation.activateResolvedProject(resolution(PROJECT_B, 1));

  expect(staleHandle.release()).toBe(false);
  expect(deactivate).not.toHaveBeenCalled();
  expect(state.active.metadata.id).toBe(PROJECT_B);

  expect(currentHandle.release()).toBe(true);
  expect(deactivate).toHaveBeenCalledExactlyOnceWith({ expectedProjectId: PROJECT_B });
  expect(state.active).toBeNull();
});

it('rejects a non-callable ownership validator before publishing', async () => {
  const { activation, activateSnapshot } = createPublicationDouble();

  await expect(activation.activateResolvedProject(resolution(PROJECT_A, 4), {
    validateOwnership: 'always',
  })).rejects.toMatchObject({ code: 'invalidMediaProject' });
  expect(activateSnapshot).not.toHaveBeenCalled();
});

/**
 * The integration below wires the real projectService, mediaProjectActivation and media candidate
 * lifecycle together, faking only the native host. It is the regression guard for the detached
 * singleton defect: with storage detached and no explicit activation, a clean session rejected
 * every candidate claim with `invalidMediaRequest` before native IPC.
 */
const createIntegration = () => {
  const projects = new Map([[PROJECT_A, projectSnapshot(PROJECT_A, 4)]]);
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'project_load') return projects.get(args.id) ?? null;
    if (command === 'project_commit') {
      const committed = { ...args.snapshot, stateVersion: args.snapshot.stateVersion + 1 };
      projects.set(committed.metadata.id, committed);
      return { revisionId: REVISION_ID, stateVersion: committed.stateVersion };
    }
    throw new Error(`unexpected command ${command}`);
  });
  const projectService = createProjectService({ invokeCommand });
  const activation = createMediaProjectActivation({
    activateSnapshot: projectService.activateProjectSnapshot,
    deactivate: projectService.deactivateProject,
    getActiveSnapshot: projectService.getActiveProjectSnapshot,
  });
  const openAsset = vi.fn().mockResolvedValue(nativeDescriptor());
  const lifecycle = createMediaCandidateLifecycle({
    getActiveSnapshot: projectService.getActiveProjectSnapshot,
    invokeCommand: vi.fn(),
    mutate: projectService.mutateProject,
    openAsset,
  });
  return { activation, lifecycle, openAsset, projectService, projects };
};

it('claims a downloaded candidate on a clean session with no active project', async () => {
  const { activation, lifecycle, openAsset, projectService, projects } = createIntegration();
  expect(projectService.getActiveProjectSnapshot()).toBeNull();

  const resolved = { cacheId: 'url-cache', projectId: PROJECT_A, snapshot: projects.get(PROJECT_A) };
  const handle = await activation.activateResolvedProject(resolved);
  const descriptor = await lifecycle.claim(mediaCandidate(), handle.claimOptions);

  expect(descriptor.assetId).toBe(ASSET_ID);
  expect(openAsset).toHaveBeenCalledExactlyOnceWith(ASSET_ID);
  const active = projectService.getActiveProjectSnapshot();
  expect(active.metadata.id).toBe(PROJECT_A);
  expect(active.stateVersion).toBe(5);
  expect(active.media.map((asset) => asset.id)).toEqual([ASSET_ID]);
});

it('rejects the claim and keeps B active when B wins during the candidate commit', async () => {
  const { activation, lifecycle, openAsset, projectService, projects } = createIntegration();
  const resolved = { cacheId: 'url-cache', projectId: PROJECT_A, snapshot: projects.get(PROJECT_A) };
  const handle = await activation.activateResolvedProject(resolved);

  const claim = lifecycle.claim(mediaCandidate(), handle.claimOptions);
  projectService.activateProjectSnapshot(projectSnapshot(PROJECT_B, 1));

  await expect(claim).rejects.toMatchObject({ code: 'invalidMediaRequest' });
  expect(openAsset).not.toHaveBeenCalled();
  expect(projectService.getActiveProjectSnapshot().metadata.id).toBe(PROJECT_B);
  // The losing operation must not deactivate the project the winner published.
  expect(handle.release()).toBe(false);
  expect(projectService.getActiveProjectSnapshot().metadata.id).toBe(PROJECT_B);
});

it('releases its own publication when the claim fails while it is still the owner', async () => {
  const { activation, projectService, projects } = createIntegration();
  const resolved = { cacheId: 'url-cache', projectId: PROJECT_A, snapshot: projects.get(PROJECT_A) };

  const handle = await activation.activateResolvedProject(resolved);
  expect(projectService.getActiveProjectSnapshot().metadata.id).toBe(PROJECT_A);

  expect(handle.release()).toBe(true);
  expect(projectService.getActiveProjectSnapshot()).toBeNull();
});
