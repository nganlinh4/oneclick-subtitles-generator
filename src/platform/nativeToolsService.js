import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const NATIVE_TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
export const NATIVE_TOOL_STATES = Object.freeze([
  'unavailable',
  'missing',
  'installed',
  'corrupt',
]);
export const NATIVE_TOOL_ACTIONS = Object.freeze(['install', 'remove']);
export const NATIVE_TOOL_PHASES = Object.freeze([
  'preparing',
  'downloading',
  'extracting',
  'publishing',
  'removing',
]);

const EXPECTED_LICENSES = Object.freeze({
  'media-tools': 'GPL-3.0-or-later',
  'yt-dlp': 'GPL-3.0-or-later',
  deno: 'MIT',
});
const MAX_TEXT_CHARACTERS = 256;
const MAX_EVENTS = 250_000;
const MAX_PENDING_EVENTS = 4_096;
const toolIds = new Set(NATIVE_TOOL_IDS);
const toolStates = new Set(NATIVE_TOOL_STATES);
const actions = new Set(NATIVE_TOOL_ACTIONS);
const phases = new Set(NATIVE_TOOL_PHASES);
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const catalogKeys = new Set(['schemaVersion', 'tools']);
const catalogEntryKeys = new Set(['id', 'label', 'license']);
const statusKeys = new Set(['schemaVersion', 'tools']);
const statusEntryKeys = new Set([
  'id',
  'label',
  'deliveryAvailable',
  'installed',
  'state',
  'version',
  'availableVersion',
  'installedBytes',
  'downloadBytes',
  'availableInstalledBytes',
  'activeRuntime',
  'pendingRemoval',
  'restartRequired',
  'operation',
]);
const operationKeys = new Set([
  'job', 'tool', 'action', 'phase', 'basisPoints', 'bytesDone', 'totalBytes',
]);
const jobKeys = new Set(['id', 'kind', 'state', 'progress', 'sequence']);
const progressKeys = new Set(['basisPoints']);
const progressEventKeys = new Set(['event', 'operation']);
const terminalEventKeys = new Set(['event', 'job', 'tool', 'action']);
const completedEventKeys = new Set([
  'event', 'job', 'tool', 'action', 'restartRequired', 'deferred',
]);
const failedEventKeys = new Set(['event', 'job', 'tool', 'action', 'error']);
const errorKeys = new Set(['code', 'message']);
const handlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
  'onCancellationError',
]);
const optionKeys = new Set(['signal']);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const hasExactKeys = (value, expected) => {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
};

const isSafeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);

const isSafeText = (value) => {
  if (typeof value !== 'string' || value.length === 0) return false;
  let count = 0;
  for (const character of value) {
    count += 1;
    if (count > MAX_TEXT_CHARACTERS || character < ' ' || character === '\u007f') return false;
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

export class NativeToolsServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NativeToolsServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new NativeToolsServiceError(
  'invalidNativeToolRequest',
  'The native tool request is invalid'
);
const invalidResponse = () => new NativeToolsServiceError(
  'invalidNativeToolResponse',
  'The desktop host returned invalid native tool data'
);
const desktopRequired = () => new NativeToolsServiceError(
  'desktopNativeToolsRequired',
  'Native tool management requires the desktop runtime'
);
const cancelledRequest = () => new NativeToolsServiceError(
  'nativeToolCancelled',
  'The native tool operation was cancelled'
);

const requireTool = (tool) => {
  if (!toolIds.has(tool)) throw invalidRequest();
  return tool;
};

const normalizeVersion = (value) => {
  if (value === null) return null;
  if (!isSafeText(value) || value.length > 128) throw invalidResponse();
  return value;
};

export const normalizeNativeToolJob = (value) => {
  if (!hasExactKeys(value, jobKeys)
      || !hasExactKeys(value.progress, progressKeys)
      || !isUuidV7(value.id)
      || value.kind !== 'installEngine'
      || !jobStates.has(value.state)
      || !isSafeInteger(value.progress.basisPoints, 0, 10_000)
      || !isSafeInteger(value.sequence)) {
    throw invalidResponse();
  }
  const basisPoints = value.progress.basisPoints;
  const validState = value.state === 'queued'
    ? basisPoints === 0 && value.sequence === 0
    : value.state === 'succeeded'
      ? basisPoints === 10_000 && value.sequence >= 2
      : value.sequence >= 1;
  if (!validState) throw invalidResponse();
  return Object.freeze({
    id: value.id,
    kind: 'installEngine',
    state: value.state,
    progress: Object.freeze({ basisPoints }),
    sequence: value.sequence,
  });
};

const normalizeOperation = (value, expectedTool) => {
  if (!hasExactKeys(value, operationKeys)) throw invalidResponse();
  const job = normalizeNativeToolJob(value.job);
  const tool = requireTool(value.tool);
  if ((expectedTool !== undefined && tool !== expectedTool)
      || !actions.has(value.action)
      || !phases.has(value.phase)
      || !['queued', 'running', 'cancelling'].includes(job.state)
      || !isSafeInteger(value.basisPoints, 0, 10_000)
      || value.basisPoints !== job.progress.basisPoints
      || !isSafeInteger(value.bytesDone)
      || !isSafeInteger(value.totalBytes)
      || value.bytesDone > value.totalBytes
      || (value.totalBytes === 0 && value.bytesDone !== 0)
      || (value.action === 'remove' ? value.phase !== 'preparing' && value.phase !== 'removing'
        : value.phase === 'removing')) {
    throw invalidResponse();
  }
  return Object.freeze({
    job,
    tool,
    action: value.action,
    phase: value.phase,
    basisPoints: value.basisPoints,
    bytesDone: value.bytesDone,
    totalBytes: value.totalBytes,
  });
};

const canonicalizeEntries = (entries, normalize) => {
  if (!Array.isArray(entries) || entries.length !== NATIVE_TOOL_IDS.length) {
    throw invalidResponse();
  }
  const byId = new Map();
  entries.forEach((entry) => {
    const normalized = normalize(entry);
    if (byId.has(normalized.id)) throw invalidResponse();
    byId.set(normalized.id, normalized);
  });
  if (byId.size !== NATIVE_TOOL_IDS.length) throw invalidResponse();
  return Object.freeze(NATIVE_TOOL_IDS.map((id) => byId.get(id)));
};

export const normalizeNativeToolsCatalog = (value) => {
  if (!hasExactKeys(value, catalogKeys) || value.schemaVersion !== 1) throw invalidResponse();
  const tools = canonicalizeEntries(value.tools, (entry) => {
    if (!hasExactKeys(entry, catalogEntryKeys)
        || !toolIds.has(entry.id)
        || !isSafeText(entry.label)
        || entry.license !== EXPECTED_LICENSES[entry.id]) {
      throw invalidResponse();
    }
    return Object.freeze({ id: entry.id, label: entry.label, license: entry.license });
  });
  return Object.freeze({ schemaVersion: 1, tools });
};

export const normalizeNativeToolsStatus = (value) => {
  if (!hasExactKeys(value, statusKeys) || value.schemaVersion !== 1) throw invalidResponse();
  const tools = canonicalizeEntries(value.tools, (entry) => {
    if (!hasExactKeys(entry, statusEntryKeys)
        || !toolIds.has(entry.id)
        || !isSafeText(entry.label)
        || typeof entry.deliveryAvailable !== 'boolean'
        || typeof entry.installed !== 'boolean'
        || !toolStates.has(entry.state)
        || !isSafeInteger(entry.installedBytes)
        || !isSafeInteger(entry.downloadBytes)
        || !isSafeInteger(entry.availableInstalledBytes)
        || typeof entry.activeRuntime !== 'boolean'
        || typeof entry.pendingRemoval !== 'boolean'
        || typeof entry.restartRequired !== 'boolean') {
      throw invalidResponse();
    }
    const version = normalizeVersion(entry.version);
    const availableVersion = normalizeVersion(entry.availableVersion);
    const validState = entry.state === 'unavailable'
      ? !entry.deliveryAvailable && !entry.installed && availableVersion === null
      : entry.state === 'missing'
        ? entry.deliveryAvailable && !entry.installed && availableVersion !== null
        : entry.state === 'installed'
          ? entry.deliveryAvailable && entry.installed && version !== null
          : entry.deliveryAvailable && !entry.installed && availableVersion !== null;
    if (!validState
        || (!entry.installed && (version !== null || entry.installedBytes !== 0))
        || (entry.deliveryAvailable !== (
          entry.downloadBytes > 0 && entry.availableInstalledBytes > 0
        ))
        || (entry.activeRuntime && !entry.installed)
        || (entry.pendingRemoval
          && (!entry.restartRequired
            || (!entry.activeRuntime && entry.state !== 'corrupt')))
        || (entry.restartRequired
          && !entry.installed
          && !(entry.pendingRemoval && entry.state === 'corrupt'))) {
      throw invalidResponse();
    }
    const operation = entry.operation === null
      ? null
      : normalizeOperation(entry.operation, entry.id);
    return Object.freeze({
      id: entry.id,
      label: entry.label,
      deliveryAvailable: entry.deliveryAvailable,
      installed: entry.installed,
      state: entry.state,
      version,
      availableVersion,
      installedBytes: entry.installedBytes,
      downloadBytes: entry.downloadBytes,
      availableInstalledBytes: entry.availableInstalledBytes,
      activeRuntime: entry.activeRuntime,
      pendingRemoval: entry.pendingRemoval,
      restartRequired: entry.restartRequired,
      operation,
    });
  });
  return Object.freeze({ schemaVersion: 1, tools });
};

const normalizeCommandError = (value) => {
  if (!hasExactKeys(value, errorKeys)
      || typeof value.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value.code)
      || !isSafeText(value.message)) {
    throw invalidResponse();
  }
  return Object.freeze({ code: value.code, message: value.message });
};

export const normalizeNativeToolEvent = (value) => {
  if (!isPlainRecord(value) || typeof value.event !== 'string') throw invalidResponse();
  if (value.event === 'progress') {
    if (!hasExactKeys(value, progressEventKeys)) throw invalidResponse();
    return Object.freeze({ event: 'progress', operation: normalizeOperation(value.operation) });
  }
  if (value.event === 'completed') {
    if (!hasExactKeys(value, completedEventKeys)
        || typeof value.restartRequired !== 'boolean'
        || typeof value.deferred !== 'boolean') {
      throw invalidResponse();
    }
    const job = normalizeNativeToolJob(value.job);
    if (job.state !== 'succeeded'
        || !actions.has(value.action)
        || (value.deferred && (value.action !== 'remove' || !value.restartRequired))) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: 'completed',
      job,
      tool: requireTool(value.tool),
      action: value.action,
      restartRequired: value.restartRequired,
      deferred: value.deferred,
    });
  }
  if (value.event === 'cancelled') {
    if (!hasExactKeys(value, terminalEventKeys)) throw invalidResponse();
    const job = normalizeNativeToolJob(value.job);
    if (job.state !== 'cancelled' || !actions.has(value.action)) throw invalidResponse();
    return Object.freeze({
      event: 'cancelled', job, tool: requireTool(value.tool), action: value.action,
    });
  }
  if (value.event === 'failed') {
    if (!hasExactKeys(value, failedEventKeys) || !actions.has(value.action)) {
      throw invalidResponse();
    }
    const job = value.job === null ? null : normalizeNativeToolJob(value.job);
    if (job !== null && ['queued', 'succeeded', 'cancelled'].includes(job.state)) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: 'failed',
      job,
      tool: requireTool(value.tool),
      action: value.action,
      error: normalizeCommandError(value.error),
    });
  }
  throw invalidResponse();
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!isPlainRecord(handlers)
      || Object.keys(handlers).some((key) => !handlerKeys.has(key))
      || Object.values(handlers).some((handler) => typeof handler !== 'function')) {
    throw invalidRequest();
  }
  return handlers;
};

const normalizeOptions = (options) => {
  if (options === undefined) return Object.freeze({});
  if (!isPlainRecord(options) || Object.keys(options).some((key) => !optionKeys.has(key))) {
    throw invalidRequest();
  }
  const { signal } = options;
  if (signal !== undefined
      && (!isRecord(signal)
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
    throw invalidRequest();
  }
  return options;
};

const requireDesktop = (isNativeRuntime) => {
  if (!isNativeRuntime()) throw desktopRequired();
};

export const createNativeToolsService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const channels = new Map();

  const cancelNativeToolJob = async (jobId) => {
    requireDesktop(isNativeRuntime);
    if (!isUuidV7(jobId)) throw invalidRequest();
    const job = normalizeNativeToolJob(await invokeCommand('native_tool_cancel', { jobId }));
    if (job.id !== jobId) throw invalidResponse();
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.state)) {
      channels.delete(jobId);
    }
    return job;
  };

  const getNativeToolsCatalog = async () => {
    requireDesktop(isNativeRuntime);
    return normalizeNativeToolsCatalog(await invokeCommand('native_tools_catalog', {}));
  };

  const getNativeToolsStatus = async () => {
    requireDesktop(isNativeRuntime);
    return normalizeNativeToolsStatus(await invokeCommand('native_tools_status', {}));
  };

  const startOperation = async (command, action, toolInput, handlersInput, optionsInput) => {
    requireDesktop(isNativeRuntime);
    const tool = requireTool(toolInput);
    const handlers = normalizeHandlers(handlersInput);
    const { signal } = normalizeOptions(optionsInput);
    if (signal?.aborted) throw cancelledRequest();

    let initial = null;
    let terminal = false;
    let protocolError = null;
    let cancellationIssued = false;
    let eventCount = 0;
    let lastSequence = -1;
    let lastBasisPoints = -1;
    const pending = [];

    const safelyCall = (handler, value) => {
      if (!handler) return;
      try {
        const result = handler(value);
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch((error) => {
            try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
          });
        }
      } catch (error) {
        try { handlers.onHandlerError?.(error); } catch { /* isolated */ }
      }
    };
    const release = () => {
      signal?.removeEventListener('abort', issueCancellation);
      if (initial !== null) channels.delete(initial.id);
    };
    const issueCancellation = () => {
      if (initial === null || terminal || cancellationIssued) return;
      cancellationIssued = true;
      Promise.resolve(cancelNativeToolJob(initial.id)).catch((error) => {
        safelyCall(handlers.onCancellationError, error);
      });
    };
    const failProtocol = () => {
      if (terminal || protocolError !== null) return;
      const error = invalidResponse();
      protocolError = error;
      safelyCall(handlers.onProtocolError, error);
      issueCancellation();
      release();
    };
    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      eventCount += 1;
      if (eventCount > MAX_EVENTS) return failProtocol();
      const job = event.event === 'progress' ? event.operation.job : event.job;
      const eventTool = event.event === 'progress' ? event.operation.tool : event.tool;
      const eventAction = event.event === 'progress' ? event.operation.action : event.action;
      if (eventTool !== tool
          || eventAction !== action
          || (job !== null && (job.id !== initial.id || job.sequence <= lastSequence))
          || (event.event === 'progress' && event.operation.basisPoints < lastBasisPoints)) {
        return failProtocol();
      }
      if (job !== null) {
        lastSequence = job.sequence;
        lastBasisPoints = job.progress.basisPoints;
      }
      if (event.event !== 'progress') {
        terminal = true;
        release();
      }
      safelyCall(handlers.onEvent, event);
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
      return undefined;
    };

    const channel = new ChannelConstructor();
    channel.onmessage = (raw) => {
      let event;
      try {
        event = normalizeNativeToolEvent(raw);
      } catch {
        failProtocol();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) failProtocol();
        else pending.push(event);
        return;
      }
      dispatch(event);
    };
    signal?.addEventListener('abort', issueCancellation, { once: true });
    try {
      initial = normalizeNativeToolJob(await invokeCommand(command, { tool, onEvent: channel }));
      if (!['queued', 'running'].includes(initial.state)) throw invalidResponse();
      lastSequence = initial.sequence;
      lastBasisPoints = initial.progress.basisPoints;
      if (protocolError !== null) {
        issueCancellation();
        release();
        throw protocolError;
      }
      channels.set(initial.id, channel);
      pending.splice(0).forEach(dispatch);
      if (signal?.aborted) issueCancellation();
      if (terminal) release();
      return initial;
    } catch (error) {
      pending.length = 0;
      release();
      throw error;
    }
  };

  return Object.freeze({
    getNativeToolsCatalog,
    getNativeToolsStatus,
    installNativeTool: (tool, handlers, options) => startOperation(
      'native_tool_install', 'install', tool, handlers, options
    ),
    removeNativeTool: (tool, handlers, options) => startOperation(
      'native_tool_remove', 'remove', tool, handlers, options
    ),
    cancelNativeToolJob,
  });
};

const nativeToolsService = createNativeToolsService();

export const getNativeToolsCatalog = nativeToolsService.getNativeToolsCatalog;
export const getNativeToolsStatus = nativeToolsService.getNativeToolsStatus;
export const installNativeTool = nativeToolsService.installNativeTool;
export const removeNativeTool = nativeToolsService.removeNativeTool;
export const cancelNativeToolJob = nativeToolsService.cancelNativeToolJob;
