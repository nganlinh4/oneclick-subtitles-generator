/**
 * Proving which face a measurement actually used.
 *
 * The browser never reports which face it drew with, and it silently substitutes both whole
 * families (the family is not installed) and individual glyphs (the family is installed but lacks
 * the code point). Trusting it is exactly how 88 of OSG's 115 selectable families ended up silently
 * substituted in the preview. So the face is measured, not trusted:
 *
 *   1. Measure a probe string in each of three generic families alone. If all three widths agree,
 *      the surface cannot tell faces apart at all (a stub `measureText`, a headless context with no
 *      fonts) and nothing it says is evidence — reject as unverifiable rather than guess.
 *   2. Measure the same probe as `"Requested", <generic>` for each generic. If the requested family
 *      participated, at least one chain differs from its generic alone.
 *   3. If every chain matches its generic exactly, the requested family contributed nothing: it is
 *      absent. Three independent generics agreeing by coincidence with a real face is not credible.
 *   4. Repeat per cell to catch per-glyph fallback (emoji, CJK, rare diacritics) in an otherwise
 *      present family. Cells with no ink are skipped by the caller: whitespace and format characters
 *      have nothing to substitute.
 *   5. `document.fonts.check` corroborates when the surface offers it. It is only allowed to
 *      *reject*: a `false` fails closed, a `true` never overrides a measured absence.
 *
 * Determinism: no clocks, no RNG. Every probe is a pure function of the text, the face and the
 * surface.
 */

import { fail, round4 } from './glyphAtlasCore';
import { buildProbeFont } from './glyphAtlasRequest';
import { readMeasurement } from './glyphAtlasSurface';

/**
 * Probe families used to detect face substitution. They must be generic families that every engine
 * resolves to visibly different metrics; agreement between all three is what proves a face did not
 * participate in a measurement.
 */
export const PROBE_FAMILIES = Object.freeze(['monospace', 'serif', 'sans-serif']);
export const FACE_PROBE_TEXT = 'mmmmmmmmmmlliWQ';
/** Face-level vertical metrics are string-independent, so a fixed probe also covers empty text. */
export const METRIC_PROBE_TEXT = 'Hxdpg';

const genericFont = (face, probeFamily) => `${face.style} ${face.weight} ${round4(face.fontSizePx)}px ${probeFamily}`;

/**
 * The three probe pairs, or a typed failure when the surface cannot tell two faces apart at all.
 */
export const probeFace = (surface, face, families) => {
  const alone = PROBE_FAMILIES.map((probeFamily) => ({
    probeFamily,
    width: readMeasurement(
      surface.measure(genericFont(face, probeFamily), FACE_PROBE_TEXT),
      `probe family ${probeFamily}`
    ).width,
  }));
  const discriminating = new Set(alone.map(({ width }) => round4(width))).size > 1;
  if (!discriminating) {
    fail(
      'glyphAtlasFaceUnverifiable',
      'The measurement surface reports identical metrics for every generic family, so face identity cannot be verified'
    );
  }
  return alone.map(({ probeFamily, width }) => ({
    probeFamily,
    aloneWidthPx: round4(width),
    chainedWidthPx: round4(
      readMeasurement(
        surface.measure(buildProbeFont(face, families, probeFamily), FACE_PROBE_TEXT),
        `probe chain ${probeFamily}`
      ).width
    ),
  }));
};

/** Whether the engine fell back to another face for one cell's text. */
export const probeCluster = (surface, face, families, cellText) => PROBE_FAMILIES.every((probeFamily) => {
  const aloneWidth = readMeasurement(
    surface.measure(genericFont(face, probeFamily), cellText),
    `cluster probe ${probeFamily}`
  ).width;
  const chainedWidth = readMeasurement(
    surface.measure(buildProbeFont(face, families, probeFamily), cellText),
    `cluster chain ${probeFamily}`
  ).width;
  return round4(aloneWidth) === round4(chainedWidth);
});
