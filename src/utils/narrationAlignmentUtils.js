/**
 * Shared helpers for aligned narration payload preparation.
 */
import {
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
  hydrateNativeNarrationResult,
} from '../platform/nativeNarrationCapabilities';

/**
 * Resolve the per-run subtitle directory index used by saved narration files.
 * F5-TTS saves files under subtitle_1, subtitle_2, ... based on generation order,
 * not necessarily the subtitle_id value.
 *
 * @param {Object} result
 * @param {number} fallbackIndex
 * @returns {number|null}
 */
export const getNarrationOutputIndex = (result, fallbackIndex = 0) => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  const candidate = result.outputIndex ?? result.output_index ?? (fallbackIndex + 1);
  const numericCandidate = Number(candidate);

  if (!Number.isInteger(numericCandidate) || numericCandidate <= 0) {
    return null;
  }

  return numericCandidate;
};

/**
 * Infer the saved filename for narration results that were restored without one.
 *
 * @param {Object} result
 * @param {number} fallbackIndex
 * @returns {string|null}
 */
export const resolveNarrationFilename = (result, fallbackIndex = 0) => {
  if (!result || typeof result !== 'object') {
    return null;
  }

  if (typeof result.filename === 'string' && result.filename.trim()) {
    return result.filename;
  }

  const nativeArtifactId = getNativeNarrationArtifactId(result);
  if (nativeArtifactId) return createNativeNarrationToken(nativeArtifactId);

  if (result.pending || result.skipped || result.success === false) {
    return null;
  }

  const outputIndex = getNarrationOutputIndex(result, fallbackIndex);
  if (!outputIndex) {
    return null;
  }

  return `subtitle_${outputIndex}/1.wav`;
};

/**
 * Fill alignment-critical narration metadata without changing item order.
 *
 * @param {Array} narrationResults
 * @returns {Array}
 */
export const hydrateNarrationResultsForAlignment = (narrationResults = []) => {
  if (!Array.isArray(narrationResults) || narrationResults.length === 0) {
    return [];
  }

  return narrationResults.map((rawResult, index) => {
    const result = hydrateNativeNarrationResult(rawResult);
    if (!result || typeof result !== 'object') {
      return result;
    }

    const outputIndex = getNarrationOutputIndex(result, index);
    const filename = resolveNarrationFilename(result, index);

    if (
      result.outputIndex === outputIndex &&
      (!filename || result.filename === filename)
    ) {
      return result;
    }

    return {
      ...result,
      ...(outputIndex ? { outputIndex } : {}),
      ...(filename && !result.filename ? { filename } : {})
    };
  });
};
