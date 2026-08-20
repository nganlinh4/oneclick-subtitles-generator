import { createNativeProviderService } from './providerService';

vi.mock('./desktopRuntime', () => ({ invokeDesktop: vi.fn() }));
vi.mock('./credentialStateController', () => ({
  getCredentialStateSnapshot: vi.fn(),
  initializeCredentialState: vi.fn(),
  refreshCredentialState: vi.fn(),
  upsertSingletonCredential: vi.fn(),
}));

const GENIUS_ID = '01989aaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const API_KEY_ID = '01989bbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const CLIENT_ID = '01989ccc-cccc-7ccc-8ccc-cccccccccccc';
const TOKEN_ID = '01989ddd-dddd-7ddd-8ddd-dddddddddddd';
const IMAGE_CAPABILITY = 'http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const snapshot = {
  store: 'available',
  credentials: [
    { id: GENIUS_ID, purpose: 'geniusAccessToken', state: 'ready' },
    { id: API_KEY_ID, purpose: 'youtubeApiKey', state: 'ready' },
    { id: CLIENT_ID, purpose: 'youtubeOauthClient', state: 'ready' },
    { id: TOKEN_ID, purpose: 'youtubeOauthToken', state: 'ready' },
  ],
};

it('uses only opaque credential references and never browser provider transport', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'genius_lyrics') {
      return {
        lyrics: '[Verse]\nHello',
        albumArtUrl: IMAGE_CAPABILITY,
      };
    }
    if (command === 'youtube_search') {
      return [{
        id: 'AbCdEfGhI_1',
        title: 'Title',
        thumbnail: IMAGE_CAPABILITY,
        channel: 'Channel',
        url: 'https://www.youtube.com/watch?v=AbCdEfGhI_1',
      }];
    }
    if (command === 'youtube_video_details') {
      return {
        id: 'AbCdEfGhI_1',
        title: 'Details',
        description: 'Description',
        thumbnail: IMAGE_CAPABILITY,
        channel: 'Channel',
        publishedAt: '2026-08-10T00:00:00Z',
      };
    }
    if (command === 'youtube_thumbnail') return IMAGE_CAPABILITY;
    throw new Error('unexpected command');
  });
  const fetchBefore = global.fetch;
  global.fetch = vi.fn(() => {
    throw new Error('browser transport must not be used');
  });
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('native provider calls must not read localStorage');
  });
  const service = createNativeProviderService({
    invokeCommand,
    initializeCredentials: vi.fn().mockResolvedValue(snapshot),
    credentialSnapshot: () => snapshot,
  });

  await expect(service.fetchGeniusLyrics({
    artist: 'Artist',
    song: 'Song',
  })).resolves.toEqual({
    lyrics: '[Verse]\nHello',
    albumArtUrl: IMAGE_CAPABILITY,
  });
  await expect(service.searchYouTube({
    query: 'music',
    useOAuth: true,
  })).resolves.toHaveLength(1);
  await expect(service.getYouTubeVideoDetails({
    videoId: 'AbCdEfGhI_1',
  })).resolves.toEqual(expect.objectContaining({
    id: 'AbCdEfGhI_1',
    title: 'Details',
  }));
  await expect(service.getYouTubeThumbnail({
    videoId: 'AbCdEfGhI_1',
  })).resolves.toBe(IMAGE_CAPABILITY);

  expect(global.fetch).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalled();
  expect(invokeCommand).toHaveBeenCalledWith('genius_lyrics', {
    credentialId: GENIUS_ID,
    request: { artist: 'Artist', song: 'Song', force: false },
  });
  expect(invokeCommand).toHaveBeenCalledWith('youtube_search', {
    request: {
      authentication: {
        kind: 'oauth',
        clientCredentialId: CLIENT_ID,
        tokenCredentialId: TOKEN_ID,
      },
      query: 'music',
      maxResults: 5,
    },
  });
  expect(invokeCommand).toHaveBeenCalledWith('youtube_video_details', {
    request: {
      authentication: {
        kind: 'apiKey',
        credentialId: API_KEY_ID,
      },
      videoId: 'AbCdEfGhI_1',
    },
  });
  expect(invokeCommand).toHaveBeenCalledWith('youtube_thumbnail', {
    videoId: 'AbCdEfGhI_1',
  });

  getItem.mockRestore();
  global.fetch = fetchBefore;
});

it('vaults client credentials before starting native OAuth and returns only safe status', async () => {
  const upsertCredential = vi.fn().mockResolvedValue(CLIENT_ID);
  const invokeCommand = vi.fn().mockResolvedValue({
    authenticated: true,
    expiresAtUnixMs: 1_800_000_000_000,
  });
  const service = createNativeProviderService({
    invokeCommand,
    initializeCredentials: vi.fn().mockResolvedValue(snapshot),
    refreshCredentials: vi.fn().mockResolvedValue(snapshot),
    credentialSnapshot: () => snapshot,
    upsertCredential,
  });

  await expect(service.authorizeYouTube({
    clientId: 'native-client-id',
    clientSecret: 'native-client-secret',
  })).resolves.toEqual({
    authenticated: true,
    expiresAtUnixMs: 1_800_000_000_000,
  });
  expect(upsertCredential).toHaveBeenCalledWith(
    'youtubeOauthClient',
    JSON.stringify({
      clientId: 'native-client-id',
      clientSecret: 'native-client-secret',
    })
  );
  expect(invokeCommand).toHaveBeenCalledWith('youtube_oauth_authorize', {
    clientCredentialId: CLIENT_ID,
  });
});

it('rejects extra response fields before they can carry provider secrets', async () => {
  const service = createNativeProviderService({
    invokeCommand: vi.fn().mockResolvedValue({
      authenticated: true,
      expiresAtUnixMs: 1_800_000_000_000,
      accessToken: 'must-not-cross-ipc',
    }),
    initializeCredentials: vi.fn().mockResolvedValue(snapshot),
    credentialSnapshot: () => snapshot,
  });
  await expect(service.getYouTubeOAuthStatus()).rejects.toMatchObject({
    code: 'invalidProviderResponse',
  });
});

it.each([
  'https://i.ytimg.com/vi/AbCdEfGhI_1/default.jpg',
  'https://images.genius.com/cover.jpg',
  'http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000',
  'http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=short',
  'http://localhost:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
])('rejects non-capability provider image responses: %s', async (imageUrl) => {
  const service = createNativeProviderService({
    invokeCommand: vi.fn().mockResolvedValue({ lyrics: 'lyrics', albumArtUrl: imageUrl }),
    initializeCredentials: vi.fn().mockResolvedValue(snapshot),
    credentialSnapshot: () => snapshot,
  });
  await expect(service.fetchGeniusLyrics({ artist: 'A', song: 'B' })).rejects.toMatchObject({
    code: 'invalidProviderResponse',
  });
});
