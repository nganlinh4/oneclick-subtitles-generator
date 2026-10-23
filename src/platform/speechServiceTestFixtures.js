// Shared IDs and host-shaped payload builders for the speechService test files.
import {
  MAX_SPEECH_BATCH_BYTES,
  MAX_SPEECH_SEGMENTS,
  createSpeechLifecycleState,
} from './speechService';

export const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
export const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
export const EDITED_ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
export const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
export const OTHER_PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a5';
export const DELIVERY_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a6';
export const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
export const TOKEN = 'a'.repeat(64);

export class FakeChannel {
  constructor() {
    this.onmessage = null;
  }
}

export const job = (state = 'running', sequence = 1, basisPoints = 0) => ({
  id: JOB_ID,
  kind: 'synthesizeNarration',
  state,
  progress: { basisPoints },
  sequence,
});

export const artifact = () => ({
  artifactId: ARTIFACT_ID,
  format: 'wav',
  bytes: 4_096,
  durationMicros: 1_000_000,
  sampleRateHz: 24_000,
  channels: 1,
});

export const playable = () => ({
  artifact: artifact(),
  playback: {
    id: PLAYBACK_ID,
    playbackUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${TOKEN}`,
    mimeType: 'audio/wav',
    byteLength: 4_096,
  },
});

export const projectReference = (overrides = {}) => ({
  schemaVersion: 1,
  projectId: PROJECT_ID,
  projectStateVersion: 7,
  referenceVersion: 1,
  artifactId: ARTIFACT_ID,
  transcript: '',
  language: 'Unknown',
  pendingDelivery: null,
  ...overrides,
});

export const playableReference = (overrides = {}) => ({
  reference: projectReference(overrides.reference),
  playable: playable(),
});

export const projectNarration = (overrides = {}) => ({
  schemaVersion: 1,
  projectId: PROJECT_ID,
  projectStateVersion: 7,
  source: 'original',
  results: [{
    subtitleId: 1,
    text: 'spoken words',
    artifact: artifact(),
    method: 'gtts',
    outputIndex: 0,
    originalIds: [1],
    startMicros: 0,
    endMicros: 1_000_000,
  }],
  ...overrides,
});

export const backendStatus = (backend, overrides = {}) => ({
  backend,
  epoch: 0,
  enabled: false,
  installed: false,
  ready: false,
  warm: false,
  requiresReference: backend === 'f5Tts' || backend === 'chatterbox',
  supportsVoiceInventory: ['edgeTts', 'gtts', 'geminiTts'].includes(backend),
  supportsVoiceConversion: backend === 'chatterbox',
  requiresCredential: backend === 'geminiTts',
  ...overrides,
});

export const runningLifecycleState = (backend = 'gtts', epoch = 0) => {
  const lifecycleState = createSpeechLifecycleState();
  lifecycleState.apply(backendStatus(backend, {
    epoch, enabled: true, installed: true, ready: true, warm: true,
  }));
  return lifecycleState;
};

export const status = () => ({
  backends: [
    backendStatus('f5Tts'),
    backendStatus('chatterbox'),
    backendStatus('edgeTts'),
    backendStatus('gtts'),
    backendStatus('geminiTts'),
  ],
  maxSegmentsPerJob: MAX_SPEECH_SEGMENTS,
  maxBatchTextBytes: MAX_SPEECH_BATCH_BYTES,
});
