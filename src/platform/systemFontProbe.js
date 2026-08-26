import { inspectExactFace } from './glyphAtlasFace';
import { createCanvas2dMeasurementSurface } from './glyphAtlasSurface';

/**
 * Prove that a declared system face participates in browser shaping.
 *
 * `FontFaceSet.check()` is only a veto: browsers may report that a request is satisfiable while
 * silently satisfying it with a fallback. The three metric pairs produced by `inspectExactFace`
 * are the positive authority shared by the font picker, live preview, and export staging.
 */
export const systemFontProbe = (
  fonts = typeof document === 'object' ? document.fonts : null,
  injectedSurface = null,
) => {
  const measurementSurface = (() => {
    if (injectedSurface !== null) return injectedSurface;
    try {
      return createCanvas2dMeasurementSurface();
    } catch {
      return null;
    }
  })();
  if (typeof measurementSurface?.measure !== 'function') return null;

  // Do not inherit the canvas surface's ambient FontFaceSet hook. The explicitly supplied set is
  // the capability this probe is claiming about, and metrics remain valid when no set exists.
  const surface = {
    measure: (...args) => measurementSurface.measure(...args),
    ...(typeof fonts?.check === 'function' ? {
      isFaceLoaded: (cssFont, text) => {
        try {
          return fonts.check(cssFont, text);
        } catch {
          return false;
        }
      },
    } : {}),
  };

  return ({ family, weight, style = 'normal' }) => {
    try {
      return inspectExactFace(
        surface,
        { family, weight, style, fontSizePx: 16 },
        [family],
      ).exact;
    } catch {
      // An incomplete or non-discriminating measurement surface proves nothing.
      return false;
    }
  };
};
