// Shared wire fixtures and a test Channel for the downloadService suites.
import { v7 as uuidv7 } from 'uuid';
import { vi } from 'vitest';

import { createNativeDownloadService } from './downloadService';

export class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

export const job = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'downloadMedia',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

export const inventory = (overrides = {}) => ({
  title: 'Example video',
  durationSeconds: 125,
  formats: {
    video: [{
      formatId: '137',
      container: 'mp4',
      width: 1920,
      height: 1080,
      fpsMilli: 30_000,
      codec: 'avc1.640028',
      includesAudio: false,
      sizeBytes: 5_000_000,
      bitrateKbps: 4_500,
    }],
    audio: [{
      formatId: '140',
      container: 'm4a',
      codec: 'mp4a.40.2',
      sizeBytes: 500_000,
      bitrateKbps: 128,
    }],
    qualities: [{ height: 1080, hasCombined: false, hasVideoOnly: true }],
  },
  subtitles: [{ language: 'en', source: 'manual', formats: ['srt', 'vtt'] }],
  ...overrides,
});

export const inspection = (overrides = {}) => ({
  capability: { id: uuidv7(), expiresAtMs: Date.now() + 60_000 },
  inventory: inventory(),
  ...overrides,
});

export const summary = (overrides = {}) => ({
  title: 'Example video',
  durationSeconds: 125,
  mediaFilename: 'Example video.mp4',
  mediaBytes: 5_000_000,
  subtitleFilename: null,
  subtitleBytes: null,
  subtitleLanguage: null,
  ...overrides,
});

export const completedEvent = (id, overrides = {}) => {
  return {
    event: 'completed',
    job: job({
      id,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 2,
    }),
    media: {
      asset: {
        id: uuidv7(),
        displayName: 'Example video.mp4',
        extension: 'mp4',
        sizeBytes: 5_000_000,
        kind: 'video',
      },
      contentIdentity: {
        algorithm: 'blake3-256',
        digest: 'a'.repeat(64),
        sizeBytes: 5_000_000,
      },
    },
    summary: summary(),
    subtitle: null,
    ...overrides,
  };
};

export const createService = (overrides = {}) => createNativeDownloadService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});
