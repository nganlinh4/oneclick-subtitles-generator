import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import {
  GEMINI_MODEL_IDS,
  getModelById,
  modelAcceptsMedia,
} from '../config/geminiModels';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const GEMINI_TASKS = Object.freeze([
  'transcribe',
  'translate',
  'analyzeSubtitles',
]);
export const GEMINI_EVENT_TYPES = Object.freeze([
  'chunk',
  'completed',
  'cancelled',
  'failed',
]);
export const GEMINI_THINKING_LEVELS = Object.freeze([
  'minimal',
  'low',
  'medium',
  'high',
]);
export const GEMINI_MEDIA_RESOLUTIONS = Object.freeze(['low', 'medium', 'high']);

const MAX_PROMPT_CHARACTERS = 1_048_576;
const MAX_SCHEMA_BYTES = 1_048_576;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096;
const MAX_PENDING_EVENTS = 4_096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 250_000;

const geminiTasks = new Set(GEMINI_TASKS);
const geminiModelIds = new Set(GEMINI_MODEL_IDS);
const jobKinds = new Set([
  'importMedia',
  'probeMedia',
  'processMedia',
  'generateWaveform',
  'downloadMedia',
  'transcribe',
  'translate',
  'analyzeSubtitles',
  'generateImage',
  'synthesizeNarration',
  'alignNarration',
  'renderVideo',
  'installEngine',
]);
const jobStates = new Set([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const requestKeys = new Set([
  'credentialId',
  'task',
  'model',
  'prompt',
  'systemInstruction',
  'maxOutputTokens',
  'thinkingLevel',
  'mediaResolution',
  'responseJsonSchema',
  'mediaAssetId',
]);
const handlerKeys = new Set([
  'onEvent',
  'onChunk',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
]);
const thinkingLevelWireValue = Object.freeze({
  minimal: 'MINIMAL',
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
  MINIMAL: 'MINIMAL',
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});
const mediaResolutionWireValue = Object.freeze({
  low: 'MEDIA_RESOLUTION_LOW',
  medium: 'MEDIA_RESOLUTION_MEDIUM',
  high: 'MEDIA_RESOLUTION_HIGH',
  MEDIA_RESOLUTION_LOW: 'MEDIA_RESOLUTION_LOW',
  MEDIA_RESOLUTION_MEDIUM: 'MEDIA_RESOLUTION_MEDIUM',
  MEDIA_RESOLUTION_HIGH: 'MEDIA_RESOLUTION_HIGH',
});
const usageFields = Object.freeze([
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
  'thoughtsTokenCount',
  'cachedContentTokenCount',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const characterCountWithin = (value, maximum) => {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    count += 1;
    if (count > maximum) return false;
  }
  return true;
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export class GeminiServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GeminiServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new GeminiServiceError(
  'invalidGeminiRequest',
  'The native Gemini request is invalid'
);

const invalidResponse = () => new GeminiServiceError(
  'invalidGeminiResponse',
  'The desktop host returned invalid Gemini job data'
);

const browserFallbackRequired = () => new GeminiServiceError(
  'browserGeminiFallbackRequired',
  'A browser-only Gemini fallback is required outside the desktop runtime'
);

const requireUuidV7 = (value) => {
  if (!isUuidV7(value)) throw invalidRequest();
  return value;
};

const requireBoundedString = (value, maximum, { nonBlank = false } = {}) => {
  if (typeof value !== 'string'
      || (nonBlank && value.trim().length === 0)
      || !characterCountWithin(value, maximum)) {
    throw invalidRequest();
  }
  return value;
};

const cloneJsonValue = (value, seen, counters, depth) => {
  if (depth > MAX_JSON_DEPTH || counters.nodes >= MAX_JSON_NODES) throw invalidRequest();
  counters.nodes += 1;

  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidRequest();
    return value;
  }
  if (typeof value !== 'object' || seen.has(value)) throw invalidRequest();

  seen.add(value);
  let clone;
  if (Array.isArray(value)) {
    clone = value.map((entry) => cloneJsonValue(entry, seen, counters, depth + 1));
  } else {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw invalidRequest();
    }
    clone = Object.create(null);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) throw invalidRequest();
      clone[key] = cloneJsonValue(descriptor.value, seen, counters, depth + 1);
    }
  }
  seen.delete(value);
  return clone;
};

const normalizeJsonSchema = (schema) => {
  const clone = cloneJsonValue(schema, new Set(), { nodes: 0 }, 0);
  let serialized;
  try {
    serialized = JSON.stringify(clone);
  } catch {
    throw invalidRequest();
  }
  if (typeof serialized !== 'string' || utf8ByteLength(serialized) > MAX_SCHEMA_BYTES) {
    throw invalidRequest();
  }
  return JSON.parse(serialized);
};

export const normalizeGeminiStartRequest = (request) => {
  if (!isPlainRecord(request)
      || Object.keys(request).some((key) => !requestKeys.has(key))) {
    throw invalidRequest();
  }

  if (!geminiTasks.has(request.task)
      || !geminiModelIds.has(request.model)
      || !modelAcceptsMedia(request.model)) {
    throw invalidRequest();
  }

  const model = getModelById(request.model);
  const normalized = {
    credentialId: requireUuidV7(request.credentialId),
    task: request.task,
    model: request.model,
    prompt: requireBoundedString(request.prompt, MAX_PROMPT_CHARACTERS, { nonBlank: true }),
    mediaAssetId: request.mediaAssetId ?? null,
  };
  if (normalized.mediaAssetId !== null) requireUuidV7(normalized.mediaAssetId);
  if (normalized.task === 'transcribe' && normalized.mediaAssetId === null) {
    throw invalidRequest();
  }

  if (request.systemInstruction !== undefined) {
    normalized.systemInstruction = requireBoundedString(
      request.systemInstruction,
      MAX_PROMPT_CHARACTERS
    );
  }
  if (request.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(request.maxOutputTokens)
        || request.maxOutputTokens < 1
        || request.maxOutputTokens > model.limits.outputTokens) {
      throw invalidRequest();
    }
    normalized.maxOutputTokens = request.maxOutputTokens;
  }
  if (request.thinkingLevel !== undefined) {
    const wireValue = thinkingLevelWireValue[request.thinkingLevel];
    if (wireValue === undefined) throw invalidRequest();
    normalized.thinkingLevel = wireValue;
  }
  if (request.mediaResolution !== undefined) {
    const wireValue = mediaResolutionWireValue[request.mediaResolution];
    if (wireValue === undefined) throw invalidRequest();
    normalized.mediaResolution = wireValue;
  }
  if (request.responseJsonSchema !== undefined) {
    normalized.responseJsonSchema = normalizeJsonSchema(request.responseJsonSchema);
  }

  return normalized;
};

export const normalizeJobSnapshot = (snapshot) => {
  const basisPoints = snapshot?.progress?.basisPoints;
  if (!isRecord(snapshot)
      || !isUuidV7(snapshot.id)
      || !jobKinds.has(snapshot.kind)
      || !jobStates.has(snapshot.state)
      || !isRecord(snapshot.progress)
      || !Number.isSafeInteger(basisPoints)
      || basisPoints < 0
      || basisPoints > 10_000
      || !Number.isSafeInteger(snapshot.sequence)
      || snapshot.sequence < 0) {
    throw invalidResponse();
  }

  const stateInvariantHolds = snapshot.state === 'queued'
    ? basisPoints === 0 && snapshot.sequence === 0
    : snapshot.state === 'succeeded'
      ? basisPoints === 10_000 && snapshot.sequence >= 2
      : snapshot.sequence >= 1;
  if (!stateInvariantHolds) throw invalidResponse();

  return Object.freeze({
    id: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    progress: Object.freeze({ basisPoints }),
    sequence: snapshot.sequence,
  });
};

const normalizeUsage = (usage) => {
  if (usage === null || usage === undefined) return null;
  if (!isRecord(usage)) throw invalidResponse();

  const normalized = {};
  for (const field of usageFields) {
    const value = usage[field];
    if (value !== null
        && (!Number.isSafeInteger(value) || value < 0)) {
      throw invalidResponse();
    }
    normalized[field] = value ?? null;
  }
  return Object.freeze(normalized);
};

const normalizeCommandError = (error) => {
  if (!isRecord(error)
      || typeof error.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
      || typeof error.message !== 'string'
      || !characterCountWithin(error.message, MAX_ERROR_MESSAGE_CHARACTERS)) {
    throw invalidResponse();
  }
  return Object.freeze({ code: error.code, message: error.message });
};

const requireResultText = (text) => {
  if (typeof text !== 'string' || utf8ByteLength(text) > MAX_RESULT_BYTES) {
    throw invalidResponse();
  }
  return text;
};

export const normalizeGeminiJobEvent = (value) => {
  if (!isRecord(value) || typeof value.event !== 'string') throw invalidResponse();

  switch (value.event) {
    case 'chunk':
      if (!isUuidV7(value.jobId)) throw invalidResponse();
      return Object.freeze({
        event: 'chunk',
        jobId: value.jobId,
        text: requireResultText(value.text),
      });
    case 'completed':
      return Object.freeze({
        event: 'completed',
        job: normalizeJobSnapshot(value.job),
        text: requireResultText(value.text),
        usage: normalizeUsage(value.usage),
      });
    case 'cancelled':
      return Object.freeze({
        event: 'cancelled',
        job: normalizeJobSnapshot(value.job),
      });
    case 'failed':
      return Object.freeze({
        event: 'failed',
        job: value.job == null ? null : normalizeJobSnapshot(value.job),
        error: normalizeCommandError(value.error),
      });
    default:
      throw invalidResponse();
  }
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!isPlainRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))) {
    throw invalidRequest();
  }
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(handlers).filter(([, handler]) => handler !== undefined)
  ));
};

/**
 * Native Gemini bridge. This module has no provider URL, `fetch`, localStorage access, or API-key
 * parameter. The only provider selector crossing the WebView boundary is an opaque credential ID.
 */
export const createNativeGeminiService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const startGeminiJob = async (request, rawHandlers) => {
    const normalizedRequest = normalizeGeminiStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const pendingEvents = [];
    let initial = null;
    let terminal = false;
    let cumulativeChunkBytes = 0;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const reportHandlerError = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const diagnosticResult = handlers.onHandlerError(error);
          if (diagnosticResult && typeof diagnosticResult.catch === 'function') {
            diagnosticResult.catch(() => undefined);
          }
        } catch {
          // A diagnostic callback cannot be allowed to break Tauri's Channel callback.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') {
          result.catch(reportHandlerError);
        }
      } catch (error) {
        reportHandlerError(error);
      }
    };

    const protocolFailure = (error = invalidResponse()) => {
      safelyCall(handlers.onProtocolError, error);
    };

    const dispatch = (event) => {
      if (terminal) {
        protocolFailure();
        return;
      }

      const eventJobId = event.event === 'chunk' ? event.jobId : event.job?.id;
      if (eventJobId !== undefined && eventJobId !== null && eventJobId !== initial.id) {
        protocolFailure();
        return;
      }
      if (event.event === 'chunk') {
        cumulativeChunkBytes += utf8ByteLength(event.text);
        if (cumulativeChunkBytes > MAX_RESULT_BYTES) {
          protocolFailure();
          return;
        }
      } else if (event.event === 'completed'
          || event.event === 'cancelled'
          || event.event === 'failed') {
        terminal = true;
        activeChannels.delete(initial.id);
      }

      safelyCall(handlers.onEvent, event);
      if (event.event === 'chunk') safelyCall(handlers.onChunk, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();
    channel.onmessage = (rawEvent) => {
      let event;
      try {
        event = normalizeGeminiJobEvent(rawEvent);
      } catch (error) {
        protocolFailure(error);
        return;
      }

      if (initial === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          protocolFailure();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeJobSnapshot(await invokeCommand('gemini_start', {
        request: normalizedRequest,
        onEvent: channel,
      }));
    } catch (error) {
      pendingEvents.length = 0;
      throw error;
    }

    if (snapshot.kind !== normalizedRequest.task) throw invalidResponse();
    initial = snapshot;
    activeChannels.set(snapshot.id, channel);
    pendingEvents.splice(0).forEach(dispatch);
    if (terminal) activeChannels.delete(snapshot.id);
    return snapshot;
  };

  const cancelGeminiJob = async (jobId) => {
    const id = requireUuidV7(jobId);
    const snapshot = normalizeJobSnapshot(await invokeCommand('job_cancel', { id }));
    if (snapshot.id !== id) throw invalidResponse();
    return snapshot;
  };

  const runGeminiWithBrowserFallback = ({
    nativeRequest,
    handlers,
    browserFallback,
  } = {}) => {
    if (isNativeRuntime()) {
      // A native invocation never falls back after an error: doing so would expose a credential or
      // contact Gemini from the WebView precisely when the privileged path is unavailable.
      return startGeminiJob(nativeRequest, handlers);
    }
    if (typeof browserFallback !== 'function') return Promise.reject(browserFallbackRequired());
    return Promise.resolve().then(browserFallback);
  };

  return Object.freeze({
    startGeminiJob,
    cancelGeminiJob,
    runGeminiWithBrowserFallback,
  });
};

const geminiService = createNativeGeminiService();

export const startGeminiJob = geminiService.startGeminiJob;
export const cancelGeminiJob = geminiService.cancelGeminiJob;
export const runGeminiWithBrowserFallback = geminiService.runGeminiWithBrowserFallback;
