// Identities, duration windows, and progress bounds of the installed media-pipeline smoke.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;
const SOURCE_DURATION = Object.freeze({ minimum: 3_900_000, maximum: 4_100_000 });
const CLIP_DURATION = Object.freeze({ minimum: 1_400_000, maximum: 1_600_000 });
const AUDIO_DURATION = Object.freeze({ minimum: 1_900_000, maximum: 2_100_000 });
const PHASES = new Set(['probing', 'processing', 'publishing']);
const MAX_OPERATION_EVENTS = 4_096;
const PROCESSING_END_BASIS_POINTS = 9_500;
const PUBLISHING_BASIS_POINTS = 9_700;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const isBoundedInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);

export {
  AUDIO_DURATION,
  CLIP_DURATION,
  DEFAULT_TIMEOUT_MS,
  MAX_OPERATION_EVENTS,
  PHASES,
  PLAYBACK_URL,
  PROCESSING_END_BASIS_POINTS,
  PUBLISHING_BASIS_POINTS,
  SOURCE_DURATION,
  UUID_V4,
  UUID_V7,
  hasExactKeys,
  invariant,
  isBoundedInteger,
};
