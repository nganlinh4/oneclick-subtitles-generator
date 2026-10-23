import {
  createNativeSpeechService,
  normalizeSpeechStartRequest,
} from './speechService';
import { createNativeNarrationToken } from './nativeNarrationCapabilities';
import {
  createNativeSpeechProfile,
  invalid,
  legacyMethod,
  normalizeCallbacks,
  normalizeSubtitles,
  playableReference,
  referenceId,
  requireLifecycleEpoch,
  requireMethod,
  requireRequestKeys,
  requireUuid,
  resultFromNative,
  safelyCall,
} from './nativeNarrationRequests';

/**
 * Logic-only migration adapter for the existing narration hooks. It intentionally does not read
 * browser storage, fetch localhost services, accept filesystem paths, or persist playback tokens.
 */
export const createNativeNarrationAdapter = ({
  speech = createNativeSpeechService(),
} = {}) => {
  const selectReference = async (rawRequest) => {
    const {
      method, projectId, expectedProjectStateVersion, expectedReferenceVersion,
    } = requireRequestKeys(rawRequest, new Set([
      'method', 'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion',
    ]));
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    const selected = await speech.selectSpeechReference({
      backend,
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
      expectedReferenceVersion: requireLifecycleEpoch(expectedReferenceVersion),
    });
    return selected === null ? null : playableReference(selected);
  };

  const importReference = async (rawRequest) => {
    const {
      method, assetId, projectId, expectedProjectStateVersion, expectedReferenceVersion,
    } = requireRequestKeys(
      rawRequest,
      new Set([
        'method', 'assetId', 'projectId', 'expectedProjectStateVersion',
        'expectedReferenceVersion',
      ])
    );
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    return playableReference(await speech.importSpeechReference({
      backend,
      assetId: requireUuid(assetId, 7),
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
      expectedReferenceVersion: requireLifecycleEpoch(expectedReferenceVersion),
    }));
  };

  const extractReference = async (rawRequest) => {
    const {
      method, startMs, endMs, projectId, expectedProjectStateVersion,
      expectedReferenceVersion,
    } = requireRequestKeys(
      rawRequest,
      new Set([
        'method', 'startMs', 'endMs', 'projectId', 'expectedProjectStateVersion',
        'expectedReferenceVersion',
      ])
    );
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    return playableReference(await speech.extractSpeechReference({
      backend,
      startMs,
      endMs,
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
      expectedReferenceVersion: requireLifecycleEpoch(expectedReferenceVersion),
    }));
  };

  const getReference = async (projectId) => {
    const value = await speech.getProjectSpeechReference(requireUuid(projectId, 7));
    return value === null ? null : playableReference(value);
  };

  const commitReference = async (rawRequest) => {
    const request = requireRequestKeys(rawRequest, new Set([
      'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion', 'artifactId',
      'transcript', 'language', 'deliveryJobId', 'deliveryId',
    ]));
    return speech.commitProjectSpeechReference(request);
  };

  const clearReference = async (rawRequest) => {
    const request = requireRequestKeys(rawRequest, new Set([
      'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion',
    ]));
    return speech.clearProjectSpeechReference(request);
  };

  const releasePlayback = async (value) => {
    const playbackId = typeof value === 'string' ? value : value?.nativePlaybackId;
    return speech.releaseSpeechPlayback(requireUuid(playbackId, 4));
  };

  const resolvePlayback = async (result) => {
    const artifactId = typeof result === 'string' ? result : result?.nativeArtifactId;
    const playable = await speech.resolveSpeechArtifact(requireUuid(artifactId, 7));
    return Object.freeze({
      nativeArtifactId: playable.artifact.artifactId,
      nativePlaybackId: playable.playback.id,
      audioUrl: playable.playback.playbackUrl,
      mimeType: playable.playback.mimeType,
      bytes: playable.playback.byteLength,
    });
  };

  const generate = async (rawRequest, rawCallbacks, options) => {
    const requestValue = requireRequestKeys(
      rawRequest,
      new Set([
        'method', 'projectId', 'expectedProjectStateVersion', 'lifecycleEpoch',
        'subtitles', 'settings', 'reference',
      ]),
      new Set([
        'method', 'projectId', 'expectedProjectStateVersion', 'lifecycleEpoch', 'subtitles',
      ])
    );
    const {
      method,
      projectId,
      expectedProjectStateVersion,
      lifecycleEpoch,
      subtitles,
      settings = {},
      reference = null,
    } = requestValue;
    const backend = requireMethod(method);
    const usesReference = backend === 'f5Tts' || backend === 'chatterbox';
    if (!usesReference && reference !== null) throw invalid();
    const mappings = normalizeSubtitles(subtitles);
    const byNativeId = new Map(mappings.map((mapping) => [mapping.nativeId, mapping]));
    const profile = createNativeSpeechProfile(backend, settings);
    const callbacks = normalizeCallbacks(rawCallbacks);
    const authority = Object.freeze({
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
    });
    const mapResult = (result) => {
      const mapping = byNativeId.get(result.segmentId);
      if (mapping === undefined) throw invalid();
      return resultFromNative(result, mapping, backend, authority);
    };
    const handlers = {
      onEvent: (event) => safelyCall(callbacks.onEvent, event),
      onProgress: (event) => safelyCall(callbacks.onProgress, Object.freeze({
        current: event.index,
        total: event.total,
        subtitle_id: event.segmentId === null
          ? null
          : byNativeId.get(event.segmentId)?.subtitleId ?? null,
        phase: event.phase,
        fraction: event.fractionMillionths / 1_000_000,
      })),
      onSegmentCompleted: (event) => {
        const result = mapResult(event.result);
        safelyCall(callbacks.onResult, result, event.index, event.total);
      },
      onSegmentFailed: (event) => {
        const result = mapResult(event.result);
        safelyCall(callbacks.onResult, result, event.index, event.total);
      },
      onCompleted: (event) => safelyCall(callbacks.onComplete, event.results.map(mapResult)),
      onCancelled: (event) => safelyCall(callbacks.onCancelled, event.results.map(mapResult)),
      onFailed: (event) => safelyCall(callbacks.onError, Object.freeze({
        code: event.code,
        results: event.results.map(mapResult),
      })),
      onProtocolError: (error) => safelyCall(callbacks.onProtocolError, error),
    };
    const request = normalizeSpeechStartRequest({
      projectId: authority.projectId,
      expectedProjectStateVersion: authority.expectedProjectStateVersion,
      segments: mappings.map(({ nativeId, text }) => ({ id: nativeId, text })),
      profile,
      referenceArtifactId: usesReference
        ? referenceId(reference)
        : null,
      lifecycleEpoch,
    });
    const job = await speech.startSpeechJob(request, handlers, options);
    return Object.freeze({
      job,
      method: legacyMethod[backend],
      initialResults: Object.freeze(mappings.map((mapping) => Object.freeze({
        subtitle_id: mapping.subtitleId,
        text: mapping.text,
        pending: true,
        success: false,
        filename: null,
        audioData: null,
        outputIndex: mapping.outputIndex,
        original_ids: mapping.originalIds,
        start: mapping.start,
        end: mapping.end,
        method: legacyMethod[backend],
        projectId: authority.projectId,
        projectStateVersion: authority.expectedProjectStateVersion,
      }))),
    });
  };

  const restore = async (rawRequest) => {
    const {
      jobId, method, projectId, expectedProjectStateVersion, subtitles,
    } = requireRequestKeys(
      rawRequest,
      new Set(['jobId', 'method', 'projectId', 'expectedProjectStateVersion', 'subtitles']),
      new Set(['jobId', 'method', 'projectId', 'expectedProjectStateVersion', 'subtitles'])
    );
    const backend = requireMethod(method);
    const authority = Object.freeze({
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
    });
    const mappings = normalizeSubtitles(subtitles);
    const byNativeId = new Map(mappings.map((mapping) => [mapping.nativeId, mapping]));
    const restored = await speech.getSpeechJobResults(jobId);
    if (restored.backend !== backend
        || restored.projectId !== authority.projectId
        || restored.expectedProjectStateVersion !== authority.expectedProjectStateVersion) {
      throw invalid();
    }
    const results = restored.results.map((result) => {
      const mapping = byNativeId.get(result.segmentId);
      if (mapping === undefined) throw invalid();
      return resultFromNative(result, mapping, backend, authority);
    });
    return Object.freeze({
      job: restored.job,
      projectId: authority.projectId,
      expectedProjectStateVersion: authority.expectedProjectStateVersion,
      results: Object.freeze(results),
    });
  };

  const convertVoice = async (rawRequest, callbacks, options) => {
    const { input, targetVoice, lifecycleEpoch } = requireRequestKeys(
      rawRequest,
      new Set(['input', 'targetVoice', 'lifecycleEpoch']),
      new Set(['input', 'targetVoice', 'lifecycleEpoch'])
    );
    const normalizedCallbacks = normalizeCallbacks(callbacks);
    const mapConversionResult = (result) => result.status === 'completed'
      ? Object.freeze({
        success: true,
        pending: false,
        nativeArtifactId: result.artifact.artifactId,
        nativeFormat: result.artifact.format,
        durationMicros: result.artifact.durationMicros,
        filename: createNativeNarrationToken(result.artifact.artifactId),
        audioData: null,
      })
      : Object.freeze({
        success: false,
        pending: false,
        nativeArtifactId: null,
        errorCode: result.code,
        retryable: result.retryable,
      });
    return speech.startVoiceConversionJob({
      inputArtifactId: referenceId(input),
      targetVoiceArtifactId: referenceId(targetVoice),
      lifecycleEpoch: requireLifecycleEpoch(lifecycleEpoch),
    }, {
      onProgress: (event) => safelyCall(normalizedCallbacks.onProgress, event),
      onSegmentCompleted: (event) => safelyCall(
        normalizedCallbacks.onResult,
        mapConversionResult(event.result),
        1,
        1
      ),
      onSegmentFailed: (event) => safelyCall(
        normalizedCallbacks.onResult,
        mapConversionResult(event.result),
        1,
        1
      ),
      onCompleted: (event) => safelyCall(
        normalizedCallbacks.onComplete,
        event.results.map(mapConversionResult)
      ),
      onCancelled: (event) => safelyCall(
        normalizedCallbacks.onCancelled,
        event.results.map(mapConversionResult)
      ),
      onFailed: (event) => safelyCall(normalizedCallbacks.onError, Object.freeze({
        code: event.code,
        results: event.results.map(mapConversionResult),
      })),
      onProtocolError: (error) => safelyCall(normalizedCallbacks.onProtocolError, error),
    }, options);
  };

  const editArtifact = async (rawRequest) => {
    const requestValue = requireRequestKeys(
      rawRequest,
      new Set([
        'artifactId', 'projectId', 'expectedProjectStateVersion',
        'normalizedStart', 'normalizedEnd', 'speedFactor',
      ]),
      new Set(['artifactId', 'projectId', 'expectedProjectStateVersion'])
    );
    const {
      artifactId,
      projectId,
      expectedProjectStateVersion,
      normalizedStart = 0,
      normalizedEnd = 1,
      speedFactor = 1,
    } = requestValue;
    const authority = Object.freeze({
      projectId: requireUuid(projectId, 7),
      expectedProjectStateVersion: requireLifecycleEpoch(expectedProjectStateVersion),
    });
    const edited = await speech.editSpeechArtifact({
      artifactId: requireUuid(artifactId, 7),
      ...authority,
      normalizedStart,
      normalizedEnd,
      speedFactor,
    });
    if (edited.projectId !== authority.projectId
        || edited.expectedProjectStateVersion !== authority.expectedProjectStateVersion) {
      throw invalid();
    }
    return Object.freeze({
      ...edited.artifact,
      projectId: edited.projectId,
      projectStateVersion: edited.expectedProjectStateVersion,
    });
  };

  return Object.freeze({
    getStatus: speech.getSpeechStatus,
    probe: speech.probeSpeechBackend,
    stopRuntime: speech.stopSpeechRuntime,
    cancel: speech.cancelSpeechJob,
    selectReference,
    importReference,
    extractReference,
    getReference,
    commitReference,
    clearReference,
    releasePlayback,
    resolvePlayback,
    generate,
    restore,
    convertVoice,
    editArtifact,
  });
};

export const nativeNarrationAdapter = createNativeNarrationAdapter();
