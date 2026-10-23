// Shared harness and wire fixtures for the nativeUrlDownloadAdapter suites.
import { v7 as uuidv7 } from 'uuid';
import { vi } from 'vitest';

import { createNativeUrlDownloadAdapter } from './nativeUrlDownloadAdapter';
import { activateResolvedMediaProject } from './mediaProjectActivation';

export const flush = () => new Promise((resolve) => { setTimeout(resolve, 0); });
export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

export const mediaCandidate = (assetId) => ({
  asset: {
    id: assetId,
    displayName: 'download.mp4',
    extension: 'mp4',
    sizeBytes: 4096,
    kind: 'video',
  },
  contentIdentity: {
    algorithm: 'blake3-256',
    digest: 'c'.repeat(64),
    sizeBytes: 4096,
  },
});

export const candidateProject = (projectId = uuidv7(), stateVersion = 7) => ({
  projectId,
  snapshot: {
    metadata: { id: projectId, name: 'Downloaded media' },
    stateVersion,
    media: [],
    tracks: [],
  },
});

export const createHarness = (overrides = {}) => {
  const inventoryId = uuidv7();
  const jobId = uuidv7();
  const assetId = uuidv7();
  const descriptor = Object.freeze({ assetId, playbackUrl: 'http://127.0.0.1/media' });
  let handlers;
  const inspect = vi.fn().mockResolvedValue({ capability: { id: inventoryId } });
  const start = vi.fn().mockImplementation(async (_request, nextHandlers) => {
    handlers = nextHandlers;
    return { id: jobId };
  });
  const cancel = vi.fn().mockResolvedValue({ id: jobId, state: 'cancelling' });
  const openAsset = vi.fn().mockResolvedValue(descriptor);
  const describeMedia = vi.fn().mockReturnValue(descriptor);
  const discardCandidate = vi.fn().mockResolvedValue(true);
  const projectId = uuidv7();
  const resolveCandidateProject = vi.fn().mockResolvedValue(candidateProject(projectId));
  const recoverDownloader = vi.fn().mockResolvedValue({ updated: false, throttled: false });
  const waitForRetry = vi.fn().mockResolvedValue(undefined);
  const adapter = createNativeUrlDownloadAdapter({
    inspect,
    start,
    cancel,
    openAsset,
    claimCandidate: describeMedia,
    discardCandidate,
    resolveCandidateProject,
    recoverDownloader,
    waitForRetry,
    activateProject: activateResolvedMediaProject,
    ...overrides,
  });
  return {
    ...overrides,
    adapter,
    assetId,
    cancel,
    describeMedia,
    discardCandidate,
    descriptor,
    getHandlers: () => handlers,
    inspect,
    inventoryId,
    jobId,
    openAsset,
    recoverDownloader,
    waitForRetry,
    resolveCandidateProject,
    start,
  };
};

export const publicationSpy = () => {
  const release = vi.fn(() => true);
  const activateProject = vi.fn(async (resolved) => Object.freeze({
    claimOptions: Object.freeze({
      expectedStateVersion: resolved.snapshot.stateVersion,
      projectId: resolved.projectId,
    }),
    release,
  }));
  return { activateProject, release };
};
