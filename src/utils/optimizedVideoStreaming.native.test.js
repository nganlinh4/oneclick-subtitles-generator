import { preloadVideoChunks } from './optimizedVideoStreaming';

const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;

test('never preloads a native playback capability through fetch', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  await preloadVideoChunks(PLAYBACK_URL, 10, 120);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
