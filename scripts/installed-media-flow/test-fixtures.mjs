// A complete accepted installed media-flow result and the identities the media-flow tests vary.

const DOWNLOAD_JOB_A = '019ff572-2140-7ba1-8e9c-5a29894963bf';
const DOWNLOAD_JOB_B = '019ff572-2141-7ba1-8e9c-5a29894963bf';
const PRIOR_ASSET_ID = '019ff572-2131-7ba1-9e9c-5a29894963bf';

const TOOL = (id, version) => ({
  activeRuntime: true,
  availableInstalledBytes: 2_048,
  availableVersion: version,
  deliveryAvailable: true,
  downloadBytes: 1_024,
  id,
  installed: true,
  installedBytes: 2_048,
  label: ({
    deno: 'Deno',
    'media-tools': 'FFmpeg and FFprobe',
    'yt-dlp': 'yt-dlp',
  })[id] ?? 'Unreviewed tool',
  operation: null,
  pendingRemoval: false,
  restartRequired: false,
  state: 'installed',
  version,
});

const validResult = () => ({
  assetId: '019ff572-2132-7ba1-9e9c-5a29894963bf',
  currentFileName: 'trailer.mp4',
  currentFileUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
  errorToastMessages: [],
  jobs: [
    {
      id: DOWNLOAD_JOB_A,
      kind: 'downloadMedia',
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
    },
  ],
  playbackBytes: {
    byteLength: 366_888,
    sha256: 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db',
  },
  session: {
    media: {
      displayName: 'trailer.mp4',
      extension: 'mp4',
      id: '019ff572-2132-7ba1-9e9c-5a29894963bf',
      kind: 'video',
      sizeBytes: 366_888,
    },
    playback: {
      byteLength: 366_888,
      id: '01111111-2222-4333-8444-555555555555',
      mimeType: 'video/mp4',
      playbackUrl: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
    },
    subtitleTrack: null,
  },
  subtitleMarkerVisible: true,
  tools: {
    schemaVersion: 1,
    tools: [
      TOOL('media-tools', '8.1.2'),
      TOOL('yt-dlp', '2026.07.04'),
      TOOL('deno', '2.9.5'),
    ],
  },
  uploadedSrtInfo: {
    cacheId: 'site_fixture_project_alias',
    fileName: 'osg-installed-media-smoke.srt',
    v: 2,
  },
  workspace: {
    schemaVersion: 1,
    cacheId: 'site_fixture_project_alias',
    projectId: '019ff572-2133-7ba1-9e9c-5a29894963bf',
    mediaId: '019ff572-2132-7ba1-9e9c-5a29894963bf',
    trackId: null,
    projectStateVersion: 2,
  },
  video: {
    currentSrc: 'http://127.0.0.1:43123/asset/01111111-2222-4333-8444-555555555555?token=' + 'a'.repeat(64),
    duration: 4,
    height: 360,
    paused: true,
    readyState: 4,
    width: 640,
  },
});

export { DOWNLOAD_JOB_A, DOWNLOAD_JOB_B, PRIOR_ASSET_ID, TOOL, validResult };
