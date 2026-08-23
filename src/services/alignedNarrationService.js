import { isDesktopRuntime } from '../platform/desktopRuntime';
import { flushDurableLyricsHistory } from '../platform/durableLyricsCheckpoint';
import { getActiveProjectSnapshot } from '../platform/projectService';
import {
  nativeNarrationAlignmentService,
  normalizeAlignmentRequest,
} from '../platform/narrationAlignmentService';
import {
  discardRecoveredNativeJob,
  ensureNativeJobRecoveryReady,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
} from '../platform/jobRecoveryCoordinator';
import {
  buildStrictNativeNarrationPlan,
  createNativeNarrationPlanKey,
} from '../utils/narrationAlignmentUtils';

const emptyCache = () => ({
  blob: null,
  url: null,
  filename: null,
  mode: null,
  previewPlan: null,
  nativeArtifactId: null,
  nativePlaybackId: null,
  nativeJobId: null,
  projectId: null,
  projectStateVersion: null,
  alignmentKey: null,
  timestamp: null,
  subtitleTimestamps: {},
});

let cache = emptyCache();
let audioElement = null;
let playbackRate = 1;
let volume = 1;
let recentAlignment = null;

const alignmentRecoveryError = (code, message, retryable, cause) => {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'AlignmentRecoveryError';
  error.code = code;
  error.retryable = retryable;
  return error;
};

const syncWindowState = () => {
  if (typeof window === 'undefined') return;
  window.alignedNarrationCache = cache;
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
  await ensureNativeJobRecoveryReady();
  for (const entry of listRecoveredNativeJobs('alignNarration')) {
    if (['queued', 'running', 'cancelling'].includes(entry.job.state)) {
      try {
        await nativeNarrationAlignmentService.cancelAlignmentJob(entry.job.id);
      } catch (error) {
        if (error?.code === 'jobNotFound') {
          discardRecoveredNativeJob(entry.job.id);
          continue;
        }
        throw alignmentRecoveryError(
          'alignmentRecoveryUnavailable',
          'A previous narration alignment could not be cancelled',
          true,
          error,
        );
      }
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

const buildNativeRequest = (items, authority) => normalizeAlignmentRequest({
  projectId: authority.projectId,
  expectedProjectStateVersion: authority.expectedProjectStateVersion,
  clips: items.map((item, index) => ({
    id: `segment-${index + 1}`,
    artifactId: item.nativeArtifactId,
    startMicros: secondsToMicros(item.start),
    cueEndMicros: secondsToMicros(item.end),
  })),
});

const cacheResolvedAlignment = async (
  result, jobId, subtitleTimestamps, alignmentKey, authority
) => {
  const playable = await nativeNarrationAlignmentService.resolveAlignmentArtifact(
    result.artifact.artifactId,
  );
  const latest = getActiveProjectSnapshot();
  if (latest?.metadata?.id !== authority.projectId
      || latest.stateVersion !== authority.expectedProjectStateVersion) {
    await nativeNarrationAlignmentService
      .releaseAlignmentPlayback(playable.playback.id)
      .catch(() => undefined);
    throw alignmentRecoveryError(
      'alignmentProjectChanged',
      'The active subtitle project changed while restoring narration alignment',
      false,
    );
  }
  releasePlayback(cache);
  resetAudioElement();
  setCache({
    ...emptyCache(),
    url: playable.playback.playbackUrl,
    mode: 'file',
    nativeArtifactId: result.artifact.artifactId,
    nativePlaybackId: playable.playback.id,
    nativeJobId: jobId,
    projectId: authority.projectId,
    projectStateVersion: authority.expectedProjectStateVersion,
    alignmentKey,
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

const restoreAlignment = async (request, subtitleTimestamps, alignmentKey) => {
  await ensureNativeJobRecoveryReady();
  const jobId = matchingRecentJobId(request);
  if (!jobId) {
    await discardUnmatchedRecoveredAlignments();
    return null;
  }
  let restored;
  try {
    restored = await nativeNarrationAlignmentService.getAlignmentResult(jobId);
    if (restored.result === null
        && ['queued', 'running', 'cancelling'].includes(restored.job.state)) {
      restored = await nativeNarrationAlignmentService.waitForAlignmentResult(jobId);
    }
    if (restored.result === null) {
      if (['failed', 'cancelled', 'interrupted'].includes(restored.job.state)) {
        clearRecentAlignment();
        return null;
      }
      if (['queued', 'running', 'cancelling'].includes(restored.job.state)) {
        throw alignmentRecoveryError(
          'alignmentRecoveryPending',
          'The previous narration alignment has not reached a terminal state',
          true,
        );
      }
      clearRecentAlignment();
      throw alignmentRecoveryError(
        'invalidAlignmentRecoveryResult',
        'The previous narration alignment has no durable result',
        false,
      );
    }
    forgetNativeJobId(jobId);
    if (restored.projectId !== request.projectId
        || restored.expectedProjectStateVersion !== request.expectedProjectStateVersion) {
      clearRecentAlignment();
      throw alignmentRecoveryError(
        'invalidAlignmentRecoveryResult',
        'The previous narration alignment belongs to a different project revision',
        false,
      );
    }
    return cacheResolvedAlignment(
      restored.result,
      jobId,
      subtitleTimestamps,
      alignmentKey,
      Object.freeze({
        projectId: request.projectId,
        expectedProjectStateVersion: request.expectedProjectStateVersion,
      }),
    );
  } catch (error) {
    if (error?.name === 'AlignmentRecoveryError') throw error;
    if (['alignmentUnavailable', 'alignmentCancelled'].includes(error?.code)) {
      clearRecentAlignment();
      return null;
    }
    if (['jobNotFound', 'invalidAlignmentRequest', 'invalidAlignmentResponse'].includes(error?.code)) {
      clearRecentAlignment();
      if (error?.code === 'jobNotFound') return null;
      throw alignmentRecoveryError(
        'invalidAlignmentRecoveryResult',
        'The previous narration alignment is invalid',
        false,
        error,
      );
    }
    throw alignmentRecoveryError(
      'alignmentRecoveryUnavailable',
      'The previous narration alignment could not be read',
      true,
      error,
    );
  }
};

const startAlignment = async (request, onProgress, subtitleTimestamps, alignmentKey) => {
  const restored = await restoreAlignment(request, subtitleTimestamps, alignmentKey);
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
    const latest = getActiveProjectSnapshot();
    if (latest?.metadata?.id !== request.projectId
        || latest.stateVersion !== request.expectedProjectStateVersion) {
      throw alignmentRecoveryError(
        'alignmentProjectChanged',
        'The active subtitle project changed during narration alignment',
        false,
      );
    }
    return await cacheResolvedAlignment(
      result,
      job.id,
      subtitleTimestamps,
      alignmentKey,
      Object.freeze({
        projectId: request.projectId,
        expectedProjectStateVersion: request.expectedProjectStateVersion,
      }),
    );
  } catch (error) {
    clearRecentAlignment();
    throw error;
  }
};

const prepareAlignedNarrationPreview = async (plan, onProgress = null) => {
  if (!isDesktopRuntime()) {
    throw new Error('Native narration alignment requires the desktop runtime.');
  }
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) {
    throw new Error('A strict native narration alignment plan is required.');
  }
  onProgress?.({ status: 'generating', message: 'Preparing aligned narration preview...' });
  await flushDurableLyricsHistory();
  const project = getActiveProjectSnapshot();
  if (!project?.metadata?.id
      || !Number.isSafeInteger(project.stateVersion)
      || plan.items.some((item) => item.projectId !== project.metadata.id)) {
    throw alignmentRecoveryError(
      'alignmentProjectChanged',
      'Narration audio does not belong to the active subtitle project',
      false,
    );
  }
  const request = buildNativeRequest(plan.items, Object.freeze({
    projectId: project.metadata.id,
    expectedProjectStateVersion: project.stateVersion,
  }));
  const alignmentKey = createNativeNarrationPlanKey(plan);
  const preview = await startAlignment(
    request,
    onProgress,
    plan.subtitleTimestamps,
    alignmentKey,
  );
  onProgress?.({ status: 'complete', message: 'Aligned narration ready' });
  return preview;
};

export const generateAlignedNarration = async (
  generationResults,
  currentCues,
  onProgress = null,
) => {
  try {
    onProgress?.({ status: 'preparing', message: 'Preparing aligned narration...' });
    const plan = buildStrictNativeNarrationPlan(generationResults, currentCues);
    if (cache.url && !cacheMatchesPlan(plan)) resetAlignedNarration();
    await prepareAlignedNarrationPreview(plan, onProgress);
    return 'aligned-preview://timeline';
  } catch (error) {
    onProgress?.({ status: 'error', message: `Error: ${error.message}` });
    throw error;
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

const cacheMatchesPlan = (plan) => (
  Boolean(cache.url)
  && Boolean(cache.nativeArtifactId)
  && cache.alignmentKey === createNativeNarrationPlanKey(plan)
);

export const isAlignedNarrationAvailableForPlan = (plan) => cacheMatchesPlan(plan);
export const getAlignedNarrationUrlForPlan = (plan) => (
  cacheMatchesPlan(plan) ? cache.url : null
);
export const getAlignedNarrationArtifactIdForPlan = (plan) => (
  cacheMatchesPlan(plan) ? cache.nativeArtifactId : null
);

if (typeof window !== 'undefined') {
  window.resetAlignedNarration = resetAlignedNarration;
  window.addEventListener('subtitle-timing-changed', resetAlignedNarration);
}
syncWindowState();
