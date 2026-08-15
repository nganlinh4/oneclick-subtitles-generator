import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const LIVE_MUSIC_MODEL = 'models/lyria-realtime-exp';
export const LIVE_MUSIC_SAMPLE_RATE_HZ = 48_000;
export const LIVE_MUSIC_CHANNELS = 2;
export const LIVE_MUSIC_FORMAT = 'pcm16le';

const MAX_PROMPTS = 16;
const MAX_PROMPT_CHARACTERS = 512;
const MAX_TOTAL_PROMPT_CHARACTERS = 4_096;
const MAX_PCM_BYTES = 512 * 1024;
const MAX_PENDING_PCM_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_EVENTS = 64;
const MAX_NOTICE_CHARACTERS = 2_048;
const controls = new Set(['play', 'pause', 'stop', 'resetContext']);
const providerControls = new Set(['PLAY', 'PAUSE', 'STOP', 'RESET_CONTEXT']);
const commandFailureCodes = new Set([
  'internal',
  'invalidInput',
  'credentialStoreUnavailable',
  'credentialStoreLocked',
  'credentialNotFound',
  'invalidCredential',
  'credentialPurposeMismatch',
  'emptyCredential',
  'credentialVerificationFailed',
  'credentialStoreFailure',
  'database',
]);
const eventFailureMessages = new Map([
  ['liveMusicTimedOut', 'The native live music session timed out.'],
  ['liveMusicProtocolFailed', 'The live music provider returned an invalid response.'],
  ['invalidLiveMusicPrompts', 'The native live music prompts are invalid.'],
  ['liveMusicUnavailable', 'The native live music service is unavailable.'],
  ['liveMusicChannelClosed', 'The native live music output channel closed.'],
  ['liveMusicCancelled', 'The native live music session was cancelled.'],
]);
const requestKeys = new Set(['credentialId', 'weightedPrompts']);
const handlerKeys = new Set([
  'onEvent',
  'onAudio',
  'onReady',
  'onControlApplied',
  'onFilteredPrompt',
  'onWarning',
  'onClosed',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const characterCountWithin = (value, maximum) => {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const character of value) {
    count += character.length > 0 ? 1 : 0;
    if (count > maximum) return false;
  }
  return true;
};

export class LiveMusicServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveMusicServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new LiveMusicServiceError(
  'invalidLiveMusicRequest',
  'The native live music request is invalid'
);

const invalidResponse = () => new LiveMusicServiceError(
  'invalidLiveMusicResponse',
  'The desktop host returned invalid live music data'
);

const commandFailed = (code = 'liveMusicCommandFailed') => new LiveMusicServiceError(
  code,
  'The native live music operation could not be completed'
);

const redactCommandFailure = (error) => {
  let code;
  try {
    code = error?.code;
  } catch {
    code = undefined;
  }
  return commandFailed(commandFailureCodes.has(code) ? code : undefined);
};

const unavailable = () => new LiveMusicServiceError(
  'nativeLiveMusicUnavailable',
  'Native live music requires the desktop runtime'
);

const requireSessionId = (value) => {
  if (!isUuidV7(value)) throw invalidRequest();
  return value;
};

const hasOnlyKeys = (value, keys) => Object.keys(value).every((key) => keys.has(key));

export const normalizeWeightedPrompts = (value) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROMPTS) {
    throw invalidRequest();
  }
  let totalCharacters = 0;
  const normalized = value.map((prompt) => {
    if (!isPlainRecord(prompt)
        || Object.keys(prompt).some((key) => key !== 'text' && key !== 'weight')
        || !characterCountWithin(prompt.text, MAX_PROMPT_CHARACTERS)
        || prompt.text.trim().length === 0
        || typeof prompt.weight !== 'number'
        || !Number.isFinite(prompt.weight)
        || prompt.weight <= 0
        || prompt.weight > 2) {
      throw invalidRequest();
    }
    totalCharacters += Array.from(prompt.text).length;
    if (totalCharacters > MAX_TOTAL_PROMPT_CHARACTERS) throw invalidRequest();
    return Object.freeze({ text: prompt.text, weight: prompt.weight });
  });
  return Object.freeze(normalized);
};

const normalizeStartRequest = (request) => {
  if (!isPlainRecord(request)
      || Object.keys(request).some((key) => !requestKeys.has(key))) {
    throw invalidRequest();
  }
  return Object.freeze({
    credentialId: requireSessionId(request.credentialId),
    weightedPrompts: normalizeWeightedPrompts(request.weightedPrompts),
  });
};

export const normalizeLiveMusicSession = (value) => {
  if (!isRecord(value)
      || !hasOnlyKeys(value, new Set(['id', 'model', 'sampleRateHz', 'channels', 'format']))
      || !isUuidV7(value.id)
      || value.model !== LIVE_MUSIC_MODEL
      || value.sampleRateHz !== LIVE_MUSIC_SAMPLE_RATE_HZ
      || value.channels !== LIVE_MUSIC_CHANNELS
      || value.format !== LIVE_MUSIC_FORMAT) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: value.id,
    model: value.model,
    sampleRateHz: value.sampleRateHz,
    channels: value.channels,
    format: value.format,
  });
};

const boundedNotice = (value, maximum = MAX_NOTICE_CHARACTERS) => {
  if (!characterCountWithin(value, maximum) || value.includes('\0')) throw invalidResponse();
  return value;
};

const normalizePublicError = (value) => {
  if (!isRecord(value)
      || !hasOnlyKeys(value, new Set(['code', 'message']))
      || Object.keys(value).length !== 2
      || typeof value.code !== 'string') {
    throw invalidResponse();
  }
  boundedNotice(value.message);
  const message = eventFailureMessages.get(value.code);
  return Object.freeze({
    code: message === undefined ? 'liveMusicCommandFailed' : value.code,
    message: message ?? 'The native live music operation could not be completed',
  });
};

export const normalizeLiveMusicEvent = (value) => {
  if (!isRecord(value) || typeof value.event !== 'string' || !isUuidV7(value.sessionId)) {
    throw invalidResponse();
  }
  switch (value.event) {
    case 'ready':
    case 'closed':
      if (!hasOnlyKeys(value, new Set(['event', 'sessionId']))) throw invalidResponse();
      return Object.freeze({ event: value.event, sessionId: value.sessionId });
    case 'controlApplied':
      if (!hasOnlyKeys(value, new Set(['event', 'sessionId', 'control']))
          || !providerControls.has(value.control)) throw invalidResponse();
      return Object.freeze({
        event: value.event,
        sessionId: value.sessionId,
        control: value.control,
      });
    case 'filteredPrompt':
      if (!hasOnlyKeys(value, new Set(['event', 'sessionId', 'text', 'reason']))) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: value.event,
        sessionId: value.sessionId,
        text: boundedNotice(value.text, MAX_PROMPT_CHARACTERS),
        reason: boundedNotice(value.reason),
      });
    case 'warning':
      if (!hasOnlyKeys(value, new Set(['event', 'sessionId', 'message']))) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: value.event,
        sessionId: value.sessionId,
        message: boundedNotice(value.message),
      });
    case 'failed':
      if (!hasOnlyKeys(value, new Set(['event', 'sessionId', 'error']))) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: value.event,
        sessionId: value.sessionId,
        error: normalizePublicError(value.error),
      });
    default:
      throw invalidResponse();
  }
};

export const normalizePcmChunk = (value) => {
  if (!(value instanceof ArrayBuffer)
      || value.byteLength < 4
      || value.byteLength > MAX_PCM_BYTES
      || value.byteLength % 4 !== 0) {
    throw invalidResponse();
  }
  return value;
};

const normalizeHandlers = (handlers = {}) => {
  if (!isPlainRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => handler !== undefined && typeof handler !== 'function')) {
    throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

/**
 * Native-only live music bridge. It accepts only an opaque credential UUID and
 * receives PCM through Tauri raw Channels; there is no browser transport or
 * secret-bearing fallback in this module.
 */
export const createNativeLiveMusicService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
  createOperationId = uuidv7,
} = {}) => {
  let active = null;

  const safelyCall = (handlers, name, argument) => {
    const handler = handlers[name];
    if (typeof handler !== 'function') return;
    if (name === 'onHandlerError') {
      try {
        const result = handler(argument);
        result?.catch?.(() => undefined);
      } catch {
        // The diagnostic callback is the end of the presentation error chain.
      }
      return;
    }
    const report = (error) => {
      if (typeof handlers.onHandlerError !== 'function') return;
      try {
        const result = handlers.onHandlerError(error);
        result?.catch?.(() => undefined);
      } catch {
        // Diagnostic callbacks never control the provider session.
      }
    };
    try {
      const result = handler(argument);
      result?.catch?.(report);
    } catch (error) {
      report(error);
    }
  };

  const reportProtocolFailure = (handlers, error = invalidResponse()) => {
    safelyCall(handlers, 'onProtocolError', error);
  };

  const closeOwnerOnce = (owner) => {
    if (owner.closePromise === null) {
      owner.closing = true;
      let invocation;
      try {
        invocation = invokeCommand(
          'live_music_close',
          { startOperationId: owner.startOperationId },
        );
      } catch (error) {
        invocation = Promise.reject(error);
      }
      owner.closePromise = Promise.resolve(invocation).catch((error) => {
        const failure = redactCommandFailure(error);
        if (!owner.terminal) {
          owner.closing = false;
          owner.closePromise = null;
        }
        throw failure;
      });
    }
    return owner.closePromise;
  };

  const clearOwner = (owner) => {
    if (active === owner) active = null;
  };

  const startSession = async (request, rawHandlers = {}) => {
    if (!isNativeRuntime()) throw unavailable();
    if (active !== null) throw new LiveMusicServiceError(
      'liveMusicSessionActive',
      'A native live music session is already active'
    );
    const normalizedRequest = normalizeStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const startOperationId = createOperationId();
    if (!isUuidV7(startOperationId)) throw invalidRequest();
    const pendingEvents = [];
    const pendingAudio = [];
    let pendingAudioBytes = 0;
    let session = null;
    let terminal = false;
    let protocolFailed = false;
    let owner = null;
    let rollbackPromise = null;

    const rollbackStartOnce = () => {
      if (rollbackPromise === null) {
        let invocation;
        try {
          invocation = invokeCommand('live_music_rollback_start', { startOperationId });
        } catch (error) {
          invocation = Promise.reject(error);
        }
        rollbackPromise = Promise.resolve(invocation).then((rolledBack) => {
          if (typeof rolledBack !== 'boolean') throw invalidResponse();
          return rolledBack;
        }).catch((error) => {
          if (error instanceof LiveMusicServiceError) throw error;
          throw redactCommandFailure(error);
        });
      }
      return rollbackPromise;
    };

    const terminateForProtocol = (error = invalidResponse()) => {
      if (terminal || protocolFailed) return;
      protocolFailed = true;
      terminal = true;
      pendingEvents.length = 0;
      pendingAudio.length = 0;
      pendingAudioBytes = 0;
      reportProtocolFailure(handlers, error);
      if (owner !== null) {
        owner.terminal = true;
        clearOwner(owner);
        void closeOwnerOnce(owner).catch((cleanupError) => {
          safelyCall(owner.handlers, 'onHandlerError', cleanupError);
        });
      }
    };

    const dispatchEvent = (event) => {
      if (terminal) return;
      if (event.sessionId !== session.id) {
        terminateForProtocol();
        return;
      }
      safelyCall(handlers, 'onEvent', event);
      const callback = {
        ready: 'onReady',
        controlApplied: 'onControlApplied',
        filteredPrompt: 'onFilteredPrompt',
        warning: 'onWarning',
        closed: 'onClosed',
        failed: 'onFailed',
      }[event.event];
      safelyCall(handlers, callback, event);
      if (event.event === 'closed' || event.event === 'failed') {
        terminal = true;
        if (owner !== null) {
          owner.terminal = true;
          clearOwner(owner);
        }
      }
    };

    const dispatchAudio = (chunk) => {
      if (terminal) return;
      safelyCall(handlers, 'onAudio', chunk);
    };

    const eventChannel = new ChannelConstructor();
    eventChannel.onmessage = (rawEvent) => {
      let event;
      try {
        event = normalizeLiveMusicEvent(rawEvent);
      } catch (error) {
        terminateForProtocol(error);
        return;
      }
      if (terminal) return;
      if (session === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          terminateForProtocol();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatchEvent(event);
    };

    const audioChannel = new ChannelConstructor();
    audioChannel.onmessage = (rawChunk) => {
      let chunk;
      try {
        chunk = normalizePcmChunk(rawChunk);
      } catch (error) {
        terminateForProtocol(error);
        return;
      }
      if (terminal) return;
      if (session === null) {
        pendingAudioBytes += chunk.byteLength;
        if (pendingAudioBytes > MAX_PENDING_PCM_BYTES) {
          terminateForProtocol();
          return;
        }
        pendingAudio.push(chunk);
        return;
      }
      dispatchAudio(chunk);
    };

    let rawSnapshot;
    try {
      rawSnapshot = await invokeCommand('live_music_start', {
        startOperationId,
        request: normalizedRequest,
        onEvent: eventChannel,
        onAudio: audioChannel,
      });
    } catch (error) {
      terminal = true;
      pendingEvents.length = 0;
      pendingAudio.length = 0;
      eventChannel.onmessage = () => undefined;
      audioChannel.onmessage = () => undefined;
      throw redactCommandFailure(error);
    }
    let snapshot;
    try {
      snapshot = normalizeLiveMusicSession(rawSnapshot);
    } catch (error) {
      terminal = true;
      pendingEvents.length = 0;
      pendingAudio.length = 0;
      pendingAudioBytes = 0;
      eventChannel.onmessage = () => undefined;
      audioChannel.onmessage = () => undefined;
      await rollbackStartOnce().catch((cleanupError) => {
        safelyCall(handlers, 'onHandlerError', cleanupError);
      });
      throw error;
    }
    session = snapshot;
    owner = {
      session,
      startOperationId,
      eventChannel,
      audioChannel,
      handlers,
      closing: false,
      terminal: false,
      closePromise: null,
    };
    if (protocolFailed) {
      await closeOwnerOnce(owner).catch((cleanupError) => {
        safelyCall(owner.handlers, 'onHandlerError', cleanupError);
      });
      throw invalidResponse();
    }
    active = owner;
    pendingEvents.splice(0).forEach(dispatchEvent);
    pendingAudio.splice(0).forEach(dispatchAudio);
    if (protocolFailed) {
      await closeOwnerOnce(owner).catch((cleanupError) => {
        safelyCall(owner.handlers, 'onHandlerError', cleanupError);
      });
      throw invalidResponse();
    }
    if (terminal) clearOwner(owner);
    return session;
  };

  const invokeForSession = async (command, sessionId, extra = {}) => {
    if (!isNativeRuntime()) throw unavailable();
    const id = requireSessionId(sessionId);
    if (active?.session?.id !== id || active.terminal || active.closing) throw invalidRequest();
    try {
      return await invokeCommand(command, { sessionId: id, ...extra });
    } catch (error) {
      throw redactCommandFailure(error);
    }
  };

  const updatePrompts = (sessionId, weightedPrompts) => invokeForSession(
    'live_music_update',
    sessionId,
    { weightedPrompts: normalizeWeightedPrompts(weightedPrompts) }
  );

  const applyControl = (sessionId, control) => {
    if (!controls.has(control)) throw invalidRequest();
    return invokeForSession('live_music_control', sessionId, { control });
  };

  const closeSession = async (sessionId) => {
    if (!isNativeRuntime()) throw unavailable();
    const id = requireSessionId(sessionId);
    const owner = active;
    if (owner?.session?.id !== id || owner.terminal) throw invalidRequest();
    await closeOwnerOnce(owner);
  };

  return Object.freeze({
    startSession,
    updatePrompts,
    applyControl,
    closeSession,
    getActiveSession: () => active?.session ?? null,
  });
};

const liveMusicService = createNativeLiveMusicService();

export const startLiveMusicSession = liveMusicService.startSession;
export const updateLiveMusicPrompts = liveMusicService.updatePrompts;
export const applyLiveMusicControl = liveMusicService.applyControl;
export const closeLiveMusicSession = liveMusicService.closeSession;
export const getActiveLiveMusicSession = liveMusicService.getActiveSession;
