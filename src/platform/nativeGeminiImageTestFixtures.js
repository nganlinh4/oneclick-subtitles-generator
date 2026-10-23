// Shared ids, wire fixtures and a fully injected service harness for the nativeGeminiImage suites.
import { vi } from 'vitest';

import { createNativeGeminiImage } from './nativeGeminiImage';

export const CREDENTIAL_A = '01890f39-7b62-7c4e-8c9a-000000000301';
export const CREDENTIAL_B = '01890f39-7b62-7c4e-8c9a-000000000302';
export const REFERENCE_ID = '01890f39-7b62-7c4e-8c9a-000000000303';
export const JOB_A = '01890f39-7b62-7c4e-8c9a-000000000304';
export const JOB_B = '01890f39-7b62-7c4e-8c9a-000000000305';
export const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000306';
export const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000307';
export const ARTIFACT_A = '01890f39-7b62-7c4e-8c9a-000000000308';
export const ARTIFACT_B = '01890f39-7b62-7c4e-8c9a-000000000309';
export const PLAYBACK_A = '4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11';
export const PLAYBACK_B = '9cb6df97-92c6-4f6d-8717-c2a7acb74a12';
export const REFERENCE_PLAYBACK = 'c89ea814-1749-4c3b-8507-4c457df2ef30';
export const TOKEN = 'a'.repeat(64);
export const REFERENCE_PLAYBACK_URL = `http://127.0.0.1:43210/asset/${REFERENCE_PLAYBACK}?token=${TOKEN}`;

export const snapshot = (id, state, sequence = 1) => ({
  id,
  kind: 'generateImage',
  state,
  progress: { basisPoints: state === 'succeeded' ? 10_000 : 0 },
  sequence,
});

export const descriptor = (artifactId = ARTIFACT_A, projectId = PROJECT_A, mimeType = 'image/png') => ({
  artifactId,
  projectId,
  mimeType,
  sizeBytes: 4,
  createdAtMs: 1_700_000_000_000,
});

export const playable = ({
  artifactId = ARTIFACT_A,
  projectId = PROJECT_A,
  playbackId = PLAYBACK_A,
  mimeType = 'image/png',
} = {}) => ({
  artifact: descriptor(artifactId, projectId, mimeType),
  playback: {
    id: playbackId,
    playbackUrl: `http://127.0.0.1:43210/asset/${playbackId}?token=${TOKEN}`,
    mimeType,
    byteLength: 4,
  },
});

export class FakeChannel {
  onmessage = null;
}

export const createHarness = ({
  invokeImplementation,
  importImageImplementation,
  resolveProjectImplementation,
  credentials = [CREDENTIAL_A],
} = {}) => {
  let activeIndex = 0;
  let activeCache = 'cache-a';
  const importImage = vi.fn(importImageImplementation ?? (async () => ({
    assetId: REFERENCE_ID,
    mimeType: 'image/png',
    sizeBytes: 16,
  })));
  const releaseImage = vi.fn().mockResolvedValue(true);
  const rotateCredential = vi.fn(async () => {
    activeIndex += 1;
  });
  const invokeCommand = vi.fn(invokeImplementation ?? (async (command, args) => {
    if (command === 'generated_image_playback_release') return true;
    if (command === 'gemini_image_complete') {
      return snapshot(args.request.jobId, 'succeeded', 2);
    }
    if (command !== 'gemini_image_start') throw new Error(`unexpected command ${command}`);
    queueMicrotask(() => {
      args.onEvent.onmessage({
        event: 'prepared',
        job: snapshot(JOB_A, 'running'),
        image: playable(),
      });
    });
    return snapshot(JOB_A, 'running');
  }));
  const cancel = vi.fn().mockResolvedValue(snapshot(JOB_A, 'cancelled', 2));
  const getCacheId = vi.fn(() => activeCache);
  const resolveProject = vi.fn(resolveProjectImplementation ?? (async (cacheId) => ({
    cacheId,
    projectId: cacheId === 'cache-a' ? PROJECT_A : PROJECT_B,
  })));
  const service = createNativeGeminiImage({
    prepareCredentials: vi.fn().mockResolvedValue(undefined),
    getCredentialId: vi.fn(() => credentials[activeIndex] ?? null),
    getCredentialSnapshot: vi.fn(() => ({
      gemini: { availableCredentialIds: credentials },
    })),
    rotateCredential,
    importImage,
    releaseImage,
    getCacheId,
    resolveProject,
    invokeCommand,
    ChannelConstructor: FakeChannel,
    cancel,
    isNativeRuntime: () => true,
  });
  return {
    service,
    importImage,
    releaseImage,
    rotateCredential,
    getCacheId,
    resolveProject,
    invokeCommand,
    cancel,
    setActiveProject: (projectId) => {
      activeCache = projectId === PROJECT_A ? 'cache-a' : 'cache-b';
    },
  };
};
