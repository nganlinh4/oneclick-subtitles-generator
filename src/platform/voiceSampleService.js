import { Channel } from '@tauri-apps/api/core';
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
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/;

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
  if (!exactKeys(value, ['phase', 'bytesDone', 'totalBytes', 'basisPoints'])
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
      || typeof value.id !== 'string'
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

const redact = () => new VoiceSampleServiceError(
  'voiceSampleUnavailable',
  'The managed voice preview is unavailable.',
);

export const createVoiceSampleService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  nativeRuntime = isDesktopRuntime,
} = {}) => {
  const requireDesktop = () => {
    if (!nativeRuntime()) throw redact();
  };
  const withProgress = async (command, args, normalize, handlers = {}) => {
    requireDesktop();
    const channel = new ChannelConstructor();
    let failed = false;
    let lastBasisPoints = -1;
    channel.onmessage = (raw) => {
      if (failed) return;
      try {
        const progress = normalizeVoiceSampleProgress(raw);
        if (progress.basisPoints < lastBasisPoints) throw invalid();
        lastBasisPoints = progress.basisPoints;
        handlers.onProgress?.(progress);
      } catch {
        failed = true;
        handlers.onProtocolError?.(invalid());
      }
    };
    let raw;
    try {
      raw = await invokeCommand(command, { ...args, onEvent: channel });
    } catch (error) {
      if (error?.code === 'enginePackageCancelled') {
        throw new VoiceSampleServiceError(
          'voiceSampleCancelled',
          'Voice sample installation cancelled.',
        );
      }
      throw redact();
    }
    if (failed) throw invalid();
    return normalize(raw);
  };

  return Object.freeze({
    cancel: async () => {
      requireDesktop();
      try {
        const cancelled = await invokeCommand('voice_samples_cancel', {});
        if (typeof cancelled !== 'boolean') throw invalid();
        return cancelled;
      } catch (error) {
        if (error instanceof VoiceSampleServiceError) throw error;
        throw redact();
      }
    },
    status: async () => {
      requireDesktop();
      try {
        return normalizeVoiceSampleStatus(await invokeCommand('voice_samples_status', {}));
      } catch (error) {
        if (error instanceof VoiceSampleServiceError) throw error;
        throw redact();
      }
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
