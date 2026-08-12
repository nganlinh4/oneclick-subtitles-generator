import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;
const MAX_VERSION_LENGTH = 64;
const MAX_NOTES_LENGTH = 32 * 1024;
const MAX_UPDATE_EVENTS = 100_000;
const handlerKeys = new Set(['onChecking', 'onProgress', 'onInstalling']);

const isPlainRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, expected) => {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return actual.length === required.length
    && actual.every((key, index) => key === required[index]);
};

const isVersion = (value) => (
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_VERSION_LENGTH
  && VERSION_PATTERN.test(value)
);

const isSafeNotes = (value) => {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > MAX_NOTES_LENGTH) return false;
  return ![...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === 0
      || (codePoint < 32 && character !== '\n' && character !== '\r' && character !== '\t')
      || (codePoint >= 127 && codePoint <= 159);
  });
};

const isPublishedAt = (value) => {
  if (value === null) return true;
  if (typeof value !== 'string' || value.length > 64) return false;
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
};

export class UpdateServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UpdateServiceError';
    this.code = code;
  }
}

const invalidResponse = () => new UpdateServiceError(
  'invalidUpdateResponse',
  'The desktop host returned invalid update information'
);

const normalizeError = (error) => {
  if (error instanceof UpdateServiceError) return error;
  const code = typeof error?.code === 'string' && ERROR_CODE_PATTERN.test(error.code)
    ? error.code
    : 'updateCheckFailed';
  return new UpdateServiceError(code, 'The update check could not be completed');
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!isPlainRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
    throw new UpdateServiceError('invalidUpdateRequest', 'The update request is invalid');
  }
  return handlers;
};

const normalizeUpdateEvent = (value, expectedVersion) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  if (value.event === 'checking' || value.event === 'installing') {
    if (!hasExactKeys(value, ['event', 'version']) || value.version !== expectedVersion) {
      throw invalidResponse();
    }
    return Object.freeze({ event: value.event, version: value.version });
  }
  if (value.event === 'progress') {
    if (!hasExactKeys(value, ['event', 'downloadedBytes', 'totalBytes', 'basisPoints'])
        || !Number.isSafeInteger(value.downloadedBytes)
        || value.downloadedBytes < 0
        || (value.totalBytes !== null
          && (!Number.isSafeInteger(value.totalBytes)
            || value.totalBytes <= 0
            || value.downloadedBytes > value.totalBytes))
        || (value.basisPoints !== null
          && (!Number.isInteger(value.basisPoints)
            || value.basisPoints < 0
            || value.basisPoints > 10_000))) {
      throw invalidResponse();
    }
    const expectedBasisPoints = value.totalBytes === null
      ? null
      : Math.floor(Math.min(value.downloadedBytes, value.totalBytes) * 10_000 / value.totalBytes);
    if (expectedBasisPoints !== value.basisPoints) {
      throw invalidResponse();
    }
    return Object.freeze({ ...value });
  }
  throw invalidResponse();
};

const normalizeUpdate = (value) => {
  if (value === null) return null;
  if (!hasExactKeys(value, ['version', 'publishedAt', 'notes'])
      || !isVersion(value.version)
      || !isPublishedAt(value.publishedAt)
      || !isSafeNotes(value.notes)) {
    throw invalidResponse();
  }
  return Object.freeze({
    version: value.version,
    publishedAt: value.publishedAt,
    notes: value.notes,
  });
};

export const normalizeUpdateStatus = (value) => {
  if (!hasExactKeys(value, ['configured', 'currentVersion', 'update'])
      || typeof value.configured !== 'boolean'
      || !isVersion(value.currentVersion)) {
    throw invalidResponse();
  }
  const update = normalizeUpdate(value.update);
  if (!value.configured && update !== null) throw invalidResponse();
  return Object.freeze({
    configured: value.configured,
    currentVersion: value.currentVersion,
    update,
  });
};

export const checkDesktopUpdate = async ({
  nativeRuntime = isDesktopRuntime,
  invokeCommand = invokeDesktop,
} = {}) => {
  if (!nativeRuntime()) {
    throw new UpdateServiceError(
      'desktopRuntimeUnavailable',
      'Signed application updates require the desktop runtime'
    );
  }
  try {
    return normalizeUpdateStatus(await invokeCommand('app_update_check'));
  } catch (error) {
    throw normalizeError(error);
  }
};

export const cancelDesktopUpdate = async (expectedVersion, {
  nativeRuntime = isDesktopRuntime,
  invokeCommand = invokeDesktop,
} = {}) => {
  if (!nativeRuntime() || !isVersion(expectedVersion)) {
    throw new UpdateServiceError('invalidUpdateRequest', 'The update request is invalid');
  }
  try {
    const cancelled = await invokeCommand('app_update_cancel', { expectedVersion });
    if (typeof cancelled !== 'boolean') throw invalidResponse();
    return cancelled;
  } catch (error) {
    throw normalizeError(error);
  }
};

export const installDesktopUpdate = async (expectedVersion, handlersInput, {
  signal,
  nativeRuntime = isDesktopRuntime,
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
} = {}) => {
  if (!nativeRuntime() || !isVersion(expectedVersion)) {
    throw new UpdateServiceError('invalidUpdateRequest', 'The update request is invalid');
  }
  const handlers = normalizeHandlers(handlersInput);
  if (signal !== undefined
      && (typeof signal !== 'object'
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
    throw new UpdateServiceError('invalidUpdateRequest', 'The update request is invalid');
  }
  if (signal?.aborted) {
    throw new UpdateServiceError('updaterCancelled', 'The application update was cancelled');
  }

  let eventCount = 0;
  let lastDownloaded = -1;
  let terminalPhase = false;
  let protocolError = null;
  const channel = new ChannelConstructor();
  channel.onmessage = (raw) => {
    if (protocolError !== null) return;
    try {
      eventCount += 1;
      if (eventCount > MAX_UPDATE_EVENTS) throw invalidResponse();
      const event = normalizeUpdateEvent(raw, expectedVersion);
      if (terminalPhase || (event.event === 'progress' && event.downloadedBytes < lastDownloaded)) {
        throw invalidResponse();
      }
      if (event.event === 'progress') lastDownloaded = event.downloadedBytes;
      if (event.event === 'installing') terminalPhase = true;
      if (event.event === 'checking') handlers.onChecking?.(event);
      if (event.event === 'progress') handlers.onProgress?.(event);
      if (event.event === 'installing') handlers.onInstalling?.(event);
    } catch {
      protocolError = invalidResponse();
      Promise.resolve(invokeCommand('app_update_cancel', { expectedVersion })).catch(() => undefined);
    }
  };

  const cancel = () => {
    Promise.resolve(invokeCommand('app_update_cancel', { expectedVersion })).catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    await invokeCommand('app_update_install', { expectedVersion, onEvent: channel });
    if (protocolError !== null) throw protocolError;
  } catch (error) {
    if (protocolError !== null) throw protocolError;
    throw normalizeError(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
};

export const getDesktopAppVersion = async ({
  nativeRuntime = isDesktopRuntime,
  invokeCommand = invokeDesktop,
} = {}) => {
  if (!nativeRuntime()) {
    throw new UpdateServiceError(
      'desktopRuntimeUnavailable',
      'Application version metadata requires the desktop runtime'
    );
  }
  try {
    const value = await invokeCommand('app_health');
    if (!hasExactKeys(value, ['appVersion', 'architecture', 'platform'])
        || !isVersion(value.appVersion)
        || typeof value.architecture !== 'string'
        || value.architecture.length === 0
        || value.architecture.length > 32
        || typeof value.platform !== 'string'
        || value.platform.length === 0
        || value.platform.length > 32) {
      throw invalidResponse();
    }
    return value.appVersion;
  } catch (error) {
    throw normalizeError(error);
  }
};
