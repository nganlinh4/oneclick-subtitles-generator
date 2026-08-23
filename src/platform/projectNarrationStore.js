import { getProjectNarration, putProjectNarration } from './speechService';
import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
} from './nativeNarrationCapabilities';

const SOURCE_NAMES = Object.freeze(['original', 'translated', 'grouped']);
const SOURCES = new Set(SOURCE_NAMES);
const METHODS = new Set(['f5tts', 'chatterbox', 'edge-tts', 'gtts', 'gemini']);

const timingMicros = (value, field) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`Narration ${field} is invalid`);
  }
  const micros = Math.round(value * 1_000_000);
  if (!Number.isSafeInteger(micros)) throw new TypeError(`Narration ${field} is invalid`);
  return micros;
};

const requestResult = (result, fallbackMethod) => {
  const artifactId = getNativeNarrationArtifactId(result);
  const subtitleId = result?.subtitle_id;
  const method = result?.method || fallbackMethod;
  const startMicros = timingMicros(result?.start, 'start');
  const endMicros = timingMicros(result?.end, 'end');
  if (!artifactId
      || result?.success !== true
      || !METHODS.has(method)
      || (typeof subtitleId !== 'string' && !Number.isSafeInteger(subtitleId))
      || typeof result.text !== 'string'
      || result.text.length === 0
      || endMicros <= startMicros) {
    throw new TypeError('Narration result is not durably restorable');
  }
  const originalIds = Array.isArray(result.original_ids) && result.original_ids.length > 0
    ? result.original_ids
    : [subtitleId];
  return Object.freeze({
    subtitleId,
    text: result.text,
    artifactId,
    method,
    outputIndex: Number.isSafeInteger(result.outputIndex) ? result.outputIndex : null,
    originalIds: Object.freeze([...originalIds]),
    startMicros,
    endMicros,
  });
};

const restoredResult = (result, project) => Object.freeze({
  subtitle_id: result.subtitleId,
  text: result.text,
  success: true,
  pending: false,
  nativeArtifactId: result.artifact.artifactId,
  nativeFormat: result.artifact.format,
  durationMicros: result.artifact.durationMicros,
  filename: createNativeNarrationToken(result.artifact.artifactId),
  audioData: null,
  method: result.method,
  outputIndex: result.outputIndex ?? undefined,
  original_ids: [...result.originalIds],
  start: result.startMicros / 1_000_000,
  end: result.endMicros / 1_000_000,
  projectId: project.projectId,
  projectStateVersion: project.projectStateVersion,
});

export const saveProjectNarration = async ({
  projectId,
  expectedProjectStateVersion,
  source,
  results,
  method,
}) => {
  if (!SOURCES.has(source) || !Array.isArray(results)) {
    throw new TypeError('A project narration source and result list are required');
  }
  const successful = results.filter((result) => result?.success === true);
  const stored = await putProjectNarration({
    projectId,
    expectedProjectStateVersion,
    source,
    results: successful.map((result) => requestResult(result, method)),
  });
  return Object.freeze({
    projectId: stored.projectId,
    projectStateVersion: stored.projectStateVersion,
    source: stored.source,
    results: Object.freeze(stored.results.map((result) => restoredResult(result, stored))),
  });
};

export const loadProjectNarration = async (projectId, source) => {
  if (!SOURCES.has(source)) throw new TypeError('A project narration source is required');
  const stored = await getProjectNarration(projectId, source);
  if (stored === null) return null;
  return Object.freeze({
    projectId: stored.projectId,
    projectStateVersion: stored.projectStateVersion,
    source: stored.source,
    results: Object.freeze(stored.results.map((result) => restoredResult(result, stored))),
  });
};

export const loadProjectNarrations = async (projectId) => {
  const records = await Promise.all(SOURCE_NAMES.map((source) => (
    loadProjectNarration(projectId, source)
  )));
  const present = records.filter(Boolean);
  if (present.length === 0) return null;
  const projectStateVersion = present[0].projectStateVersion;
  if (present.some((record) => (
    record.projectId !== projectId || record.projectStateVersion !== projectStateVersion
  ))) {
    throw new TypeError('Project narration sources disagree on authority');
  }
  return Object.freeze({
    projectId,
    projectStateVersion,
    resultsBySource: Object.freeze(Object.fromEntries(SOURCE_NAMES.map((source, index) => (
      [source, records[index]?.results || Object.freeze([])]
    )))),
  });
};
