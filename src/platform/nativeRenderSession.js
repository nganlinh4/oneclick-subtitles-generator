// The native render session factory: one `render_start` channel per job, ordered event delivery,
// cancellation, and ownership of the playback capability a completed render hands back.
import { Channel } from '@tauri-apps/api/core';

import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { createAbortMonitor, internalAbortMonitors } from './renderAbort';
import {
  cancelled,
  invalidRequest,
  invalidResponse,
  normalizeFailure,
  runtimeRequired,
} from './renderErrors';
import {
  extractCompletedPlaybackOwnership,
  extractPlaybackOwnership,
  normalizeExportText,
  normalizeRenderEvent,
  normalizeRenderJob,
  normalizeRenderResultResponse,
} from './renderResponse';
import { hasOnlyKeys, snapshotExactRecord, snapshotPlainRecord } from './plainDataRecord';
import { requireUuid, uuidHasVersion } from './renderValidation';

const MAX_PENDING_EVENTS = 4_096;
export const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'cancelling']);
const CANCELLATION_RESPONSE_STATES = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const RENDER_UNAVAILABLE_REASONS = new Set([
  'runtimePayloadUnavailable', 'mediaToolsUnavailable',
]);
const RENDER_PHASE_ORDER = new Map([
  'staging', 'extractingFrames', 'extractingAudio', 'loadingComposition',
  'renderingFrames', 'encoding', 'muxing', 'publishing',
].map((phase, index) => [phase, index]));

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  const allowed = [
    'onEvent', 'onProgress', 'onCompleted', 'onCancelled', 'onFailed', 'onProtocolError',
  ];
  const snapshot = snapshotPlainRecord(handlers);
  if (snapshot === null || !hasOnlyKeys(snapshot, allowed)
      || Object.values(snapshot).some(
        (handler) => handler !== undefined && typeof handler !== 'function'
      )) {
    throw invalidRequest();
  }
  return snapshot;
};

export const callSafely = (handler, value) => {
  if (typeof handler !== 'function') return;
  try {
    const returned = handler(value);
    if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
  } catch {
    // Presentation callbacks never own the native render lifecycle.
  }
};

export const createNativeRenderService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();
  const transferredPlaybackIds = new Set();
  const quarantinedPlaybackIds = new Set();

  const requireNative = () => {
    if (!isNativeRuntime()) throw runtimeRequired();
  };

  /**
   * Whether this build can render video natively, and why not when it cannot.
   *
   * The response used to carry a fifth field naming the browser renderer's version, which this
   * module compared against a frozen constant of its own. That pinned a dead field: the native side
   * could not drop it without failing every readiness check in the editor. The comparison went
   * first and the field followed, so the shape is now the three things the answer is actually about.
   */
  const status = async () => {
    requireNative();
    try {
      const response = await invokeCommand('render_runtime_status', {});
      const value = snapshotExactRecord(response, ['available', 'reason', 'maxConcurrentRenders']);
      if (value === null
        || typeof value.available !== 'boolean'
        || (value.reason !== null && !RENDER_UNAVAILABLE_REASONS.has(value.reason))
        || value.maxConcurrentRenders !== 1
        || (value.available && value.reason !== null)
        || (!value.available && value.reason === null)) {
        throw invalidResponse();
      }
      return Object.freeze({ ...value });
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const cancel = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    try {
      const job = normalizeRenderJob(await invokeCommand('job_cancel', { id }));
      if (job.id !== id || !CANCELLATION_RESPONSE_STATES.has(job.state)) {
        throw invalidResponse();
      }
      return job;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const releasePlayback = async (playbackId) => {
    requireNative();
    const id = requireUuid(playbackId, 4);
    try {
      const released = await invokeCommand('render_playback_release', { playbackId: id });
      if (typeof released !== 'boolean') throw invalidResponse();
      return released;
    } catch (error) {
      throw normalizeFailure(error);
    }
  };

  const quarantinePlayback = async (playbackId) => {
    if (transferredPlaybackIds.has(playbackId) || quarantinedPlaybackIds.has(playbackId)) {
      return false;
    }
    quarantinedPlaybackIds.add(playbackId);
    try {
      await releasePlayback(playbackId);
      return true;
    } catch {
      return false;
    }
  };

  const getResult = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    let rawResponse = null;
    try {
      rawResponse = await invokeCommand('render_result', { jobId: id });
      const response = normalizeRenderResultResponse(
        rawResponse
      );
      if (response.job.id !== id) throw invalidResponse();
      if (response.result !== null) {
        const playbackId = response.result.playback.id;
        if (transferredPlaybackIds.has(playbackId) || quarantinedPlaybackIds.has(playbackId)) {
          throw invalidResponse();
        }
        transferredPlaybackIds.add(playbackId);
      }
      return response;
    } catch (error) {
      const ownership = extractPlaybackOwnership(rawResponse);
      if (ownership !== null) await quarantinePlayback(ownership.playbackId);
      throw normalizeFailure(error);
    }
  };

  const start = async (request, rawHandlers, rawOptions = {}) => {
    requireNative();
    const ownedRequest = snapshotPlainRecord(request);
    if (ownedRequest === null
        || !uuidHasVersion(ownedRequest.sourceAssetId, 7)
        || !uuidHasVersion(ownedRequest.projectId, 7)) {
      throw invalidRequest();
    }
    const expectedSourceAssetId = ownedRequest.sourceAssetId;
    const expectedProjectId = ownedRequest.projectId;
    const options = snapshotPlainRecord(rawOptions);
    if (options === null
        || Object.keys(options).some((key) => !['signal', 'text'].includes(key))) {
      throw invalidRequest();
    }
    const signal = options.signal ?? null;
    const ownedText = options.text === undefined || options.text === null
      ? null
      : normalizeExportText(options.text, ownedRequest);
    const handlers = normalizeHandlers(rawHandlers);
    const channel = new ChannelConstructor();
    if (channel === null || typeof channel !== 'object') throw invalidRequest();
    const borrowedAbortMonitor = internalAbortMonitors.get(rawOptions) ?? null;
    const abortMonitor = borrowedAbortMonitor ?? createAbortMonitor(signal);
    const ownsAbortMonitor = borrowedAbortMonitor === null;
    if (abortMonitor?.isAborted()) {
      if (ownsAbortMonitor) abortMonitor.dispose();
      throw cancelled();
    }
    const pending = [];
    let initial = null;
    let lastSequence = null;
    let lastProgress = 0;
    let lastFraction = 0;
    let lastPhase = -1;
    let lastRenderedFrames = 0;
    let lastEncodedFrames = 0;
    let expectedDurationInFrames = null;
    let terminal = false;
    let protocolFailed = false;
    let protocolCancellation = null;
    const releasedPlaybacks = new Set();
    let transferredPlaybackId = null;

    const releaseUntransferredPlayback = (playbackId) => {
      if (playbackId === transferredPlaybackId) return;
      if (transferredPlaybackIds.has(playbackId)) return;
      if (releasedPlaybacks.has(playbackId)) return;
      releasedPlaybacks.add(playbackId);
      void quarantinePlayback(playbackId);
    };
    const quarantineCompletedPlayback = (value) => {
      const ownership = extractCompletedPlaybackOwnership(value);
      if (ownership !== null
          && (initial === null || ownership.jobId === null || ownership.jobId === initial.id)) {
        releaseUntransferredPlayback(ownership.playbackId);
      }
    };

    const issueCancellation = () => {
      if (initial === null || protocolCancellation !== null || terminal) {
        return protocolCancellation;
      }
      activeChannels.delete(initial.id);
      protocolCancellation = cancel(initial.id).catch(() => null);
      return protocolCancellation;
    };
    const onAbort = () => issueCancellation();
    let stopListeningForAbort = () => {};
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (initial !== null) activeChannels.delete(initial.id);
      try {
        stopListeningForAbort();
      } catch {
        // The internal observer is best-effort cleanup only.
      }
      if (ownsAbortMonitor) abortMonitor?.dispose();
    };
    stopListeningForAbort = abortMonitor?.listen(onAbort) ?? stopListeningForAbort;
    const protocolError = () => {
      if (protocolFailed) return;
      protocolFailed = true;
      for (const abandoned of pending.splice(0)) quarantineCompletedPlayback(abandoned);
      issueCancellation();
      if (initial !== null) release();
      callSafely(handlers.onProtocolError, invalidResponse());
    };
    const dispatch = (event) => {
      if (protocolFailed) return;
      const phase = event.event === 'progress' ? RENDER_PHASE_ORDER.get(event.phase) : null;
      if (terminal || event.job === null
          || event.job.id !== initial.id
          || event.job.sequence < lastSequence
          || event.job.progress.basisPoints < lastProgress
          || (event.event !== 'progress' && event.job.sequence <= lastSequence)
          || (event.event === 'progress' && (event.fractionMillionths < lastFraction
            || phase < lastPhase
            || (phase === lastPhase && (event.renderedFrames < lastRenderedFrames
              || event.encodedFrames < lastEncodedFrames))
            || (expectedDurationInFrames !== null
              && event.durationInFrames !== expectedDurationInFrames)))) {
        quarantineCompletedPlayback(event);
        protocolError();
        return;
      }
      if (event.event === 'completed'
          && (event.result.sourceAssetId !== expectedSourceAssetId
            || event.result.projectId !== expectedProjectId)) {
        releaseUntransferredPlayback(event.result.playback.id);
        protocolError();
        return;
      }
      lastSequence = event.job.sequence;
      lastProgress = event.job.progress.basisPoints;
      if (event.event === 'progress') {
        lastFraction = event.fractionMillionths;
        lastPhase = phase;
        lastRenderedFrames = event.renderedFrames;
        lastEncodedFrames = event.encodedFrames;
        expectedDurationInFrames ??= event.durationInFrames;
      }
      const isTerminalEvent = event.event !== 'progress';
      if (isTerminalEvent) terminal = true;
      if (event.event === 'completed') {
        if (typeof handlers.onEvent === 'function' || typeof handlers.onCompleted === 'function') {
          transferredPlaybackId = event.result.playback.id;
          transferredPlaybackIds.add(transferredPlaybackId);
        } else {
          releaseUntransferredPlayback(event.result.playback.id);
        }
      }
      if (isTerminalEvent) release();
      callSafely(handlers.onEvent, event);
      if (event.event === 'progress') callSafely(handlers.onProgress, event);
      if (event.event === 'completed') callSafely(handlers.onCompleted, event);
      if (event.event === 'cancelled') callSafely(handlers.onCancelled, event);
      if (event.event === 'failed') callSafely(handlers.onFailed, event);
    };
    const dispatchBuffered = () => {
      for (const event of pending.splice(0)) {
        if (protocolFailed || terminal) quarantineCompletedPlayback(event);
        else dispatch(event);
      }
    };
    channel.onmessage = (rawEvent) => {
      if (protocolFailed || terminal) {
        quarantineCompletedPlayback(rawEvent);
        return;
      }
      let event;
      try {
        event = normalizeRenderEvent(rawEvent);
      } catch {
        quarantineCompletedPlayback(rawEvent);
        protocolError();
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          quarantineCompletedPlayback(event);
          protocolError();
        } else {
          pending.push(event);
        }
        return;
      }
      dispatch(event);
    };

    let rawInitial;
    try {
      rawInitial = await invokeCommand('render_start', ownedText === null
        ? { request: ownedRequest, onEvent: channel }
        : { request: ownedRequest, text: ownedText, onEvent: channel });
    } catch (error) {
      if (!protocolFailed && pending.length > 0 && pending[0].job !== null) {
        initial = pending[0].job;
        lastSequence = -1;
        lastProgress = 0;
        lastFraction = 0;
        dispatchBuffered();
        if (!terminal) await issueCancellation();
      } else {
        for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      }
      release();
      throw normalizeFailure(error);
    }
    try {
      initial = normalizeRenderJob(rawInitial);
    } catch (error) {
      const snapshot = snapshotPlainRecord(rawInitial)?.id ?? null;
      if (uuidHasVersion(snapshot, 7)) {
        initial = Object.freeze({ id: snapshot });
        await issueCancellation();
      }
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw error;
    }
    if (initial.state !== 'running') {
      if (ACTIVE_JOB_STATES.has(initial.state)) await issueCancellation();
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw invalidResponse();
    }
    lastSequence = initial.sequence;
    lastProgress = initial.progress.basisPoints;
    if (protocolFailed || abortMonitor?.isAborted()) {
      await issueCancellation();
      for (const event of pending.splice(0)) quarantineCompletedPlayback(event);
      release();
      throw protocolFailed ? invalidResponse() : cancelled();
    }
    activeChannels.set(initial.id, channel);
    dispatchBuffered();
    if (protocolFailed) {
      await issueCancellation();
      release();
      throw invalidResponse();
    }
    return initial;
  };

  return Object.freeze({ status, start, getResult, cancel, releasePlayback });
};
