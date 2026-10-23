// Shared native media DTO fixtures for the mediaService module tests.
export const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
export const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
export const TOKEN = 'a'.repeat(64);
export const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${TOKEN}`;
export const OFFER_ID = '9b2c6b54-3a72-44d2-89e8-4979ad45e5f0';
export const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000201';

export const validSnapshot = () => ({
  media: {
    id: ASSET_ID,
    displayName: 'Example.MP4',
    extension: 'mp4',
    sizeBytes: 4096,
    kind: 'video',
  },
  subtitleTrack: null,
  playback: {
    id: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
    mimeType: 'video/mp4',
    byteLength: 4096,
  },
});

export const emptySnapshot = () => ({
  media: null,
  subtitleTrack: null,
  playback: null,
});

export const validCandidate = () => ({
  asset: { ...validSnapshot().media, displayName: 'Example.mp4' },
  contentIdentity: {
    algorithm: 'blake3-256',
    digest: 'b'.repeat(64),
    sizeBytes: 4096,
  },
});

export const activeProjectFixture = () => ({
  metadata: { id: PROJECT_ID, name: 'Fixture' },
  stateVersion: 7,
  media: [validSnapshot().media],
  tracks: [],
});
