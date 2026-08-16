/**
 * What a bake request has to be before anything is measured, and the CSS font shorthand it becomes.
 *
 * Split from the baker for two reasons. The single-run entry point and the cue-set one share every
 * field except the text, so the shared half is normalized once and the per-text half — the transform
 * and the length bound, which depend on each other — is normalized per run. And `glyphAtlas.js` has
 * to stay the single home of `GLYPH_ATLAS_LIMITS` while staying under the file ceiling, so the
 * bounds arrive here as an argument rather than as an import, exactly as they already do in
 * `glyphAtlasCells.js` and `glyphAtlasShaping.js`.
 *
 * The family is REJECTED, never escaped. It is interpolated into a CSS font shorthand, so anything
 * that could terminate the string or the declaration fails the request outright.
 *
 * Determinism: no clocks, no RNG. Every function here is a pure function of its arguments.
 */

import { fail, invalidRequest, isFiniteNumber, round4 } from './glyphAtlasCore';
import { TEXT_ALIGNMENTS, TEXT_TRANSFORMS, applyTextTransform } from './glyphAtlasShaping';

const FAMILY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;

const quoteFamily = (family) => `"${family}"`;

export const buildCssFont = (face, families) => {
  const list = families.map(quoteFamily).join(', ');
  return `${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${list}`;
};

/** Generic families are keywords and must never be quoted. */
export const buildProbeFont = (face, families, probeFamily) => {
  const quoted = families.map(quoteFamily);
  return `${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${[...quoted, probeFamily].join(', ')}`;
};

const normalizeFace = (face, limits) => {
  if (face === null || typeof face !== 'object') invalidRequest('face must be an object');
  const { family, weight = 400, style = 'normal' } = face;
  if (typeof family !== 'string' || family.length === 0) invalidRequest('face.family must be a non-empty string');
  if (family.length > limits.maxFamilyCharacters) {
    invalidRequest(`face.family exceeds ${limits.maxFamilyCharacters} characters`);
  }
  if (!FAMILY_PATTERN.test(family)) invalidRequest('face.family contains characters that are not allowed');
  if (!Number.isInteger(weight) || weight < 1 || weight > 1_000) invalidRequest('face.weight must be an integer in 1..1000');
  if (style !== 'normal' && style !== 'italic' && style !== 'oblique') {
    invalidRequest("face.style must be 'normal', 'italic' or 'oblique'");
  }
  return { family, weight, style };
};

const normalizeShaping = ({ textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign }, limits) => {
  if (!TEXT_TRANSFORMS.includes(textTransform)) {
    invalidRequest(`textTransform must be one of ${TEXT_TRANSFORMS.join(', ')}`);
  }
  if (!TEXT_ALIGNMENTS.includes(textAlign)) {
    invalidRequest(`textAlign must be one of ${TEXT_ALIGNMENTS.join(', ')}`);
  }
  if (typeof wordWrap !== 'boolean') invalidRequest('wordWrap must be a boolean');
  if (!isFiniteNumber(letterSpacingPx)
      || letterSpacingPx < limits.minLetterSpacingPx
      || letterSpacingPx > limits.maxLetterSpacingPx) {
    invalidRequest(
      `letterSpacingPx must be within ${limits.minLetterSpacingPx}..${limits.maxLetterSpacingPx}`
    );
  }
  if (maxWidthPx !== null
      && (!isFiniteNumber(maxWidthPx) || maxWidthPx <= 0 || maxWidthPx > limits.maxLayoutWidthPx)) {
    invalidRequest(`maxWidthPx must be null or within 0..${limits.maxLayoutWidthPx}`);
  }
  return { textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign };
};

/**
 * Everything one bake shares across every run it lays out: the face, the raster geometry and the
 * shaping options. The text is deliberately not part of it.
 */
export const normalizeSharedRequest = (request, limits) => {
  if (request === null || typeof request !== 'object') invalidRequest('request must be an object');
  const {
    face, fontSizePx, lineHeightPx = null, paddingPx = 1, requireExactFace = true,
    textTransform = 'none', letterSpacingPx = 0, maxWidthPx = null, wordWrap = true,
    textAlign = 'left', baseDirection = null,
  } = request;

  if (typeof requireExactFace !== 'boolean') invalidRequest('requireExactFace must be a boolean');
  if (!isFiniteNumber(fontSizePx)) invalidRequest('fontSizePx must be a finite number');
  if (fontSizePx < limits.minFontSizePx || fontSizePx > limits.maxFontSizePx) {
    invalidRequest(`fontSizePx must be within ${limits.minFontSizePx}..${limits.maxFontSizePx}`);
  }
  if (lineHeightPx !== null && (!isFiniteNumber(lineHeightPx) || lineHeightPx <= 0)) {
    invalidRequest('lineHeightPx must be null or a positive finite number');
  }
  if (!Number.isInteger(paddingPx) || paddingPx < 0 || paddingPx > limits.maxPaddingPx) {
    invalidRequest(`paddingPx must be an integer in 0..${limits.maxPaddingPx}`);
  }
  // null means resolve the paragraph level from the text itself (UAX #9 P2/P3). A caller that knows
  // better — the editor's persisted rtlSupport is exactly that — forces it instead.
  if (baseDirection !== null && baseDirection !== 'ltr' && baseDirection !== 'rtl') {
    invalidRequest("baseDirection must be null, 'ltr' or 'rtl'");
  }
  const shaping = normalizeShaping(
    { textTransform, letterSpacingPx, maxWidthPx, wordWrap, textAlign },
    limits
  );
  return {
    face: { ...normalizeFace(face, limits), fontSizePx },
    lineHeightPx,
    paddingPx,
    requireExactFace,
    ...shaping,
    baseDirection,
  };
};

/**
 * One run's text, transformed and bounded.
 *
 * The transform runs before the length bound because it is what decides the length: uppercasing can
 * lengthen a string, and the bound belongs to the text that is actually baked.
 */
export const normalizeText = (text, textTransform, limits) => {
  if (typeof text !== 'string') invalidRequest('text must be a string');
  const shaped = applyTextTransform(text, textTransform);
  if ([...shaped].length > limits.maxTextCodePoints) {
    fail('glyphAtlasTextTooLong', `The text exceeds ${limits.maxTextCodePoints} code points and is rejected rather than truncated`);
  }
  return shaped;
};
