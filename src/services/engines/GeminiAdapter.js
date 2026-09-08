import { bindGeminiTranscriptionDeliveries } from '../gemini/transcriptionDelivery';
import {
  createRequestController,
  removeRequestController,
} from '../gemini/requestManagement';
import {
  cancelWordNativeTranscription,
  getNativeTranscriptionJob,
  isNativeWordTranscriptionSupported,
  startWordNativeTranscription,
} from '../../platform/nativeWordTranscription';
import { getActiveProjectSnapshot } from '../../platform/projectService';
import { setActiveTranscript } from '../../platform/transcriptStore';
import { normalizeSpeaker } from '../../utils/subtitleSpeaker';

const isProjectMismatch = (expectedProjectId) => {
  if (!expectedProjectId) return false;
  try {
    const active = getActiveProjectSnapshot?.();
    return Boolean(active?.metadata?.id && active.metadata.id !== expectedProjectId);
  } catch {
    return false;
  }
};

// The native media pipeline admits two clip operations. Matching that capacity prevents windows
// three and four from being rejected before they reach Gemini on a clean split-media run.
const MAX_ACTIVE_GEMINI_WINDOWS = 2;

const aborted = (signal) => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Gemini transcription was cancelled.');
  error.name = 'AbortError';
  return error;
};

const waitForLaunchSlot = (milliseconds, signal) => {
  if (signal.aborted) return Promise.reject(aborted(signal));
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
};

const windowIdentity = (windowIndex, value) => {
  if (value === null || value === undefined) return value;
  let encoded;
  try { encoded = JSON.stringify(value); } catch { encoded = String(value); }
  return `gemini-window-${windowIndex}:${typeof value}:${encoded}`;
};

// Every Gemini response numbers its own cues from one. Those identifiers are local to one request,
// but the merged track is persisted as one revision; carrying them across the merge produces
// duplicate legacy IDs and makes an otherwise successful four-window run impossible to save.
// Namespace both cue and lineage identities at the boundary where the window is still known.
const namespaceWindowRows = (rows, windowIndex) => rows.map((row) => {
  const next = { ...row };
  if (Object.hasOwn(next, 'id')) next.id = windowIdentity(windowIndex, next.id);
  if (Object.hasOwn(next, 'originalId')) {
    next.originalId = windowIdentity(windowIndex, next.originalId);
  }
  if (Object.hasOwn(next, 'sourceId')) {
    // The legacy persistence adapter resolves originalId against the other namespaced rows. An
    // explicit UUID would otherwise be checked against UUIDs that have not been assigned yet.
    next.originalId = windowIdentity(windowIndex, next.sourceId);
    delete next.sourceId;
  }
  return next;
});

/**
 * @typedef {{
 *  fps?: number,
 *  mediaResolution?: string,
 *  model?: string,
 *  userProvidedSubtitles?: string,
 *  maxDurationPerRequest?: number,
 *  autoSplitSubtitles?: boolean,
 *  maxWordsPerSubtitle?: number,
 *  forceInline?: boolean,
 *  noOffsets?: boolean
 * }} GeminiOptions
 */

/**
 * @typedef {{
 *  onStatus?: (s:{message:string,type:'loading'|'success'|'warning'|'error'|'info'})=>void,
 *  onStreamingUpdate?: (subs:Array<{start:number,end:number,text:string}>, isStreaming:boolean)=>void,
 *  t?: Function
 * }} GeminiHooks
 */

/**
 * Process a specific segment using Gemini streaming pipeline.
 * Delegates to processSegmentWithStreaming and forwards updates.
 *
 * @param {File|{assetId:string,name:string,type:string}} file
 * @param {{start:number,end:number}} segment
 * @param {GeminiOptions} options
 * @param {GeminiHooks} hooks
 * @returns {Promise<Array>} final subtitles for the segment
 */
export const processGeminiSegment = async (file, segment, options, hooks = {}) => {
  const { onStatus, onStreamingUpdate, t } = hooks;

  const isExplicitTranscribe = (
    options?.model === 'gemini-3.5-transcribe'
    || options?.engine === 'gemini-3.5-transcribe'
    || options?.engine === 'gemini-transcribe'
    || options?.task === 'native-transcribe'
  ) && !options?.forceLegacy;

  if (isNativeWordTranscriptionSupported() && isExplicitTranscribe) {
    return new Promise((resolve, reject) => {
      const requestCtrl = createRequestController(options?.signal);
      let taskId = null;
      let finished = false;
      let currentCues = [];
      const nativeRanges = new Map();
      let allWords = [];
      let allTurns = [];
      let latestRevisionId = null;
      let reconciliationTimer = null;
      let terminalObservedAt = null;
      const speakerNames = new Map();
      const projectSpeaker = (id) => {
        if (id == null) return null;
        if (!speakerNames.has(id)) speakerNames.set(id, t?.('lyrics.speakerName', { number: speakerNames.size + 1 }) || `Speaker ${speakerNames.size + 1}`);
        return normalizeSpeaker({ id, name: speakerNames.get(id), labelStyle: 'hidden' });
      };

      const cleanup = () => {
        if (reconciliationTimer !== null) clearTimeout(reconciliationTimer);
        removeRequestController(requestCtrl.requestId);
        requestCtrl.signal.removeEventListener('abort', onAbort);
      };

      const finish = (result) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(result);
      };

      const fail = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        reject(err);
      };

      const onAbort = () => {
        if (taskId) {
          Promise.resolve().then(() => cancelWordNativeTranscription(taskId)).catch(() => {});
        }
        fail(aborted(requestCtrl.signal));
      };

      const reconcileTerminalJob = async () => {
        if (finished || !taskId) return;
        try {
          const snapshot = await getNativeTranscriptionJob(taskId);
          if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(snapshot?.state)) {
            terminalObservedAt ??= Date.now();
            if (Date.now() - terminalObservedAt >= 2_000) {
              if (snapshot.state === 'succeeded' && currentCues.length > 0) {
                setActiveTranscript({
                  projectId: options?.projectId,
                  revisionId: latestRevisionId,
                  words: allWords,
                  turns: allTurns,
                });
                onStreamingUpdate?.(currentCues, false, {
                  segmentComplete: true,
                  words: allWords,
                  turns: allTurns,
                  revisionId: latestRevisionId,
                });
                currentCues.words = allWords;
                currentCues.turns = allTurns;
                if (latestRevisionId) currentCues.revisionId = latestRevisionId;
                finish(currentCues);
                return;
              }
              const error = new Error(snapshot.state === 'succeeded'
                ? 'Transcription completed, but its result event was not delivered.'
                : `Transcription ended with state: ${snapshot.state}`);
              error.code = 'transcriptionTerminalEventMissing';
              fail(error);
              return;
            }
          } else {
            terminalObservedAt = null;
          }
        } catch {
          // The event channel remains authoritative. A transient status read must not stop it.
        }
        if (!finished) reconciliationTimer = setTimeout(reconcileTerminalJob, 1_000);
      };

      if (requestCtrl.signal.aborted) {
        onAbort();
        return;
      }
      requestCtrl.signal.addEventListener('abort', onAbort, { once: true });

      startWordNativeTranscription({
        projectId: options?.projectId,
        expectedProjectStateVersion: options?.expectedProjectStateVersion,
        mediaAssetId: file?.assetId || options?.mediaAssetId || options?.assetId,
        filePath: file?.path || file?.filePath || options?.filePath,
        rangeStartMs: segment?.start != null ? Math.round(segment.start * 1000) : undefined,
        rangeEndMs: segment?.end != null ? Math.round(segment.end * 1000) : undefined,
        windowDurationMs: options?.maxDurationPerRequest != null ? Math.round(options.maxDurationPerRequest * 1000) : undefined,
        windowDurationSecs: options?.windowDurationSecs,
        languageHints: options?.languageHints || (options?.language ? [options.language] : undefined),
        diarization: options?.diarization,
        credentialId: options?.credentialId,
        ...(options?.livePreview ? { config: { livePreview: true } } : {}),
      }, {
        onWindowProgress: (event) => {
          if (finished || isProjectMismatch(options?.projectId)) return;
          if (nativeRanges.has(event.windowIndex)) return;
          nativeRanges.set(event.windowIndex, {
            index: event.windowIndex,
            start: event.windowStartMs / 1000,
            end: event.windowEndMs / 1000,
            totalSegments: event.totalWindows,
            isParallel: event.totalWindows > 1,
            originalSegment: segment,
          });
          window.dispatchEvent(new CustomEvent('processing-ranges', {
            detail: { ranges: [...nativeRanges.values()].sort((a, b) => a.index - b.index) },
          }));
        },
        onLiveDraft: (event) => {
          if (finished || isProjectMismatch(options?.projectId)) return;
          if (event.text == null) {
            onStatus?.({ message: t?.('processing.liveDraftUnavailable') ?? 'Live drafts unavailable; timed transcription continues.', type: 'warning' });
          }
          onStreamingUpdate?.(currentCues, true, { projectId: options.projectId, liveDraft: event });
        },
        onStageChanged: (event) => {
          onStatus?.({ message: event.message, type: 'loading' });
        },
        onWindowPromoted: (event) => {
          if (finished) return;
          if (isProjectMismatch(options?.projectId)) {
            return;
          }
          if (event.revisionId) latestRevisionId = event.revisionId;
          if (Array.isArray(event.words)) allWords.push(...event.words);
          if (Array.isArray(event.turns)) allTurns.push(...event.turns);

          const newlyProjected = (event.projectedCues || []).map((cue) => ({
            id: cue.id,
            originalId: cue.id,
            start: cue.startMs / 1000,
            end: cue.endMs / 1000,
            text: cue.text,
            speaker: projectSpeaker(cue.speakerId),
            wordIds: cue.wordIds,
          }));
          currentCues.push(...newlyProjected);
          const isStreaming = event.windowIndex + 1 < event.totalWindows;
          onStreamingUpdate?.(currentCues, isStreaming, {
            segmentIndex: event.windowIndex,
            totalSegments: event.totalWindows,
            segmentComplete: true,
            words: allWords,
            turns: allTurns,
            revisionId: event.revisionId || latestRevisionId,
          });
        },
        onCompleted: (event) => {
          const finalRevisionId = event.revisionId || latestRevisionId;
          if (isProjectMismatch(options?.projectId)) {
            finish(currentCues);
            return;
          }
          if (Array.isArray(event.projectedCues) && event.projectedCues.length > 0) {
            currentCues = event.projectedCues.map((cue) => ({
              id: cue.id,
              originalId: cue.id,
              start: cue.startMs / 1000,
              end: cue.endMs / 1000,
              text: cue.text,
              speaker: projectSpeaker(cue.speakerId),
              wordIds: cue.wordIds,
            }));
          }
          if (Array.isArray(event.words)) {
            allWords = event.words;
          }
          if (Array.isArray(event.turns)) {
            allTurns = event.turns;
          }

          // Durably hydrate transcript store so word highlights and Transcript view are immediately populated
          setActiveTranscript({
            projectId: options?.projectId,
            revisionId: finalRevisionId,
            words: allWords,
            turns: allTurns,
          });

          onStreamingUpdate?.(currentCues, false, {
            segmentComplete: true,
            words: allWords,
            turns: allTurns,
            revisionId: finalRevisionId,
          });
          currentCues.words = allWords;
          currentCues.turns = allTurns;
          if (finalRevisionId) currentCues.revisionId = finalRevisionId;
          finish(currentCues);
        },
        onCancelled: () => {
          fail(aborted(options?.signal));
        },
        onFailed: (event) => {
          const err = new Error(event.error?.message || 'Native transcription failed');
          if (event.error?.code) err.code = event.error.code;
          fail(err);
        },
        onError: (err) => {
          fail(err);
        },
      })
      .then((snapshot) => {
        if (finished) return;
        taskId = snapshot?.id;
        if (options?.signal?.aborted) {
          onAbort();
        } else reconciliationTimer = setTimeout(reconcileTerminalJob, 1_000);
      })
      .catch(fail);
    });
  }

  const [processing, parallel] = await Promise.all([
    import('../../utils/videoProcessing/processingUtils'),
    import('../../utils/parallelProcessingUtils'),
  ]);
  const { processSegmentWithStreaming } = processing;
  const { mergeParallelSubtitles, splitSegmentForParallelProcessing } = parallel;

  const maximum = Number(options?.maxDurationPerRequest);
  const windows = Number.isFinite(maximum) && maximum > 0
    ? splitSegmentForParallelProcessing(segment, maximum)
    : [{ ...segment, index: 0, totalSegments: 1, isParallel: false }];

  if (windows.length === 1) {
    return processSegmentWithStreaming(
      file,
      segment,
      options,
      (status) => onStatus?.(status),
      (subtitles, isStreaming, chunkInfo) => {
        onStreamingUpdate?.(subtitles, isStreaming, chunkInfo);
      },
      t
    );
  }

  // Native Gemini accepts exactly one bounded media asset per job. The old Files-API coordinator
  // disappeared during the native migration, leaving maxDurationPerRequest as a UI-only promise.
  // Coordinate one clipping-aware native job per window here, above each window's independent JSON
  // stream parser, then merge presentation rows and delivery capabilities only at the boundary.
  const ownerSignal = options?.signal;
  const batchController = new AbortController();
  const abortBatch = () => batchController.abort(ownerSignal?.reason);
  if (ownerSignal?.aborted) abortBatch();
  else ownerSignal?.addEventListener?.('abort', abortBatch, { once: true });

  const segmentRows = windows.map(() => []);
  const results = windows.map(() => null);
  let completed = 0;
  const mergedRows = () => mergeParallelSubtitles(windows.map((window, index) => ({
    segment: window,
    subtitles: segmentRows[index],
  })));
  const launchDelayMs = Math.max(0, Number(options?.segmentProcessingDelay) || 0) * 1_000;
  const launchEpoch = Date.now();

  const processWindow = async (window, index) => {
    const scheduledAt = launchEpoch + index * launchDelayMs;
    await waitForLaunchSlot(Math.max(0, scheduledAt - Date.now()), batchController.signal);
    const result = await processSegmentWithStreaming(
      file,
      window,
      {
        ...options,
        // This exact child is already bounded. Leaving the parent maximum attached would let a
        // lower layer silently split it a second time if the implementation changes later.
        maxDurationPerRequest: undefined,
        signal: batchController.signal,
      },
      (status) => onStatus?.(status),
      (subtitles, isStreaming) => {
        if (!Array.isArray(subtitles)) return;
        segmentRows[index] = namespaceWindowRows(subtitles, index);
        onStreamingUpdate?.(mergedRows(), isStreaming || completed < windows.length, {
          segmentIndex: index,
          totalSegments: windows.length,
          actualSegment: window,
        });
      },
      t
    );
    const namespacedResult = namespaceWindowRows(result, index);
    segmentRows[index] = namespacedResult;
    results[index] = bindGeminiTranscriptionDeliveries(namespacedResult, result);
    completed += 1;
    onStreamingUpdate?.(mergedRows(), completed < windows.length, {
      segmentIndex: index,
      totalSegments: windows.length,
      actualSegment: window,
      segmentComplete: true,
    });
  };

  try {
    // Clip creation performs real native decode/encode work. A worker pool prevents an hours-long
    // source from starting dozens of native encoders and provider uploads simultaneously.
    let nextWindow = 0;
    const worker = async () => {
      while (nextWindow < windows.length) {
        const index = nextWindow;
        nextWindow += 1;
        await processWindow(windows[index], index);
      }
    };
    const workerCount = Math.min(MAX_ACTIVE_GEMINI_WINDOWS, windows.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  } catch (error) {
    batchController.abort(error);
    throw error;
  } finally {
    ownerSignal?.removeEventListener?.('abort', abortBatch);
  }

  const finalSubtitles = mergedRows();
  return bindGeminiTranscriptionDeliveries(finalSubtitles, ...results);
};
