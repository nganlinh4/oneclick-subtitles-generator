import { downloadAudioSource } from './audioDownload';

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;

test('exports native reference audio by artifact ID without fetching its playback URL', async () => {
  const exportNative = vi.fn(async () => true);
  const fetchAudio = vi.fn(() => {
    throw new Error('WebView fetch must remain unreachable');
  });
  const referenceAudio = {
    nativeArtifactId: ARTIFACT_ID,
    filename: `osg-speech-artifact:${ARTIFACT_ID}`,
    format: 'wav',
  };

  await expect(downloadAudioSource(PLAYBACK_URL, referenceAudio, {
    exportNative,
    fetchAudio,
  })).resolves.toBe(true);
  expect(exportNative).toHaveBeenCalledWith(referenceAudio);
  expect(fetchAudio).not.toHaveBeenCalled();
});

test('propagates native dialog cancellation without falling back to browser bytes', async () => {
  const exportNative = vi.fn(async () => false);
  const fetchAudio = vi.fn();
  const referenceAudio = {
    nativeArtifactId: ARTIFACT_ID,
    filename: `osg-speech-artifact:${ARTIFACT_ID}`,
    format: 'wav',
  };

  await expect(downloadAudioSource(PLAYBACK_URL, referenceAudio, {
    exportNative,
    fetchAudio,
  })).resolves.toBe(false);
  expect(fetchAudio).not.toHaveBeenCalled();
});

test('rejects an unbound native playback capability before browser fetch', async () => {
  const fetchAudio = vi.fn();
  await expect(downloadAudioSource(PLAYBACK_URL, null, { fetchAudio }))
    .rejects.toThrow('requires an artifact capability');
  expect(fetchAudio).not.toHaveBeenCalled();
});

test('keeps the browser blob download used by generated background music', async () => {
  const blob = new Blob(['music'], { type: 'audio/wav' });
  const fetchAudio = vi.fn(async () => ({ blob: async () => blob }));
  const createObjectUrl = vi.fn(() => 'blob:download');
  const revokeObjectUrl = vi.fn();
  const anchor = { click: vi.fn() };

  await expect(downloadAudioSource('blob:recording', { filename: 'background_music.wav' }, {
    fetchAudio,
    createObjectUrl,
    revokeObjectUrl,
    createAnchor: () => anchor,
  })).resolves.toBe(true);
  expect(fetchAudio).toHaveBeenCalledWith('blob:recording', undefined);
  expect(createObjectUrl).toHaveBeenCalledWith(blob);
  expect(anchor).toMatchObject({
    href: 'blob:download',
    download: 'background_music.wav',
  });
  expect(anchor.click).toHaveBeenCalledTimes(1);
  expect(revokeObjectUrl).toHaveBeenCalledWith('blob:download');
});
