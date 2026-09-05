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
  audioOnly = false,
  videoFile,
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
  const frameTokens = resolution ? resolution.tokens : 258;
  const audioTokensPerSecond = 32;
  // The production planner balances its windows evenly under this maximum.
  // Estimate that actual window duration, not the configured maximum itself.
  // Prompt/metadata tokens remain additional to this media-only estimate.
  const windowSeconds = Number(maxDurationPerRequest) * 60;
  const longestRequest = Number.isFinite(windowSeconds) && windowSeconds > 0
    ? segmentDuration / Math.max(1, Math.ceil(segmentDuration / windowSeconds)) : segmentDuration;
  const estimatedTokens = Math.round(
    longestRequest * ((audioOnly || videoFile?.type?.startsWith('audio/') ? 0 : fps * frameTokens) + audioTokensPerSecond)
  );

  return {
    realTokenCount: null,
    estimatedTokens,
    displayTokens: estimatedTokens,
    isCountingTokens: false,
    tokenCountError: null,
  };
};

export default useTokenCounting;
