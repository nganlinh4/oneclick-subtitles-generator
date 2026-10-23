// Response-side normalizers for the native speech bridge: host replies and channel events are
// accepted only in their exact documented shape.
import {
  hasExactKeys,
  isPlainDataRecord,
  utf8ByteLength,
} from './plainDataRecord';
import {
  backendSet,
  failureCodeSet,
  formatSet,
  geminiVoiceSet,
  GEMINI_SPEECH_VOICES,
  genderSet,
  hasInvalidControls,
  hasReferenceTextControls,
  invalidResponse,
  jobStateSet,
  MAX_ARTIFACT_BYTES,
  MAX_PROJECT_NARRATION_MICROS,
  MAX_REFERENCE_BYTES,
  MAX_SEGMENT_TEXT_BYTES,
  MAX_SPEECH_BATCH_BYTES,
  MAX_SPEECH_SEGMENTS,
  MAX_TIME_MICROS,
  MAX_VOICES,
  narrationCueKey,
  normalizeNarrationCueId,
  phaseSet,
  projectNarrationMethods,
  projectNarrationSources,
  requireResponseIdentifier,
  requireResponseInteger,
  requireResponseLanguage,
  resultStatusSet,
  SPEECH_BACKENDS,
  uuidHasVersion,
  voiceInventoryBackendSet,
} from './speechContract';

export const normalizeJobSnapshot = (snapshot) => {
  if (!hasExactKeys(snapshot, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !hasExactKeys(snapshot.progress, ['basisPoints'])
      || !uuidHasVersion(snapshot.id, 7)
      || snapshot.kind !== 'synthesizeNarration'
      || !jobStateSet.has(snapshot.state)) {
    throw invalidResponse();
  }
  const basisPoints = requireResponseInteger(snapshot.progress.basisPoints, 0, 10_000);
  const sequence = requireResponseInteger(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER);
  const validState = snapshot.state === 'queued'
    ? basisPoints === 0 && sequence === 0
    : snapshot.state === 'succeeded'
      ? basisPoints === 10_000 && sequence >= 2
      : sequence >= 1;
  if (!validState) throw invalidResponse();
  return Object.freeze({
    id: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    progress: Object.freeze({ basisPoints }),
    sequence,
  });
};

export const normalizeBackendStatus = (status) => {
  if (!hasExactKeys(status, [
    'backend',
    'epoch',
    'enabled',
    'installed',
    'ready',
    'warm',
    'requiresReference',
    'supportsVoiceInventory',
    'supportsVoiceConversion',
    'requiresCredential',
  ]) || !backendSet.has(status.backend)) {
    throw invalidResponse();
  }
  const epoch = requireResponseInteger(status.epoch, 0, Number.MAX_SAFE_INTEGER);
  for (const key of [
    'enabled',
    'installed',
    'ready',
    'warm',
    'requiresReference',
    'supportsVoiceInventory',
    'supportsVoiceConversion',
    'requiresCredential',
  ]) {
    if (typeof status[key] !== 'boolean') throw invalidResponse();
  }
  const expected = {
    requiresReference: status.backend === 'f5Tts' || status.backend === 'chatterbox',
    supportsVoiceInventory: voiceInventoryBackendSet.has(status.backend),
    supportsVoiceConversion: status.backend === 'chatterbox',
    requiresCredential: status.backend === 'geminiTts',
  };
  if (status.ready !== (status.installed && status.enabled)
      || (status.warm && (!status.ready || !status.enabled))
      || Object.entries(expected).some(([key, value]) => status[key] !== value)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...status, epoch });
};

export const normalizeSpeechStatus = (status) => {
  if (!hasExactKeys(status, ['backends', 'maxSegmentsPerJob', 'maxBatchTextBytes'])
      || !Array.isArray(status.backends)
      || status.backends.length !== SPEECH_BACKENDS.length
      || status.maxSegmentsPerJob !== MAX_SPEECH_SEGMENTS
      || status.maxBatchTextBytes !== MAX_SPEECH_BATCH_BYTES) {
    throw invalidResponse();
  }
  const byBackend = new Map();
  for (const rawBackend of status.backends) {
    const backend = normalizeBackendStatus(rawBackend);
    if (byBackend.has(backend.backend)) throw invalidResponse();
    byBackend.set(backend.backend, backend);
  }
  if (SPEECH_BACKENDS.some((backend) => !byBackend.has(backend))) throw invalidResponse();
  return Object.freeze({
    backends: Object.freeze(SPEECH_BACKENDS.map((backend) => byBackend.get(backend))),
    maxSegmentsPerJob: MAX_SPEECH_SEGMENTS,
    maxBatchTextBytes: MAX_SPEECH_BATCH_BYTES,
  });
};

const normalizeVoice = (voice) => {
  if (!hasExactKeys(voice, ['id', 'displayName', 'language', 'gender'])
      || !genderSet.has(voice.gender)
      || typeof voice.displayName !== 'string'
      || voice.displayName.trim().length === 0
      || voice.displayName.length > 256
      || hasInvalidControls(voice.displayName)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: requireResponseIdentifier(voice.id),
    displayName: voice.displayName,
    language: requireResponseLanguage(voice.language),
    gender: voice.gender,
  });
};

const normalizeVoiceList = (voices, expectedBackend) => {
  if (!Array.isArray(voices) || voices.length > MAX_VOICES) throw invalidResponse();
  const ids = new Set();
  const normalized = voices.map((rawVoice) => {
    const voice = normalizeVoice(rawVoice);
    if (ids.has(voice.id)) throw invalidResponse();
    ids.add(voice.id);
    return voice;
  });
  if (expectedBackend === 'geminiTts'
      && (normalized.length !== GEMINI_SPEECH_VOICES.length
        || normalized.some((voice) => !geminiVoiceSet.has(voice.id)))) {
    throw invalidResponse();
  }
  return Object.freeze(normalized);
};

export const normalizeSpeechProbe = (probe, expectedBackend) => {
  if (!hasExactKeys(probe, ['status', 'voices'])
      || !backendSet.has(expectedBackend)
      || !Array.isArray(probe.voices)) {
    throw invalidResponse();
  }
  const status = normalizeBackendStatus(probe.status);
  if (status.backend !== expectedBackend || !status.enabled || !status.ready || !status.warm) {
    throw invalidResponse();
  }
  const voices = normalizeVoiceList(probe.voices, expectedBackend);
  if (!status.supportsVoiceInventory && voices.length !== 0) throw invalidResponse();
  return Object.freeze({ status, voices });
};

export const normalizeSpeechInventory = (inventory, expectedBackend) => {
  if (!hasExactKeys(inventory, ['backend', 'epoch', 'enabled', 'warm', 'voices'])
      || !voiceInventoryBackendSet.has(expectedBackend)
      || inventory.backend !== expectedBackend
      || inventory.enabled !== true
      || inventory.warm !== true) {
    throw invalidResponse();
  }
  return Object.freeze({
    backend: expectedBackend,
    epoch: requireResponseInteger(inventory.epoch, 0, Number.MAX_SAFE_INTEGER),
    enabled: true,
    warm: true,
    voices: normalizeVoiceList(inventory.voices, expectedBackend),
  });
};

export const normalizeSpeechArtifact = (artifact) => {
  if (!hasExactKeys(artifact, [
    'artifactId', 'format', 'bytes', 'durationMicros', 'sampleRateHz', 'channels',
  ]) || !uuidHasVersion(artifact.artifactId, 7)
      || !formatSet.has(artifact.format)) {
    throw invalidResponse();
  }
  const bytes = requireResponseInteger(artifact.bytes, 1, MAX_ARTIFACT_BYTES);
  const durationMicros = artifact.durationMicros === null
    ? null
    : requireResponseInteger(artifact.durationMicros, 1, MAX_TIME_MICROS);
  const sampleRateHz = artifact.sampleRateHz === null
    ? null
    : requireResponseInteger(artifact.sampleRateHz, 8_000, 384_000);
  const channels = artifact.channels === null
    ? null
    : requireResponseInteger(artifact.channels, 1, 8);
  return Object.freeze({
    artifactId: artifact.artifactId,
    format: artifact.format,
    bytes,
    durationMicros,
    sampleRateHz,
    channels,
  });
};

const normalizePlayback = (playback, artifact) => {
  if (!hasExactKeys(playback, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !uuidHasVersion(playback.id, 4)
      || typeof playback.playbackUrl !== 'string'
      || typeof playback.mimeType !== 'string'
      || !/^audio\/[A-Za-z0-9!#$&^_.+-]{1,127}$/.test(playback.mimeType)
      || playback.byteLength !== artifact.bytes) {
    throw invalidResponse();
  }
  let parsed;
  try {
    parsed = new URL(playback.playbackUrl);
  } catch {
    throw invalidResponse();
  }
  const token = parsed.searchParams.getAll('token');
  if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || !/^\d{1,5}$/.test(parsed.port)
      || Number(parsed.port) < 1
      || Number(parsed.port) > 65_535
      || parsed.pathname !== `/asset/${playback.id}`
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || [...parsed.searchParams.keys()].some((key) => key !== 'token')
      || token.length !== 1
      || !/^[a-f0-9]{64}$/.test(token[0])) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: playback.id,
    playbackUrl: playback.playbackUrl,
    mimeType: playback.mimeType,
    byteLength: playback.byteLength,
  });
};

export const normalizePlayableArtifact = (value, maximumBytes = MAX_ARTIFACT_BYTES) => {
  if (!hasExactKeys(value, ['artifact', 'playback'])) throw invalidResponse();
  const artifact = normalizeSpeechArtifact(value.artifact);
  if (artifact.bytes > maximumBytes) throw invalidResponse();
  return Object.freeze({ artifact, playback: normalizePlayback(value.playback, artifact) });
};

const normalizeReferenceDelivery = (value) => {
  if (value === null) return null;
  if (!hasExactKeys(value, ['jobId', 'deliveryId'])
      || !uuidHasVersion(value.jobId, 7)
      || !uuidHasVersion(value.deliveryId, 7)) {
    throw invalidResponse();
  }
  return Object.freeze({ jobId: value.jobId, deliveryId: value.deliveryId });
};

export const normalizeProjectSpeechReference = (value) => {
  if (!hasExactKeys(value, [
    'schemaVersion', 'projectId', 'projectStateVersion', 'referenceVersion', 'artifactId',
    'transcript', 'language', 'pendingDelivery',
  ])
      || value.schemaVersion !== 1
      || !uuidHasVersion(value.projectId, 7)
      || !uuidHasVersion(value.artifactId, 7)
      || typeof value.transcript !== 'string'
      || utf8ByteLength(value.transcript) > 64 * 1024
      || typeof value.language !== 'string'
      || utf8ByteLength(value.language) < 1
      || utf8ByteLength(value.language) > 128
      || hasReferenceTextControls(value.transcript)
      || hasInvalidControls(value.language)) {
    throw invalidResponse();
  }
  return Object.freeze({
    schemaVersion: 1,
    projectId: value.projectId,
    projectStateVersion: requireResponseInteger(
      value.projectStateVersion, 0, Number.MAX_SAFE_INTEGER
    ),
    referenceVersion: requireResponseInteger(
      value.referenceVersion, 1, Number.MAX_SAFE_INTEGER
    ),
    artifactId: value.artifactId,
    transcript: value.transcript,
    language: value.language,
    pendingDelivery: normalizeReferenceDelivery(value.pendingDelivery),
  });
};

export const normalizeProjectSpeechReferencePlayable = (value) => {
  if (!hasExactKeys(value, ['reference', 'playable'])) throw invalidResponse();
  const reference = normalizeProjectSpeechReference(value.reference);
  const playable = normalizePlayableArtifact(value.playable, MAX_REFERENCE_BYTES);
  if (reference.artifactId !== playable.artifact.artifactId) throw invalidResponse();
  return Object.freeze({ reference, playable });
};

const normalizeStoredResult = (result) => {
  if (!isPlainDataRecord(result) || !resultStatusSet.has(result.status)) throw invalidResponse();
  if (result.status === 'completed') {
    if (!hasExactKeys(result, ['status', 'segmentId', 'artifact'])) throw invalidResponse();
    return Object.freeze({
      status: 'completed',
      segmentId: requireResponseIdentifier(result.segmentId, 96),
      artifact: normalizeSpeechArtifact(result.artifact),
    });
  }
  if (!hasExactKeys(result, ['status', 'segmentId', 'code', 'retryable'])
      || !failureCodeSet.has(result.code)
      || typeof result.retryable !== 'boolean') {
    throw invalidResponse();
  }
  return Object.freeze({
    status: 'failed',
    segmentId: requireResponseIdentifier(result.segmentId, 96),
    code: result.code,
    retryable: result.retryable,
  });
};

const normalizeResultList = (results) => {
  if (!Array.isArray(results) || results.length > MAX_SPEECH_SEGMENTS) throw invalidResponse();
  const seen = new Set();
  return Object.freeze(results.map((rawResult) => {
    const result = normalizeStoredResult(rawResult);
    if (seen.has(result.segmentId)) throw invalidResponse();
    seen.add(result.segmentId);
    return result;
  }));
};

export const normalizeSpeechJobResults = (value) => {
  if (!hasExactKeys(value, [
    'job', 'backend', 'projectId', 'expectedProjectStateVersion', 'results',
  ]) || !backendSet.has(value.backend)
      || ((value.projectId === null) !== (value.expectedProjectStateVersion === null))
      || (value.projectId !== null && !uuidHasVersion(value.projectId, 7))) {
    throw invalidResponse();
  }
  return Object.freeze({
    job: normalizeJobSnapshot(value.job),
    backend: value.backend,
    projectId: value.projectId,
    expectedProjectStateVersion: value.expectedProjectStateVersion === null
      ? null
      : requireResponseInteger(
        value.expectedProjectStateVersion,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    results: normalizeResultList(value.results),
  });
};

export const normalizeSpeechJobEvent = (rawEvent) => {
  if (!isPlainDataRecord(rawEvent) || typeof rawEvent.event !== 'string') throw invalidResponse();
  switch (rawEvent.event) {
    case 'progress': {
      if (!hasExactKeys(rawEvent, [
        'event', 'jobId', 'segmentId', 'index', 'total', 'phase', 'fractionMillionths',
      ]) || !uuidHasVersion(rawEvent.jobId, 7)
          || !phaseSet.has(rawEvent.phase)
          || (rawEvent.segmentId !== null
            && (() => {
              try {
                requireResponseIdentifier(rawEvent.segmentId, 96);
                return false;
              } catch {
                return true;
              }
            })())) {
        throw invalidResponse();
      }
      const total = requireResponseInteger(rawEvent.total, 1, MAX_SPEECH_SEGMENTS);
      const index = requireResponseInteger(rawEvent.index, 1, total);
      return Object.freeze({
        event: 'progress',
        jobId: rawEvent.jobId,
        segmentId: rawEvent.segmentId,
        index,
        total,
        phase: rawEvent.phase,
        fractionMillionths: requireResponseInteger(
          rawEvent.fractionMillionths,
          0,
          1_000_000
        ),
      });
    }
    case 'segmentCompleted':
    case 'segmentFailed': {
      if (!hasExactKeys(rawEvent, ['event', 'jobId', 'index', 'total', 'result'])
          || !uuidHasVersion(rawEvent.jobId, 7)) {
        throw invalidResponse();
      }
      const total = requireResponseInteger(rawEvent.total, 1, MAX_SPEECH_SEGMENTS);
      const index = requireResponseInteger(rawEvent.index, 1, total);
      const result = normalizeStoredResult(rawEvent.result);
      if ((rawEvent.event === 'segmentCompleted') !== (result.status === 'completed')) {
        throw invalidResponse();
      }
      return Object.freeze({ event: rawEvent.event, jobId: rawEvent.jobId, index, total, result });
    }
    case 'completed':
    case 'cancelled': {
      if (!hasExactKeys(rawEvent, ['event', 'job', 'results'])) throw invalidResponse();
      const job = normalizeJobSnapshot(rawEvent.job);
      if ((rawEvent.event === 'completed' && job.state !== 'succeeded')
          || (rawEvent.event === 'cancelled' && job.state !== 'cancelled')) {
        throw invalidResponse();
      }
      return Object.freeze({ event: rawEvent.event, job, results: normalizeResultList(rawEvent.results) });
    }
    case 'failed': {
      if (!hasExactKeys(rawEvent, ['event', 'job', 'results', 'code'])
          || !failureCodeSet.has(rawEvent.code)
          || (rawEvent.job !== null && !isPlainDataRecord(rawEvent.job))) {
        throw invalidResponse();
      }
      const job = rawEvent.job === null ? null : normalizeJobSnapshot(rawEvent.job);
      if (job !== null && job.state !== 'failed' && job.state !== 'cancelling') {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'failed',
        job,
        results: normalizeResultList(rawEvent.results),
        code: rawEvent.code,
      });
    }
    default:
      throw invalidResponse();
  }
};

export const normalizeProjectNarrationResponse = (value) => {
  if (!hasExactKeys(value, [
    'schemaVersion', 'projectId', 'projectStateVersion', 'source', 'results',
  ])
      || value.schemaVersion !== 1
      || !projectNarrationSources.has(value.source)
      || !Array.isArray(value.results)
      || value.results.length > MAX_SPEECH_SEGMENTS
      || !uuidHasVersion(value.projectId, 7)) {
    throw invalidResponse();
  }
  const { projectId } = value;
  const projectStateVersion = requireResponseInteger(
    value.projectStateVersion, 0, Number.MAX_SAFE_INTEGER
  );
  const cueIds = new Set();
  const artifactIds = new Set();
  const results = value.results.map((result) => {
    if (!hasExactKeys(result, [
      'subtitleId', 'text', 'artifact', 'method', 'outputIndex', 'originalIds',
      'startMicros', 'endMicros',
    ])
        || typeof result.text !== 'string'
        || result.text.length === 0
        || utf8ByteLength(result.text) > MAX_SEGMENT_TEXT_BYTES
        || !projectNarrationMethods.has(result.method)
        || !Array.isArray(result.originalIds)
        || result.originalIds.length === 0
        || result.originalIds.length > MAX_SPEECH_SEGMENTS) {
      throw invalidResponse();
    }
    const subtitleId = normalizeNarrationCueId(result.subtitleId, true);
    const artifact = normalizeSpeechArtifact(result.artifact);
    const startMicros = requireResponseInteger(
      result.startMicros, 0, MAX_PROJECT_NARRATION_MICROS
    );
    const endMicros = requireResponseInteger(
      result.endMicros, 1, MAX_PROJECT_NARRATION_MICROS
    );
    if (endMicros <= startMicros) throw invalidResponse();
    const cueKey = narrationCueKey(subtitleId);
    if (cueIds.has(cueKey) || artifactIds.has(artifact.artifactId)) throw invalidResponse();
    cueIds.add(cueKey);
    artifactIds.add(artifact.artifactId);
    return Object.freeze({
      subtitleId,
      text: result.text,
      artifact,
      method: result.method,
      outputIndex: result.outputIndex === null
        ? null : requireResponseInteger(result.outputIndex, 0, MAX_SPEECH_SEGMENTS - 1),
      originalIds: Object.freeze(
        result.originalIds.map((id) => normalizeNarrationCueId(id, true))
      ),
      startMicros,
      endMicros,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    projectId,
    projectStateVersion,
    source: value.source,
    results: Object.freeze(results),
  });
};
