import { runMediaPipeline } from '../../platform/mediaPipelineService';

const MAX_WAVEFORM_POINTS = 1_000_000;
const TARGET_LONG_WAVEFORM_POINTS = 250_000;

const isFinitePositive = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

/**
 * Select a bounded native waveform request for the complete media duration.
 *
 * Short media keeps enough detail for close subtitle edits. Long media stays at
 * four points per second until the serialized response would become excessive,
 * then the Rust plan lowers the actual density while retaining at least one
 * point per second. The seven-day media limit therefore remains below one
 * million base points and never scales with the source sample rate.
 */
export const nativeWaveformDensity = (durationSeconds) => {
  if (!isFinitePositive(durationSeconds)) {
    throw new TypeError('Native waveform duration must be finite and positive');
  }
  const desiredPointsPerSecond = durationSeconds > 300
    ? 4
    : Math.min(400, Math.max(1, Math.ceil(1000 / durationSeconds)));
  const wholeSeconds = Math.max(1, Math.ceil(durationSeconds));
  const desiredPoints = Math.ceil(durationSeconds * desiredPointsPerSecond);
  const maxPoints = Math.min(
    MAX_WAVEFORM_POINTS,
    Math.max(1_000, wholeSeconds, Math.min(TARGET_LONG_WAVEFORM_POINTS, desiredPoints))
  );
  return Object.freeze({
    pointsPerSecond: desiredPointsPerSecond,
    maxPoints,
  });
};

/**
 * Run the only supported waveform engine.
 *
 * Decode, resampling, min/max/RMS aggregation, pyramid construction, progress,
 * cancellation, and point bounds are native. The WebView receives the final
 * bounded pyramid and does presentation work only.
 */
export const loadNativeWaveform = async ({
  assetId,
  durationSeconds,
  signal,
  onProgress = () => undefined,
  revalidate = async () => undefined,
}) => {
  const density = nativeWaveformDensity(durationSeconds);
  let lastProgress = 0;
  const result = await runMediaPipeline({
    operation: 'generateWaveform',
    assetId,
    pointsPerSecond: density.pointsPerSecond,
    maxPoints: density.maxPoints,
    range: null,
  }, {
    signal,
    onProgress: (event) => {
      if (signal.aborted) return;
      const candidate = event.fraction ?? event.job.progress.basisPoints / 10_000;
      if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return;
      lastProgress = Math.max(lastProgress, Math.min(1, Math.max(0, candidate)));
      onProgress(lastProgress);
    },
  });
  if (signal.aborted) {
    const error = new Error('The native waveform request was cancelled');
    error.name = 'AbortError';
    throw error;
  }
  // A subtitle edit may advance the project revision while these immutable
  // media bytes are being analyzed. The caller supplies a refresh check that
  // accepts such forward progress but still rejects a real media replacement.
  await revalidate();
  onProgress(1);
  return result.waveform;
};

export const isMissingAudioFailure = (error) => (
  error?.code === 'mediaMissingAudio'
  || error?.name === 'EncodingError'
);
