import { Channel } from '@tauri-apps/api/core';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import { hasExactKeys, utf8ByteLength } from './plainDataRecord';
import {
  MAX_SPEECH_SEGMENTS,
  backendSet,
  desktopRequired,
  hasInvalidControls,
  hasReferenceTextControls,
  invalidRequest,
  invalidResponse,
  narrationCueKey,
  projectNarrationSources,
  requireInteger,
  requireUuid,
  runtimeStopped,
  voiceInventoryBackendSet,
} from './speechContract';
import {
  normalizeArtifactEdit,
  normalizeArtifactExport,
  normalizeProjectNarrationResultRequest,
  normalizeReferenceExtract,
  normalizeReferenceImport,
  normalizeReferenceSelection,
  normalizeSpeechStartRequest,
  normalizeVoiceConversionRequest,
} from './speechRequests';
import {
  normalizeBackendStatus,
  normalizeJobSnapshot,
  normalizePlayableArtifact,
  normalizeProjectNarrationResponse,
  normalizeProjectSpeechReference,
  normalizeProjectSpeechReferencePlayable,
  normalizeSpeechArtifact,
  normalizeSpeechInventory,
  normalizeSpeechJobResults,
  normalizeSpeechProbe,
  normalizeSpeechStatus,
} from './speechResponses';
import { createSpeechJobStarter } from './speechJobChannel';

export {
  CHATTERBOX_LANGUAGES,
  GEMINI_SPEECH_MODELS,
  GEMINI_SPEECH_VOICES,
  GTTS_DOMAINS,
  MAX_SPEECH_BATCH_BYTES,
  MAX_SPEECH_SEGMENTS,
  SpeechServiceError,
} from './speechContract';
export { normalizeSpeechProfile, normalizeSpeechStartRequest } from './speechRequests';
export { normalizeSpeechArtifact, normalizeSpeechStatus } from './speechResponses';

export const createSpeechLifecycleState = () => {
  const snapshots = new Map();
  const listeners = new Set();
  const apply = (status) => {
    const current = snapshots.get(status.backend);
    if (current && (status.epoch < current.epoch
        || (status.epoch === current.epoch
          && ((current.enabled && !status.enabled) || (current.warm && !status.warm))))) {
      return current;
    }
    snapshots.set(status.backend, status);
    for (const listener of [...listeners]) {
      try { listener(status); } catch { /* lifecycle observers cannot break native ownership */ }
    }
    return status;
  };
  return Object.freeze({
    apply,
    applyCatalog: (status) => status.backends.forEach(apply),
    getSnapshot: (backend) => snapshots.get(backend) || null,
    subscribe: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      snapshots.forEach((snapshot) => listener(snapshot));
      return () => listeners.delete(listener);
    },
  });
};

const speechLifecycleState = createSpeechLifecycleState();
export const getSpeechLifecycleSnapshot = (backend) => (
  speechLifecycleState.getSnapshot(backend)
);
export const subscribeSpeechLifecycle = (listener) => speechLifecycleState.subscribe(listener);

/**
 * Strict native-only speech bridge. Requests contain only typed settings and opaque IDs. Native
 * paths, provider secrets, audio bytes, model arguments, and HTTP fallback URLs are deliberately
 * outside this API.
 */
export const createNativeSpeechService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
  lifecycleState = speechLifecycleState,
} = {}) => {
  const requireNativeRuntime = () => {
    if (!isNativeRuntime()) throw desktopRequired();
  };

  const cancelSpeechJob = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuid(jobId, 7);
    const job = normalizeJobSnapshot(await invokeCommand('job_cancel', { id }));
    if (job.id !== id || job.state === 'queued' || job.state === 'running') {
      throw invalidResponse();
    }
    return job;
  };

  const startNativeJob = createSpeechJobStarter({
    invokeCommand,
    ChannelConstructor,
    lifecycleState,
    requireNativeRuntime,
    cancelSpeechJob,
  });

  const getSpeechStatus = async () => {
    requireNativeRuntime();
    const status = normalizeSpeechStatus(await invokeCommand('speech_status', {}));
    lifecycleState.applyCatalog(status);
    return status;
  };

  const probeSpeechBackend = async (backend) => {
    requireNativeRuntime();
    if (!backendSet.has(backend)) throw invalidRequest();
    const probe = normalizeSpeechProbe(await invokeCommand('speech_probe', { backend }), backend);
    lifecycleState.apply(probe.status);
    return probe;
  };

  const getSpeechVoiceInventory = async (backend, lifecycleEpoch) => {
    requireNativeRuntime();
    if (!voiceInventoryBackendSet.has(backend)) throw invalidRequest();
    const epoch = requireInteger(lifecycleEpoch, 0, Number.MAX_SAFE_INTEGER);
    const before = lifecycleState.getSnapshot(backend);
    if (before && (before.epoch !== epoch || !before.enabled || !before.warm)) {
      throw runtimeStopped();
    }
    const inventory = normalizeSpeechInventory(
      await invokeCommand('speech_voice_inventory', { backend, epoch }),
      backend
    );
    const after = lifecycleState.getSnapshot(backend);
    if (inventory.epoch !== epoch
        || (after && (after.epoch !== epoch || !after.enabled || !after.warm))) {
      throw runtimeStopped();
    }
    return inventory;
  };

  const stopSpeechRuntime = async (backend) => {
    requireNativeRuntime();
    if (!backendSet.has(backend)) throw invalidRequest();
    const status = normalizeBackendStatus(
      await invokeCommand('speech_runtime_stop', { backend })
    );
    if (status.backend !== backend || status.enabled || status.ready || status.warm) {
      throw invalidResponse();
    }
    lifecycleState.apply(status);
    return status;
  };

  const selectSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceSelection(request);
    const value = await invokeCommand('speech_reference_select', { request: normalized });
    return value === null ? null : normalizeProjectSpeechReferencePlayable(value);
  };

  const importSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceImport(request);
    return normalizeProjectSpeechReferencePlayable(
      await invokeCommand('speech_reference_import', { request: normalized }),
    );
  };

  const extractSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceExtract(request);
    return normalizeProjectSpeechReferencePlayable(
      await invokeCommand('speech_reference_extract', { request: normalized }),
    );
  };

  const getProjectSpeechReference = async (projectId) => {
    requireNativeRuntime();
    const id = requireUuid(projectId, 7);
    const value = await invokeCommand('speech_reference_get', { request: { projectId: id } });
    if (value === null) return null;
    const normalized = normalizeProjectSpeechReferencePlayable(value);
    if (normalized.reference.projectId !== id) throw invalidResponse();
    return normalized;
  };

  const commitProjectSpeechReference = async (request) => {
    requireNativeRuntime();
    if (!hasExactKeys(request, [
      'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion', 'artifactId',
      'transcript', 'language', 'deliveryJobId', 'deliveryId',
    ])
        || typeof request.transcript !== 'string'
        || utf8ByteLength(request.transcript) > 64 * 1024
        || typeof request.language !== 'string'
        || utf8ByteLength(request.language) < 1
        || utf8ByteLength(request.language) > 128
        || hasReferenceTextControls(request.transcript)
        || hasInvalidControls(request.language)
        || (request.deliveryJobId === null) !== (request.deliveryId === null)) {
      throw invalidRequest();
    }
    const normalizedRequest = Object.freeze({
      projectId: requireUuid(request.projectId, 7),
      expectedProjectStateVersion: requireInteger(
        request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
      ),
      expectedReferenceVersion: requireInteger(
        request.expectedReferenceVersion, 1, Number.MAX_SAFE_INTEGER
      ),
      artifactId: requireUuid(request.artifactId, 7),
      transcript: request.transcript,
      language: request.language,
      deliveryJobId: request.deliveryJobId === null
        ? null : requireUuid(request.deliveryJobId, 7),
      deliveryId: request.deliveryId === null ? null : requireUuid(request.deliveryId, 7),
    });
    const result = normalizeProjectSpeechReference(
      await invokeCommand('speech_reference_commit', { request: normalizedRequest })
    );
    if (result.projectId !== normalizedRequest.projectId
        || result.artifactId !== normalizedRequest.artifactId
        || result.referenceVersion !== normalizedRequest.expectedReferenceVersion + 1
        || result.transcript !== normalizedRequest.transcript
        || result.language !== normalizedRequest.language
        || (result.pendingDelivery?.jobId ?? null) !== normalizedRequest.deliveryJobId
        || (result.pendingDelivery?.deliveryId ?? null) !== normalizedRequest.deliveryId) {
      throw invalidResponse();
    }
    return result;
  };

  const clearProjectSpeechReference = async (request) => {
    requireNativeRuntime();
    if (!hasExactKeys(request, [
      'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion',
    ])) throw invalidRequest();
    const normalized = Object.freeze({
      projectId: requireUuid(request.projectId, 7),
      expectedProjectStateVersion: requireInteger(
        request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
      ),
      expectedReferenceVersion: requireInteger(
        request.expectedReferenceVersion, 1, Number.MAX_SAFE_INTEGER
      ),
    });
    const cleared = await invokeCommand('speech_reference_clear', { request: normalized });
    if (cleared !== true) throw invalidResponse();
    return true;
  };

  const startSpeechJob = async (request, handlers, options) => {
    const normalized = normalizeSpeechStartRequest(request);
    const before = lifecycleState.getSnapshot(normalized.profile.backend);
    if (before && (before.epoch !== normalized.lifecycleEpoch
        || !before.enabled || !before.warm)) {
      throw runtimeStopped();
    }
    const job = await startNativeJob({
      command: 'speech_start',
      request: normalized,
      ownership: {
        backend: normalized.profile.backend,
        epoch: normalized.lifecycleEpoch,
      },
      expectedSegmentIds: normalized.segments.map(({ id }) => id),
      handlers,
      options,
    });
    const after = lifecycleState.getSnapshot(normalized.profile.backend);
    if (after && (after.epoch !== normalized.lifecycleEpoch || !after.enabled || !after.warm)) {
      cancelSpeechJob(job.id).catch(() => undefined);
      throw runtimeStopped();
    }
    return job;
  };

  const startVoiceConversionJob = async (request, handlers, options) => {
    const normalized = normalizeVoiceConversionRequest(request);
    const before = lifecycleState.getSnapshot('chatterbox');
    if (!before
        || before.epoch !== normalized.lifecycleEpoch
        || !before.enabled
        || !before.warm) {
      throw runtimeStopped();
    }
    const job = await startNativeJob({
      command: 'speech_voice_conversion_start',
      request: normalized,
      ownership: { backend: 'chatterbox', epoch: normalized.lifecycleEpoch },
      expectedSegmentIds: ['voice-conversion'],
      handlers,
      options,
    });
    const after = lifecycleState.getSnapshot('chatterbox');
    if (!after
        || after.epoch !== normalized.lifecycleEpoch
        || !after.enabled
        || !after.warm) {
      await cancelSpeechJob(job.id).catch(() => undefined);
      throw runtimeStopped();
    }
    return job;
  };

  const getSpeechJobResults = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuid(jobId, 7);
    const value = normalizeSpeechJobResults(
      await invokeCommand('speech_job_results', { jobId: id })
    );
    if (value.job.id !== id) throw invalidResponse();
    return value;
  };

  const resolveSpeechArtifact = async (artifactId) => {
    requireNativeRuntime();
    const id = requireUuid(artifactId, 7);
    const value = normalizePlayableArtifact(
      await invokeCommand('speech_artifact_resolve', { artifactId: id })
    );
    if (value.artifact.artifactId !== id) throw invalidResponse();
    return value;
  };

  const releaseSpeechPlayback = async (playbackId) => {
    requireNativeRuntime();
    const id = requireUuid(playbackId, 4);
    const released = await invokeCommand('speech_playback_release', { playbackId: id });
    if (typeof released !== 'boolean') throw invalidResponse();
    return released;
  };

  const editSpeechArtifact = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeArtifactEdit(request);
    const value = await invokeCommand('speech_artifact_edit', { request: normalized });
    if (!hasExactKeys(value, [
      'projectId', 'expectedProjectStateVersion', 'artifact',
    ])
        || value.projectId !== normalized.projectId
        || value.expectedProjectStateVersion !== normalized.expectedProjectStateVersion) {
      throw invalidResponse();
    }
    const artifact = normalizeSpeechArtifact(value.artifact);
    if (artifact.artifactId === normalized.artifactId) throw invalidResponse();
    return Object.freeze({
      projectId: value.projectId,
      expectedProjectStateVersion: value.expectedProjectStateVersion,
      artifact,
    });
  };

  const putProjectNarration = async (request) => {
    requireNativeRuntime();
    if (!hasExactKeys(request, [
      'projectId', 'expectedProjectStateVersion', 'source', 'results',
    ])
        || !projectNarrationSources.has(request.source)
        || !Array.isArray(request.results)
        || request.results.length > MAX_SPEECH_SEGMENTS) {
      throw invalidRequest();
    }
    const normalized = Object.freeze({
      projectId: requireUuid(request.projectId, 7),
      expectedProjectStateVersion: requireInteger(
        request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
      ),
      source: request.source,
      results: Object.freeze(request.results.map(normalizeProjectNarrationResultRequest)),
    });
    const cueIds = new Set();
    const artifactIds = new Set();
    for (const result of normalized.results) {
      const cueKey = narrationCueKey(result.subtitleId);
      if (cueIds.has(cueKey) || artifactIds.has(result.artifactId)) throw invalidRequest();
      cueIds.add(cueKey);
      artifactIds.add(result.artifactId);
    }
    const stored = normalizeProjectNarrationResponse(
      await invokeCommand('speech_project_narration_put', { request: normalized })
    );
    if (stored.projectId !== normalized.projectId
        || stored.projectStateVersion !== normalized.expectedProjectStateVersion
        || stored.source !== normalized.source
        || stored.results.length !== normalized.results.length) {
      throw invalidResponse();
    }
    stored.results.forEach((result, index) => {
      const requested = normalized.results[index];
      if (!Object.is(result.subtitleId, requested.subtitleId)
          || result.text !== requested.text
          || result.artifact.artifactId !== requested.artifactId
          || result.method !== requested.method
          || result.outputIndex !== requested.outputIndex
          || result.startMicros !== requested.startMicros
          || result.endMicros !== requested.endMicros
          || result.originalIds.length !== requested.originalIds.length
          || result.originalIds.some((id, originalIndex) => (
            !Object.is(id, requested.originalIds[originalIndex])
          ))) throw invalidResponse();
    });
    return stored;
  };

  const getProjectNarration = async (projectId, source) => {
    requireNativeRuntime();
    const id = requireUuid(projectId, 7);
    if (!projectNarrationSources.has(source)) throw invalidRequest();
    const value = await invokeCommand('speech_project_narration_get', {
      projectId: id,
      source,
    });
    if (value === null) return null;
    const stored = normalizeProjectNarrationResponse(value);
    if (stored.projectId !== id || stored.source !== source) throw invalidResponse();
    return stored;
  };

  const exportSpeechArtifacts = async (request) => {
    requireNativeRuntime();
    const saved = await invokeCommand('speech_artifact_export', {
      request: normalizeArtifactExport(request),
    });
    if (typeof saved !== 'boolean') throw invalidResponse();
    return saved;
  };

  return Object.freeze({
    getSpeechStatus,
    getSpeechLifecycleSnapshot: lifecycleState.getSnapshot,
    subscribeSpeechLifecycle: lifecycleState.subscribe,
    probeSpeechBackend,
    getSpeechVoiceInventory,
    stopSpeechRuntime,
    selectSpeechReference,
    importSpeechReference,
    extractSpeechReference,
    getProjectSpeechReference,
    commitProjectSpeechReference,
    clearProjectSpeechReference,
    startSpeechJob,
    startVoiceConversionJob,
    cancelSpeechJob,
    getSpeechJobResults,
    resolveSpeechArtifact,
    releaseSpeechPlayback,
    editSpeechArtifact,
    putProjectNarration,
    getProjectNarration,
    exportSpeechArtifacts,
  });
};

const speechService = createNativeSpeechService();

export const getSpeechStatus = speechService.getSpeechStatus;
export const probeSpeechBackend = speechService.probeSpeechBackend;
export const getSpeechVoiceInventory = speechService.getSpeechVoiceInventory;
export const stopSpeechRuntime = speechService.stopSpeechRuntime;
export const startSpeechJob = speechService.startSpeechJob;
export const getSpeechJobResults = speechService.getSpeechJobResults;
export const resolveSpeechArtifact = speechService.resolveSpeechArtifact;
export const releaseSpeechPlayback = speechService.releaseSpeechPlayback;
export const putProjectNarration = speechService.putProjectNarration;
export const getProjectNarration = speechService.getProjectNarration;
export const exportSpeechArtifacts = speechService.exportSpeechArtifacts;
