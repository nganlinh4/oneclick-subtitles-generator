import i18n from '../i18n/i18n';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  nativeNarrationAlignmentService,
  normalizeAlignmentRequest,
} from '../platform/narrationAlignmentService';
import { getNativeNarrationArtifactId } from '../platform/nativeNarrationCapabilities';
import {
  discardRecoveredNativeJob,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
  startNativeJobRecovery,
} from '../platform/jobRecoveryCoordinator';
import { hydrateNarrationResultsForAlignment } from '../utils/narrationAlignmentUtils';

const emptyCache = () => ({
  blob: null,
  url: null,
  filename: null,
  mode: null,
  previewPlan: null,
  nativeArtifactId: null,
  nativePlaybackId: null,
  nativeJobId: null,
  timestamp: null,
  subtitleTimestamps: {},
});

let cache = emptyCache();
let audioElement = null;
let playbackRate = 1;
let volume = 1;
let recentAlignment = null;

const syncWindowState = () => {
  if (typeof window === 'undefined') return;
  window.alignedNarrationCache = cache;
  window.isAlignedNarrationAvailable = Boolean(cache.url);
  window.alignedAudioElement = audioElement;
};

const setCache = (next) => {
  cache = next;
  syncWindowState();
};

const clearRecentAlignment = () => {
  if (recentAlignment !== null) forgetNativeJobId(recentAlignment.jobId);
  recentAlignment = null;
};

const rememberAlignment = (jobId, request) => {
  recentAlignment = Object.freeze({ jobId, request });
  rememberNativeJobId(jobId);
};

const matchingRecentJobId = (request) => (
  recentAlignment !== null
  && JSON.stringify(recentAlignment.request) === JSON.stringify(request)
    ? recentAlignment.jobId
    : null
);

const discardUnmatchedRecoveredAlignments = async () => {
  await startNativeJobRecovery().catch(() => undefined);
  for (const entry of listRecoveredNativeJobs('alignNarration')) {
    if (['queued', 'running', 'cancelling'].includes(entry.job.state)) {
      await nativeNarrationAlignmentService.cancelAlignmentJob(entry.job.id)
        .catch(() => undefined);
    }
    discardRecoveredNativeJob(entry.job.id);
  }
};

const releasePlayback = (snapshot = cache) => {
  if (!snapshot?.nativePlaybackId || !isDesktopRuntime()) return;
  nativeNarrationAlignmentService
    .releaseAlignmentPlayback(snapshot.nativePlaybackId)
    .catch(() => undefined);
};

const resetAudioElement = (clearSource = true) => {
  if (!audioElement) return;
  try {
    audioElement.pause();
    if (clearSource) {
      audioElement.src = '';
      audioElement.load();
    }
  } catch {
    // Cleanup remains best-effort if WebView audio teardown races navigation.
  }
  audioElement = null;
  syncWindowState();
};

const ensureAudioElement = () => {
  if (!cache.url || typeof Audio === 'undefined') return null;
  if (!audioElement) {
    audioElement = new Audio();
    audioElement.preload = 'auto';
    audioElement.crossOrigin = 'anonymous';
  }
  if (audioElement.src !== cache.url) {
    audioElement.pause();
    audioElement.src = cache.url;
    audioElement.load();
  }
  audioElement.playbackRate = playbackRate;
  audioElement.volume = volume;
  syncWindowState();
  return audioElement;
};

const secondsToMicros = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid narration timing for native alignment');
  }
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) {
    throw new Error('Invalid narration timing for native alignment');
  }
  return micros;
};

const createSubtitleTimestampMap = (items) => Object.fromEntries(items.map((item) => [
  item.subtitle_id,
  { start: item.start, end: item.end },
]));

const buildNativePayload = (generationResults) => {
  const items = hydrateNarrationResultsForAlignment(generationResults)
    .filter((result) => result?.success)
    .map((result) => {
      const artifactId = getNativeNarrationArtifactId(result);
      if (!artifactId) {
        throw new Error('Native narration alignment requires durable narration artifacts');
      }
      const start = typeof result.start === 'number' ? result.start : 0;
      const end = typeof result.end === 'number' ? result.end : start + 5;
      return Object.freeze({
        subtitle_id: result.subtitle_id,
        nativeArtifactId: artifactId,
        start,
        end,
      });
    })
    .sort((left, right) => left.start - right.start);

  return Object.freeze({
    items: Object.freeze(items),
    subtitleTimestamps: Object.freeze(createSubtitleTimestampMap(items)),
  });
};

const buildNativeRequest = (items) => normalizeAlignmentRequest({
  clips: items.map((item, index) => ({
    id: `segment-${index + 1}`,
    artifactId: item.nativeArtifactId,
    startMicros: secondsToMicros(item.start),
    cueEndMicros: secondsToMicros(item.end),
  })),
});

const cacheResolvedAlignment = async (result, jobId, subtitleTimestamps) => {
  const playable = await nativeNarrationAlignmentService.resolveAlignmentArtifact(
    result.artifact.artifactId,
  );
  releasePlayback(cache);
  resetAudioElement();
  setCache({
    ...emptyCache(),
    url: playable.playback.playbackUrl,
    mode: 'file',
    nativeArtifactId: result.artifact.artifactId,
    nativePlaybackId: playable.playback.id,
    nativeJobId: jobId,
    timestamp: Date.now(),
    subtitleTimestamps,
  });
  return [Object.freeze({
    id: 'native-aligned-narration',
    url: playable.playback.playbackUrl,
    start: 0,
    actualDuration: result.renderedDurationMicros / 1_000_000,
    naturalEnd: result.renderedDurationMicros / 1_000_000,
  })];
};

const restoreAlignment = async (request, subtitleTimestamps) => {
  const jobId = matchingRecentJobId(request);
  if (!jobId) {
    await discardUnmatchedRecoveredAlignments();
    return null;
  }
  try {
    let restored = await nativeNarrationAlignmentService.getAlignmentResult(jobId);
    if (restored.result === null
        && ['queued', 'running', 'cancelling'].includes(restored.job.state)) {
      restored = await nativeNarrationAlignmentService.waitForAlignmentResult(jobId);
    }
    if (restored.result === null) {
      clearRecentAlignment();
      return null;
    }
    forgetNativeJobId(jobId);
    return cacheResolvedAlignment(restored.result, jobId, subtitleTimestamps);
  } catch {
    clearRecentAlignment();
    return null;
  }
};

const startAlignment = async (request, onProgress, subtitleTimestamps) => {
  const restored = await restoreAlignment(request, subtitleTimestamps);
  if (restored) {
    onProgress?.({ status: 'complete', message: 'Using cached aligned narration' });
    return restored;
  }

  let resolveTerminal;
  let rejectTerminal;
  const terminal = new Promise((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });
  const job = await nativeNarrationAlignmentService.startAlignmentJob(request, {
    onProgress: () => onProgress?.({
      status: 'generating',
      message: 'Preparing aligned narration preview...',
    }),
    onCompleted: (event) => resolveTerminal(event.result),
    onCancelled: () => rejectTerminal(new Error('Narration alignment was cancelled')),
    onFailed: (event) => rejectTerminal(new Error(`Narration alignment failed: ${event.code}`)),
    onProtocolError: rejectTerminal,
  });
  rememberAlignment(job.id, request);
  try {
    const result = await terminal;
    forgetNativeJobId(job.id);
    return await cacheResolvedAlignment(result, job.id, subtitleTimestamps);
  } catch (error) {
    clearRecentAlignment();
    throw error;
  }
};

export const prepareAlignedNarrationPreview = async (
  narrationData,
  onProgress = null,
  subtitleTimestamps = createSubtitleTimestampMap(narrationData || []),
) => {
  if (!Array.isArray(narrationData) || narrationData.length === 0) {
    return null;
  }
  if (!isDesktopRuntime()) return null;
  onProgress?.({ status: 'generating', message: 'Preparing aligned narration preview...' });
  const request = buildNativeRequest(narrationData.map((item) => ({
    ...item,
    nativeArtifactId: getNativeNarrationArtifactId(item),
  })));
  const preview = await startAlignment(request, onProgress, subtitleTimestamps);
  onProgress?.({ status: 'complete', message: 'Aligned narration ready' });
  return preview;
};

export const generateAlignedNarration = async (generationResults, onProgress = null) => {
  if (!Array.isArray(generationResults) || generationResults.length === 0) {
    return null;
  }
  if (!isDesktopRuntime()) return null;
  try {
    onProgress?.({ status: 'preparing', message: 'Preparing aligned narration...' });
    const { items, subtitleTimestamps } = buildNativePayload(generationResults);
    if (items.length === 0) {
      throw new Error(i18n.t(
        'errors.noNarrationResults',
        'No narration results to generate aligned audio',
      ));
    }
    await prepareAlignedNarrationPreview(items, onProgress, subtitleTimestamps);
    return 'aligned-preview://timeline';
  } catch (error) {
    onProgress?.({ status: 'error', message: `Error: ${error.message}` });
    return null;
  }
};

export const getAlignedAudioElement = () => ensureAudioElement();

export const playAlignedNarration = (currentTime, isPlaying) => {
  const audio = ensureAudioElement();
  if (!audio) return false;
  try {
    if (Math.abs(audio.currentTime - currentTime) > 0.25 || !isPlaying) {
      audio.currentTime = Math.max(0, currentTime);
    }
    audio.playbackRate = playbackRate;
    audio.volume = volume;
    if (isPlaying && audio.paused) audio.play().catch(() => undefined);
    else if (!isPlaying && !audio.paused) audio.pause();
    return true;
  } catch {
    return false;
  }
};

export const setAlignedNarrationPlaybackRate = (nextRate) => {
  playbackRate = Math.max(0.1, Number(nextRate) || 1);
  if (audioElement) audioElement.playbackRate = playbackRate;
};

export const setAlignedNarrationVolume = (nextVolume) => {
  volume = Math.max(0, Math.min(1, Number(nextVolume) || 0));
  if (audioElement) audioElement.volume = volume;
};

export const resetAlignedAudioElement = () => resetAudioElement();

export const resetAlignedNarration = () => {
  releasePlayback(cache);
  clearRecentAlignment();
  resetAudioElement();
  setCache(emptyCache());
};

export const cleanupAlignedNarration = (
  preserveAudioElement = true,
  preserveCache = true,
) => {
  if (!preserveAudioElement) resetAudioElement();
  if (!preserveCache) resetAlignedNarration();
};

export const isAlignedNarrationAvailable = () => Boolean(cache.url);
export const getAlignedNarrationUrl = () => cache.url;
export const getAlignedNarrationArtifactId = () => cache.nativeArtifactId;

if (typeof window !== 'undefined') {
  window.resetAlignedNarration = resetAlignedNarration;
  window.addEventListener('subtitle-timing-changed', resetAlignedNarration);
}
syncWindowState();
