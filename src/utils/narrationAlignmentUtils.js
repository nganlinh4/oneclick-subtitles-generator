/**
 * The only conversion from per-cue narration results to a native alignment plan.
 *
 * Narration bytes are capabilities, not filenames. Timings belong to the current cue plan, not to
 * a cached result or a browser global. Keeping those two rules here prevents preview, download and
 * render from each inventing a slightly different recovery path.
 */
import {
  getNativeNarrationArtifactId,
  hydrateNativeNarrationResult,
} from '../platform/nativeNarrationCapabilities';

const MAX_ALIGNMENT_ITEMS = 1_000;

export class NarrationAlignmentInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NarrationAlignmentInputError';
    this.code = code;
  }
}

const invalid = (code, message) => new NarrationAlignmentInputError(code, message);

const exactId = (value, label) => {
  if ((typeof value !== 'string' && typeof value !== 'number')
      || (typeof value === 'number' && !Number.isSafeInteger(value))) {
    throw invalid('narrationCueIdInvalid', `${label} has no exact subtitle identifier.`);
  }
  const id = String(value);
  const hasControl = [...id].some((character) => {
    const point = character.codePointAt(0);
    return point < 32 || point === 127;
  });
  if (id.length === 0 || id.length > 256 || hasControl) {
    throw invalid('narrationCueIdInvalid', `${label} has an invalid subtitle identifier.`);
  }
  return id;
};

const cueId = (cue, label) => exactId(cue?.id ?? cue?.subtitle_id, label);

const exactLineage = (value, fallbackId, label) => {
  const ids = value === undefined ? [fallbackId] : value;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ALIGNMENT_ITEMS) {
    throw invalid('narrationCueLineageInvalid', `${label} has incomplete grouped subtitle IDs.`);
  }
  const normalized = ids.map((id) => exactId(id, label));
  if (new Set(normalized).size !== normalized.length) {
    throw invalid('narrationCueLineageInvalid', `${label} repeats a grouped subtitle ID.`);
  }
  return Object.freeze(normalized);
};

const exactTiming = (cue, label) => {
  const start = cue?.start;
  const end = cue?.end;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0
      || typeof end !== 'number' || !Number.isFinite(end) || end <= start) {
    throw invalid('narrationCueTimingInvalid', `${label} has no exact current timing.`);
  }
  return Object.freeze({ start, end });
};

const sameIds = (left, right) => (
  left.length === right.length && left.every((id, index) => id === right[index])
);

/**
 * Build a complete, current native alignment plan.
 *
 * Failed and pending result rows are not alignment inputs. Every current cue must nevertheless own
 * exactly one successful native artifact, so a partial generation is refused rather than mixed as
 * if it were complete. Grouped cues must carry the exact same ordered lineage on both sides.
 */
export const buildStrictNativeNarrationPlan = (generationResults, currentCues) => {
  if (!Array.isArray(generationResults)
      || !Array.isArray(currentCues)
      || currentCues.length === 0
      || currentCues.length > MAX_ALIGNMENT_ITEMS) {
    throw invalid('narrationPlanUnavailable', 'Current subtitles and narration results are required.');
  }

  const cuesById = new Map();
  for (const [index, rawCue] of currentCues.entries()) {
    if (rawCue === null || typeof rawCue !== 'object' || Array.isArray(rawCue)) {
      throw invalid('narrationCueInvalid', `Subtitle ${index + 1} is invalid.`);
    }
    const id = cueId(rawCue, `Subtitle ${index + 1}`);
    if (cuesById.has(id)) {
      throw invalid('narrationCueDuplicate', `Subtitle identifier ${id} is duplicated.`);
    }
    const text = rawCue.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw invalid('narrationCueTextInvalid', `Subtitle ${id} has no exact text.`);
    }
    cuesById.set(id, Object.freeze({
      id,
      text,
      lineage: exactLineage(rawCue.original_ids, id, `Subtitle ${id}`),
      timing: exactTiming(rawCue, `Subtitle ${id}`),
    }));
  }

  const successful = generationResults.filter((result) => result?.success === true);
  if (successful.length !== cuesById.size) {
    throw invalid(
      'narrationPlanIncomplete',
      'Every current subtitle must have one successful native narration artifact.',
    );
  }

  const seenResults = new Set();
  const seenArtifacts = new Set();
  const items = successful.map((rawResult, index) => {
    if (rawResult === null || typeof rawResult !== 'object' || Array.isArray(rawResult)) {
      throw invalid('narrationResultInvalid', `Narration result ${index + 1} is invalid.`);
    }
    const result = hydrateNativeNarrationResult(rawResult);
    const id = exactId(result.subtitle_id, `Narration result ${index + 1}`);
    if (seenResults.has(id)) {
      throw invalid('narrationResultDuplicate', `Narration result ${id} is duplicated.`);
    }
    seenResults.add(id);

    const cue = cuesById.get(id);
    if (!cue) {
      throw invalid('narrationResultStale', `Narration result ${id} does not belong to the current subtitles.`);
    }
    if (result.text !== cue.text) {
      throw invalid('narrationResultStale', `Narration result ${id} was generated for different text.`);
    }
    const lineage = exactLineage(result.original_ids, id, `Narration result ${id}`);
    if (!sameIds(lineage, cue.lineage)) {
      throw invalid(
        'narrationCueLineageMismatch',
        `Narration result ${id} does not cover the current grouped subtitles.`,
      );
    }

    const nativeArtifactId = getNativeNarrationArtifactId(result);
    if (nativeArtifactId === null) {
      throw invalid(
        'narrationArtifactUnavailable',
        `Narration result ${id} has no native artifact capability.`,
      );
    }
    if (seenArtifacts.has(nativeArtifactId)) {
      throw invalid(
        'narrationArtifactDuplicate',
        'One native narration artifact cannot satisfy multiple subtitles.',
      );
    }
    seenArtifacts.add(nativeArtifactId);

    return Object.freeze({
      subtitle_id: id,
      nativeArtifactId,
      start: cue.timing.start,
      end: cue.timing.end,
      text: cue.text,
      original_ids: cue.lineage,
    });
  }).sort((left, right) => left.start - right.start || left.subtitle_id.localeCompare(right.subtitle_id));

  const itemIds = new Set(items.map((item) => item.subtitle_id));
  const missing = [...cuesById.keys()].filter((id) => !itemIds.has(id));
  if (missing.length > 0) {
    throw invalid('narrationPlanIncomplete', 'A current subtitle has no native narration artifact.');
  }

  const subtitleTimestamps = Object.freeze(Object.fromEntries(items.map((item) => [
    item.subtitle_id,
    Object.freeze({ start: item.start, end: item.end }),
  ])));
  return Object.freeze({ items: Object.freeze(items), subtitleTimestamps });
};

/** A collision-free bounded identity for the exact artifacts, text lineage and timings aligned. */
export const createNativeNarrationPlanKey = (plan) => JSON.stringify(plan.items.map((item) => ({
  subtitleId: item.subtitle_id,
  artifactId: item.nativeArtifactId,
  start: item.start,
  end: item.end,
  text: item.text,
  originalIds: item.original_ids,
})));

/**
 * Retained as the normalization surface used by generation UI state. It only hydrates an opaque
 * native artifact token; it never invents a filename, output index, success value, or timing.
 */
export const hydrateNarrationResultsForAlignment = (narrationResults = []) => (
  Array.isArray(narrationResults)
    ? narrationResults.map(hydrateNativeNarrationResult)
    : []
);
