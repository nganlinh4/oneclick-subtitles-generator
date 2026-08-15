import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, v7 as uuidv7, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const VOICES = new Set([
  'achernar', 'achird', 'algenib', 'algieba', 'alnilam', 'aoede', 'autonoe',
  'callirrhoe', 'charon', 'despina', 'enceladus', 'erinome', 'fenrir', 'gacrux',
  'iapetus', 'kore', 'laomedeia', 'leda', 'orus', 'puck', 'pulcherrima', 'rasalgethi',
  'sadachbia', 'sadaltager', 'schedar', 'sulafat', 'umbriel', 'vindemiatrix', 'zephyr',
  'zubenelgenubi',
]);
const STATES = new Set(['unavailable', 'missing', 'installed', 'update-available', 'corrupt']);
const PHASES = new Set(['preparing', 'downloading', 'verifying', 'extracting', 'publishing', 'removing']);
const NATIVE_FAILURE_CODES = new Set([
  'invalidEnginePackageRequest',
  'packageUnavailable',
  'packageOperationInProgress',
  'packageNetwork',
  'packageDownloadInvalid',
  'packageStorageLimit',
  'packageInsufficientSpace',
  'packageIntegrity',
  'packageInstallInvalid',
  'engineRuntimeBusy',
  'packageStorage',
  'packageCatalogInvalid',
  'invalidPath',
  'mediaRegistryFull',
  'mediaServer',
]);
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const isCanonicalUuidV4 = (value) => {
  if (typeof value !== 'string' || !UUID_V4.test(value) || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 4;
  } catch {
    return false;
  }
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export class VoiceSampleServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceSampleServiceError';
    this.code = code;
  }
}

const invalid = () => new VoiceSampleServiceError(
  'invalidVoiceSampleResponse',
  'The desktop voice sample response is invalid.',
);

const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export const normalizeVoiceSampleProgress = (value) => {
  if (!exactKeys(value, ['operationId', 'phase', 'bytesDone', 'totalBytes', 'basisPoints'])
      || !isUuidV7(value.operationId)
      || !PHASES.has(value.phase)
      || !Number.isSafeInteger(value.bytesDone) || value.bytesDone < 0
      || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
      || value.bytesDone > value.totalBytes
      || !Number.isInteger(value.basisPoints)
      || value.basisPoints < 0 || value.basisPoints > 10000) throw invalid();
  return Object.freeze({ ...value });
};

export const normalizeVoiceSamplePlayback = (value) => {
  if (!exactKeys(value, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !isCanonicalUuidV4(value.id)
      || typeof value.playbackUrl !== 'string'
      || value.mimeType !== 'audio/wav'
      || !Number.isSafeInteger(value.byteLength) || value.byteLength < 44) throw invalid();
  const match = PLAYBACK_URL.exec(value.playbackUrl);
  if (!match || match[2] !== value.id) throw invalid();
  const port = Number(match[1]);
  if (port < 1 || port > 65535) throw invalid();
  return Object.freeze({ ...value });
};

export const normalizeVoiceSampleStatus = (value) => {
  const keys = [
    'id', 'label', 'deliveryAvailable', 'installed', 'updateAvailable', 'state', 'version',
    'availableVersion', 'installedBytes', 'downloadBytes', 'availableInstalledBytes',
  ];
  if (!exactKeys(value, keys)
      || value.id !== 'gemini-voice-samples'
      || value.label !== 'Gemini voice previews'
      || typeof value.deliveryAvailable !== 'boolean'
      || typeof value.installed !== 'boolean'
      || typeof value.updateAvailable !== 'boolean'
      || !STATES.has(value.state)
      || ![value.version, value.availableVersion].every((entry) => entry === null || typeof entry === 'string')
      || ![value.installedBytes, value.downloadBytes, value.availableInstalledBytes]
        .every((entry) => Number.isSafeInteger(entry) && entry >= 0)) throw invalid();
  return Object.freeze({ ...value });
};

const redact = (error) => {
  let code;
  try {
    code = error?.code;
  } catch {
    code = undefined;
  }
  if (code === 'enginePackageCancelled') {
    return new VoiceSampleServiceError(
      'voiceSampleCancelled',
      'Voice sample installation cancelled.',
    );
  }
  return new VoiceSampleServiceError(
    NATIVE_FAILURE_CODES.has(code) ? code : 'voiceSampleUnavailable',
    'The managed voice preview is unavailable.',
  );
};

export const createVoiceSampleService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  nativeRuntime = isDesktopRuntime,
  createOperationId = uuidv7,
} = {}) => {
  const activeOperationIds = [];
  const requireDesktop = () => {
    if (!nativeRuntime()) throw redact();
  };
  const withProgress = async (command, args, normalize, handlers = {}) => {
    requireDesktop();
    const operationId = createOperationId();
    if (!isUuidV7(operationId) || activeOperationIds.includes(operationId)) throw invalid();
    const channel = new ChannelConstructor();
    activeOperationIds.push(operationId);
    let failed = false;
    let settled = false;
    let lastBasisPoints = -1;
    let cancellationPromise = null;
    const safelyCall = (handler, value) => {
      if (typeof handler !== 'function') return;
      try {
        const result = handler(value);
        result?.catch?.(() => undefined);
      } catch {
        // Presentation callbacks never control the native package operation.
      }
    };
    const cancelOnce = () => {
      if (cancellationPromise === null) {
        try {
          cancellationPromise = Promise.resolve(invokeCommand(
            'voice_samples_cancel',
            { operationId },
          ))
            .catch(() => undefined);
        } catch {
          cancellationPromise = Promise.resolve();
        }
      }
      return cancellationPromise;
    };
    const failProtocol = () => {
      if (failed || settled) return;
      failed = true;
      safelyCall(handlers.onProtocolError, invalid());
      void cancelOnce();
    };
    const settle = () => {
      settled = true;
      channel.onmessage = () => undefined;
    };
    channel.onmessage = (raw) => {
      if (failed || settled) return;
      let progress;
      try {
        progress = normalizeVoiceSampleProgress(raw);
        if (progress.operationId !== operationId) throw invalid();
        if (progress.basisPoints < lastBasisPoints) throw invalid();
        lastBasisPoints = progress.basisPoints;
      } catch {
        failProtocol();
        return;
      }
      safelyCall(handlers.onProgress, progress);
    };
    try {
      let raw;
      try {
        raw = await invokeCommand(command, { ...args, operationId, onEvent: channel });
      } catch (error) {
        if (failed) {
          await cancelOnce();
          throw invalid();
        }
        throw redact(error);
      }
      if (failed) {
        await cancelOnce();
        throw invalid();
      }
      return normalize(raw);
    } finally {
      settle();
      const index = activeOperationIds.indexOf(operationId);
      if (index >= 0) activeOperationIds.splice(index, 1);
    }
  };

  return Object.freeze({
    cancel: async () => {
      requireDesktop();
      const operationId = activeOperationIds[0];
      if (operationId === undefined) return false;
      let cancelled;
      try {
        cancelled = await invokeCommand('voice_samples_cancel', { operationId });
      } catch (error) {
        throw redact(error);
      }
      if (typeof cancelled !== 'boolean') throw invalid();
      return cancelled;
    },
    status: async () => {
      requireDesktop();
      let status;
      try {
        status = await invokeCommand('voice_samples_status', {});
      } catch (error) {
        throw redact(error);
      }
      return normalizeVoiceSampleStatus(status);
    },
    resolve: (voiceId, handlers) => {
      const voice = typeof voiceId === 'string' ? voiceId.toLowerCase() : '';
      if (!VOICES.has(voice)) throw new VoiceSampleServiceError('invalidVoiceId', 'Invalid voice.');
      return withProgress(
        'voice_sample_resolve',
        { voiceId: voice },
        normalizeVoiceSamplePlayback,
        handlers,
      );
    },
    install: (handlers) => withProgress(
      'voice_samples_install',
      {},
      normalizeVoiceSampleStatus,
      handlers,
    ),
    remove: (handlers) => withProgress(
      'voice_samples_remove',
      {},
      normalizeVoiceSampleStatus,
      handlers,
    ),
  });
};

const service = createVoiceSampleService();
export const getVoiceSamplesStatus = service.status;
export const cancelVoiceSamples = service.cancel;
export const installVoiceSamples = service.install;
export const resolveVoiceSample = service.resolve;
export const removeVoiceSamples = service.remove;
