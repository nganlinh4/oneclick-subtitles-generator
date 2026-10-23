// Shared identities, wire fixtures and a recording Channel for the mediaPipelineService suites.
export const SOURCE_ID = '018f1234-5678-7abc-8def-1234567890ab';
export const OUTPUT_ID = '018f1234-5679-7abc-8def-1234567890ab';
export const JOB_ID = '018f1234-5680-7abc-8def-1234567890ab';
const PLAYBACK_ID = '123e4567-e89b-42d3-a456-426614174000';

export const job = (state = 'running', basisPoints = 100) => ({
  id: JOB_ID,
  kind: 'processMedia',
  state,
  progress: { basisPoints },
  sequence: state === 'running' ? 1 : 2,
});

export const inspection = (assetId = OUTPUT_ID) => ({
  assetId,
  durationUs: 2_000_000,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'h264',
  audioCodec: 'aac',
  width: 1280,
  height: 720,
  frameRate: 30,
  compatibilityAction: 'direct',
  issues: [],
});

export const mediaResult = () => ({
  kind: 'media',
  media: {
    asset: {
      id: OUTPUT_ID,
      displayName: 'analysis-clip.mp4',
      extension: 'mp4',
      sizeBytes: 1234,
      kind: 'video',
    },
    playback: {
      id: PLAYBACK_ID,
      playbackUrl: `http://127.0.0.1:32123/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`,
      mimeType: 'video/mp4',
      byteLength: 1234,
    },
  },
  inspection: inspection(),
});

export class MockChannel {
  static latest = null;

  constructor() {
    MockChannel.latest = this;
    this.onmessage = null;
  }

  emit(value) {
    this.onmessage(value);
  }
}
