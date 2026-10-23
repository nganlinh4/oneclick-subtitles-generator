// Speech bridge contract: backend catalogs, limits, text and ID validators, and the typed errors
// shared by the request and response normalizers.
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { GEMINI_SPEECH_MODEL_IDS } from '../config/geminiModels';

export const SPEECH_BACKENDS = Object.freeze([
  'f5Tts',
  'chatterbox',
  'edgeTts',
  'gtts',
  'geminiTts',
]);

export const GEMINI_SPEECH_MODELS = Object.freeze([...GEMINI_SPEECH_MODEL_IDS]);

export const GEMINI_SPEECH_VOICES = Object.freeze([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);

export const GTTS_DOMAINS = Object.freeze([
  'com', 'com.au', 'co.uk', 'us', 'ca', 'co.in', 'ie', 'co.za',
  'com.br', 'pt', 'es', 'com.mx', 'fr',
]);

export const CHATTERBOX_LANGUAGES = Object.freeze([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
]);

const SPEECH_PROGRESS_PHASES = Object.freeze([
  'startingWorker',
  'loadingModel',
  'synthesizing',
  'encoding',
  'publishing',
]);

export const MAX_SPEECH_SEGMENTS = 1_000;
export const MAX_SPEECH_BATCH_BYTES = 4 * 1024 * 1024;

export const MAX_SEGMENT_TEXT_BYTES = 16 * 1024;
export const MAX_SEGMENT_TEXT_CHARACTERS = 8_000;
export const MAX_CHATTERBOX_CHARACTERS = 300;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
export const MAX_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_TIME_MICROS = MAX_TIME_MS * 1_000;
export const MAX_VOICES = 2_048;
export const MAX_PENDING_EVENTS = 4_096;
export const MAX_JOB_EVENTS = 20_000;
export const MAX_EXPORT_FILE_NAME_CHARACTERS = 128;

export const backendSet = new Set(SPEECH_BACKENDS);
export const voiceInventoryBackendSet = new Set(['edgeTts', 'gtts', 'geminiTts']);
export const geminiModelSet = new Set(GEMINI_SPEECH_MODELS);
export const geminiVoiceSet = new Set(GEMINI_SPEECH_VOICES);
export const gttsDomainSet = new Set(GTTS_DOMAINS);
export const chatterboxLanguageSet = new Set(CHATTERBOX_LANGUAGES);
export const phaseSet = new Set(SPEECH_PROGRESS_PHASES);
export const jobStateSet = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export const failureCodeSet = new Set([
  'cancelled',
  'projectChanged',
  'invalidRequest',
  'runtimeUnavailable',
  'modelUnavailable',
  'providerUnavailable',
  'providerRateLimited',
  'authenticationFailed',
  'referenceRejected',
  'synthesisFailed',
  'encodingFailed',
  'timedOut',
  'workerFailed',
  'artifactStorage',
]);
export const resultStatusSet = new Set(['completed', 'failed']);
export const formatSet = new Set(['wav', 'mp3', 'm4a']);
export const genderSet = new Set(['female', 'male', 'neutral', 'unknown']);
export const referenceBackendSet = new Set(['f5Tts', 'chatterbox']);

export const characterCount = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  let count = 0;
  for (const unused of value) {
    void unused;
    count += 1;
    if (count > maximum) return count;
  }
  return count;
};

export const hasInvalidControls = (value, allowWhitespace = false) => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if ((point < 32 || point === 127)
        && !(allowWhitespace && (character === '\n' || character === '\t'))) {
      return true;
    }
  }
  return false;
};

export const hasReferenceTextControls = (value) => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if ((point < 32 || point === 127)
        && character !== '\n' && character !== '\r' && character !== '\t') {
      return true;
    }
  }
  return false;
};

export const uuidHasVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
};

export class SpeechServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpeechServiceError';
    this.code = code;
  }
}

export const invalidRequest = () => new SpeechServiceError(
  'invalidSpeechRequest',
  'The native speech request is invalid'
);

export const invalidResponse = () => new SpeechServiceError(
  'invalidSpeechResponse',
  'The desktop host returned invalid speech data'
);

export const desktopRequired = () => new SpeechServiceError(
  'desktopSpeechRequired',
  'Native speech requires the desktop runtime'
);

export const cancelledRequest = () => new SpeechServiceError(
  'speechCancelled',
  'The native speech request was cancelled'
);

export const runtimeStopped = () => new SpeechServiceError(
  'speechRuntimeStopped',
  'The selected speech runtime was stopped or replaced'
);

export const requireInteger = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

export const requireUuid = (value, version) => {
  if (!uuidHasVersion(value, version)) throw invalidRequest();
  return value;
};

export const requireIdentifier = (value, maximum = 128) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > maximum
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidRequest();
  }
  return value;
};

export const requireLanguage = (value) => {
  if (typeof value !== 'string'
      || value.length < 2
      || value.length > 35
      || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    throw invalidRequest();
  }
  return value;
};

export const requireResponseInteger = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidResponse();
  }
  return value;
};

export const requireResponseIdentifier = (value, maximum = 128) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > maximum
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidResponse();
  }
  return value;
};

export const requireResponseLanguage = (value) => {
  if (typeof value !== 'string'
      || value.length < 2
      || value.length > 35
      || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    throw invalidResponse();
  }
  return value;
};

export const projectNarrationSources = new Set(['original', 'translated', 'grouped']);
export const projectNarrationMethods = new Set(['f5tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini']);
export const MAX_PROJECT_NARRATION_MICROS = 4 * 60 * 60 * 1_000_000;

export const narrationCueKey = (value) => `${typeof value}:${String(value)}`;

export const normalizeNarrationCueId = (value, response = false) => {
  if ((typeof value === 'number' && Number.isSafeInteger(value))
      || (typeof value === 'string'
        && value.length > 0
        && [...value].length <= 256
        && ![...value].some((character) => {
          const point = character.codePointAt(0);
          return point < 32 || point === 127;
        }))) return value;
  throw response ? invalidResponse() : invalidRequest();
};
