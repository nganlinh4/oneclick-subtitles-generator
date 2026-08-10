import { supportsTokenCounting } from '../services/engines/transcriptionEngineRegistry';

/**
 * Deterministic token estimation for the desktop processing modal.
 *
 * Exact provider-side countTokens requests required a WebView API key and a provider Files API
 * URI. The native rewrite deliberately exposes neither, so the UI always uses the established
 * documented estimate.
 */
const useTokenCounting = ({
  selectedSegment,
  fps,
  mediaResolution,
  method,
  maxDurationPerRequest,
  resolutionOptions,
}) => {
  const tokenCountingEnabled = supportsTokenCounting(method);
  if (!tokenCountingEnabled || !selectedSegment) {
    return {
      realTokenCount: null,
      estimatedTokens: 0,
      displayTokens: 0,
      isCountingTokens: false,
      tokenCountError: null,
    };
  }

  const segmentDuration = selectedSegment.end - selectedSegment.start;
  const resolution = resolutionOptions.find((candidate) => candidate.value === mediaResolution);
  const frameTokens = resolution ? resolution.tokens : 256;
  const audioTokensPerSecond = 32;
  const totalSegmentTokens = Math.round(
    segmentDuration * (fps * frameTokens + audioTokensPerSecond)
  );
  const requestCount = Math.max(
    1,
    Math.ceil(segmentDuration / (maxDurationPerRequest * 60))
  );
  const estimatedTokens = Math.round(totalSegmentTokens / requestCount);

  return {
    realTokenCount: null,
    estimatedTokens,
    displayTokens: estimatedTokens,
    isCountingTokens: false,
    tokenCountError: null,
  };
};

export default useTokenCounting;
