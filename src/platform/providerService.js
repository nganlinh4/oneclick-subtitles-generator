import { validate as validateUuid, version as uuidVersion } from 'uuid';

import {
  getCredentialStateSnapshot,
  initializeCredentialState,
  refreshCredentialState,
  upsertSingletonCredential,
} from './credentialStateController';
import { invokeDesktop } from './desktopRuntime';

const MAX_QUERY_CHARACTERS = 500;
const MAX_LYRICS_CHARACTERS = 1_000_000;
const MAX_RESULTS = 50;
const MAX_TITLE_CHARACTERS = 1_000;
const MAX_DESCRIPTION_CHARACTERS = 50_000;
const MAX_CHANNEL_CHARACTERS = 1_000;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => (
  isRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

export class NativeProviderServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeProviderServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new NativeProviderServiceError(
  'invalidProviderRequest',
  'The provider request is invalid'
);

const invalidResponse = () => new NativeProviderServiceError(
  'invalidProviderResponse',
  'The desktop host returned invalid provider data'
);

const compatibleFailureMessage = (code) => {
  if (code === 'youtubeQuotaExceeded') return 'quota exceeded';
  if (code === 'youtubeApiNotEnabled') return 'api not enabled';
  if (code === 'youtubeAuthenticationRequired' || code === 'credentialNotFound') {
    return 'Not authenticated with YouTube';
  }
  return 'The native provider operation could not be completed';
};

const normalizeFailure = (error) => {
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'providerCommandFailed';
  return new NativeProviderServiceError(code, compatibleFailureMessage(code));
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const requireText = (value, maximum) => {
  if (typeof value !== 'string'
      || value.trim().length === 0
      || Array.from(value.trim()).length > maximum) throw invalidRequest();
  return value.trim();
};

const requireReadyCredential = (snapshot, purpose) => {
  if (snapshot?.store !== 'available' || !Array.isArray(snapshot.credentials)) {
    throw new NativeProviderServiceError(
      'credentialStoreUnavailable',
      'The native credential store is unavailable'
    );
  }
  const credential = snapshot.credentials.find((candidate) => (
    candidate?.purpose === purpose
    && candidate?.state === 'ready'
    && isUuidV7(candidate?.id)
  ));
  if (!credential) {
    const message = purpose === 'geniusAccessToken'
      ? 'Genius API key not set. Please provide it through the settings.'
      : purpose === 'youtubeApiKey'
        ? 'YouTube API key not found'
        : 'Not authenticated with YouTube';
    throw new NativeProviderServiceError('credentialNotFound', message);
  }
  return credential.id;
};

const safeImageCapabilityUrl = (value) => {
  if (typeof value !== 'string' || value.length > 4_096) throw invalidResponse();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidResponse();
  }
  const path = url.pathname.split('/');
  const tokenEntries = [...url.searchParams.entries()];
  if (url.protocol !== 'http:'
      || url.hostname !== '127.0.0.1'
      || url.username
      || url.password
      || !/^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/.test(url.port)
      || url.hash
      || path.length !== 3
      || path[0] !== ''
      || path[1] !== 'asset'
      || !validateUuid(path[2])
      || uuidVersion(path[2]) !== 4
      || tokenEntries.length !== 1
      || tokenEntries[0][0] !== 'token'
      || !/^[a-f0-9]{64}$/.test(tokenEntries[0][1])) {
    throw invalidResponse();
  }
  return url.href;
};

const normalizeLyrics = (value) => {
  if (!exactKeys(value, ['lyrics', 'albumArtUrl'])
      || typeof value.lyrics !== 'string'
      || value.lyrics.length === 0
      || Array.from(value.lyrics).length > MAX_LYRICS_CHARACTERS
      || !(value.albumArtUrl === null || typeof value.albumArtUrl === 'string')) {
    throw invalidResponse();
  }
  const albumArtUrl = value.albumArtUrl === null
    ? ''
    : safeImageCapabilityUrl(value.albumArtUrl);
  return Object.freeze({ lyrics: value.lyrics, albumArtUrl });
};

const normalizeSearchResult = (value) => {
  if (!exactKeys(value, ['id', 'title', 'thumbnail', 'channel', 'url'])
      || typeof value.id !== 'string'
      || !YOUTUBE_ID.test(value.id)
      || typeof value.title !== 'string'
      || value.title.length === 0
      || Array.from(value.title).length > MAX_TITLE_CHARACTERS
      || typeof value.channel !== 'string'
      || value.channel.length === 0
      || Array.from(value.channel).length > MAX_CHANNEL_CHARACTERS) throw invalidResponse();
  const thumbnail = safeImageCapabilityUrl(value.thumbnail);
  const expectedUrl = `https://www.youtube.com/watch?v=${value.id}`;
  if (value.url !== expectedUrl) throw invalidResponse();
  return Object.freeze({
    id: value.id,
    title: value.title,
    thumbnail,
    channel: value.channel,
    url: expectedUrl,
  });
};

const normalizeDetails = (value) => {
  if (value === null) return null;
  if (!exactKeys(value, [
    'id',
    'title',
    'description',
    'thumbnail',
    'channel',
    'publishedAt',
  ])
      || typeof value.id !== 'string'
      || !YOUTUBE_ID.test(value.id)
      || typeof value.title !== 'string'
      || value.title.length === 0
      || Array.from(value.title).length > MAX_TITLE_CHARACTERS
      || typeof value.description !== 'string'
      || Array.from(value.description).length > MAX_DESCRIPTION_CHARACTERS
      || typeof value.channel !== 'string'
      || value.channel.length === 0
      || Array.from(value.channel).length > MAX_CHANNEL_CHARACTERS
      || typeof value.publishedAt !== 'string'
      || value.publishedAt.length < 20
      || value.publishedAt.length > 35
      || value.publishedAt[4] !== '-'
      || value.publishedAt[7] !== '-'
      || value.publishedAt[10] !== 'T'
      || !(value.publishedAt.endsWith('Z') || value.publishedAt.includes('+'))) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: value.id,
    title: value.title,
    description: value.description,
    thumbnail: safeImageCapabilityUrl(value.thumbnail),
    channel: value.channel,
    publishedAt: value.publishedAt,
  });
};

const normalizeOAuthStatus = (value) => {
  if (!exactKeys(value, ['authenticated', 'expiresAtUnixMs'])
      || typeof value.authenticated !== 'boolean'
      || !((value.authenticated
        && Number.isSafeInteger(value.expiresAtUnixMs)
        && value.expiresAtUnixMs > 0)
        || (!value.authenticated && value.expiresAtUnixMs === null))) {
    throw invalidResponse();
  }
  return Object.freeze({
    authenticated: value.authenticated,
    expiresAtUnixMs: value.expiresAtUnixMs,
  });
};

export const createNativeProviderService = ({
  invokeCommand = invokeDesktop,
  initializeCredentials = initializeCredentialState,
  refreshCredentials = refreshCredentialState,
  credentialSnapshot = getCredentialStateSnapshot,
  upsertCredential = upsertSingletonCredential,
} = {}) => {
  const snapshot = async () => {
    await initializeCredentials();
    return credentialSnapshot();
  };

  const youtubeAuthentication = async (useOAuth) => {
    const current = await snapshot();
    if (useOAuth) {
      return {
        kind: 'oauth',
        clientCredentialId: requireReadyCredential(current, 'youtubeOauthClient'),
        tokenCredentialId: requireReadyCredential(current, 'youtubeOauthToken'),
      };
    }
    return {
      kind: 'apiKey',
      credentialId: requireReadyCredential(current, 'youtubeApiKey'),
    };
  };

  const invoke = async (command, args) => {
    try {
      return await invokeCommand(command, args);
    } catch (error) {
      if (error instanceof NativeProviderServiceError) throw error;
      throw normalizeFailure(error);
    }
  };

  const fetchGeniusLyrics = async ({ artist, song, force = false }) => {
    if (typeof force !== 'boolean') throw invalidRequest();
    const current = await snapshot();
    const credentialId = requireReadyCredential(current, 'geniusAccessToken');
    const result = await invoke('genius_lyrics', {
      credentialId,
      request: {
        artist: requireText(artist, 300),
        song: requireText(song, 300),
        force: force === true,
      },
    });
    return normalizeLyrics(result);
  };

  const searchYouTube = async ({ query, maxResults = 5, useOAuth = false }) => {
    const normalizedQuery = requireText(query, MAX_QUERY_CHARACTERS);
    if (typeof useOAuth !== 'boolean'
        || !Number.isSafeInteger(maxResults)
        || maxResults < 1
        || maxResults > MAX_RESULTS) {
      throw invalidRequest();
    }
    const result = await invoke('youtube_search', {
      request: {
        authentication: await youtubeAuthentication(useOAuth),
        query: normalizedQuery,
        maxResults,
      },
    });
    if (!Array.isArray(result) || result.length > maxResults) throw invalidResponse();
    return Object.freeze(result.map(normalizeSearchResult));
  };

  const getYouTubeVideoDetails = async ({ videoId, useOAuth = false }) => {
    if (typeof useOAuth !== 'boolean'
        || typeof videoId !== 'string'
        || !YOUTUBE_ID.test(videoId)) throw invalidRequest();
    return normalizeDetails(await invoke('youtube_video_details', {
      request: {
        authentication: await youtubeAuthentication(useOAuth),
        videoId,
      },
    }));
  };

  const getYouTubeThumbnail = async ({ videoId }) => {
    if (typeof videoId !== 'string' || !YOUTUBE_ID.test(videoId)) throw invalidRequest();
    return safeImageCapabilityUrl(await invoke('youtube_thumbnail', { videoId }));
  };

  const authorizeYouTube = async ({ clientId, clientSecret }) => {
    const normalizedId = requireText(clientId, 16_384);
    const normalizedSecret = requireText(clientSecret, 16_384);
    let credentialId;
    try {
      credentialId = await upsertCredential('youtubeOauthClient', JSON.stringify({
        clientId: normalizedId,
        clientSecret: normalizedSecret,
      }));
    } catch (error) {
      throw normalizeFailure(error);
    }
    if (!isUuidV7(credentialId)) throw invalidResponse();
    const status = normalizeOAuthStatus(await invoke('youtube_oauth_authorize', {
      clientCredentialId: credentialId,
    }));
    await refreshCredentials();
    return status;
  };

  const getYouTubeOAuthStatus = async () => normalizeOAuthStatus(
    await invoke('youtube_oauth_status', {})
  );

  const cancelYouTubeOAuth = async () => {
    const cancelled = await invoke('youtube_oauth_cancel', {});
    if (typeof cancelled !== 'boolean') throw invalidResponse();
    return cancelled;
  };

  const clearYouTubeOAuth = async () => {
    const cleared = await invoke('youtube_oauth_clear', {});
    if (typeof cleared !== 'boolean') throw invalidResponse();
    await refreshCredentials();
    return cleared;
  };

  return Object.freeze({
    fetchGeniusLyrics,
    searchYouTube,
    getYouTubeVideoDetails,
    getYouTubeThumbnail,
    authorizeYouTube,
    getYouTubeOAuthStatus,
    cancelYouTubeOAuth,
    clearYouTubeOAuth,
  });
};

const providerService = createNativeProviderService();

export const fetchGeniusLyricsNative = providerService.fetchGeniusLyrics;
export const searchYouTubeNative = providerService.searchYouTube;
export const getYouTubeVideoDetailsNative = providerService.getYouTubeVideoDetails;
export const getYouTubeThumbnailNative = providerService.getYouTubeThumbnail;
export const authorizeYouTubeNative = providerService.authorizeYouTube;
export const getYouTubeOAuthStatusNative = providerService.getYouTubeOAuthStatus;
export const cancelYouTubeOAuthNative = providerService.cancelYouTubeOAuth;
export const clearYouTubeOAuthNative = providerService.clearYouTubeOAuth;
