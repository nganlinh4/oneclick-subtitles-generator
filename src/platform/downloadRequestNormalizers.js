// Validation of the WebView's own download requests and handler bags before they reach the host.
import {
  audioFormats,
  characterCountWithin,
  cookieSources,
  hasControlCharacter,
  invalidRequest,
  isFormatId,
  isLanguage,
  MAX_URL_CHARACTERS,
  subtitleSources,
} from './downloadServiceContract';
import { exactRecord, isUuidVersion, snapshotDataRecord } from './nativeDataSnapshot';

export const normalizeInspectRequest = (request) => {
  const data = exactRecord(request, ['url', 'cookieSource'], invalidRequest);
  if (!characterCountWithin(data.url, MAX_URL_CHARACTERS)
      || data.url.length === 0
      || data.url.includes('\\')
      || hasControlCharacter(data.url)
      || !cookieSources.has(data.cookieSource)) {
    throw invalidRequest();
  }
  return data;
};

const normalizeQualityRequest = (quality, kind) => {
  const data = snapshotDataRecord(quality, {
    required: ['mode'],
    allowed: ['mode', 'height', 'formatId'],
    failure: invalidRequest,
  });
  if (typeof data.mode !== 'string') throw invalidRequest();
  if (data.mode === 'best' && Object.keys(data).length === 1) {
    return Object.freeze({ mode: 'best' });
  }
  if (kind === 'video'
      && data.mode === 'atMost'
      && Object.keys(data).length === 2 && Object.hasOwn(data, 'height')
      && Number.isInteger(data.height)
      && data.height >= 144
      && data.height <= 4_320) {
    return Object.freeze({ mode: 'atMost', height: data.height });
  }
  if (data.mode === 'exact'
      && Object.keys(data).length === 2 && Object.hasOwn(data, 'formatId')
      && isFormatId(data.formatId)) {
    return Object.freeze({ mode: 'exact', formatId: data.formatId });
  }
  throw invalidRequest();
};

const normalizeMediaRequest = (media) => {
  const data = snapshotDataRecord(media, {
    required: ['kind', 'quality'],
    allowed: ['kind', 'quality', 'format'],
    failure: invalidRequest,
  });
  if (data.kind !== 'video' && data.kind !== 'audio') {
    throw invalidRequest();
  }
  if (data.kind === 'video' && Object.keys(data).length === 2) {
    return Object.freeze({
      kind: 'video',
      quality: normalizeQualityRequest(data.quality, 'video'),
    });
  }
  if (data.kind === 'audio'
      && Object.keys(data).length === 3 && Object.hasOwn(data, 'format')
      && audioFormats.has(data.format)) {
    return Object.freeze({
      kind: 'audio',
      quality: normalizeQualityRequest(data.quality, 'audio'),
      format: data.format,
    });
  }
  throw invalidRequest();
};

export const normalizeStartRequest = (request) => {
  const data = exactRecord(request, ['inventoryId', 'media', 'subtitle'], invalidRequest);
  const subtitle = data.subtitle === null
    ? null
    : exactRecord(data.subtitle, ['language', 'source'], invalidRequest);
  if (!isUuidVersion(data.inventoryId, 7)
      || (subtitle !== null
        && (!isLanguage(subtitle.language) || !subtitleSources.has(subtitle.source)))) {
    throw invalidRequest();
  }
  return Object.freeze({
    inventoryId: data.inventoryId,
    media: normalizeMediaRequest(data.media),
    subtitle,
  });
};

export const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const keys = ['onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError'];
  const data = snapshotDataRecord(handlers, {
    required: [],
    allowed: keys,
    failure: invalidRequest,
  });
  for (const handler of Object.values(data)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return data;
};
