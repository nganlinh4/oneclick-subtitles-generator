/**
 * The measurement surface: the only thing in the atlas pipeline that touches a font stack.
 *
 * Everything the baker and the shaper know about a face comes through this narrow contract —
 * `measure()`, `createTarget()` and the optional `isFaceLoaded()` — so the whole pipeline can be
 * driven by an injected model in a test and by a real canvas in the `WebView` without a second code
 * path. Nothing here interprets a measurement; it only refuses one that is not complete enough to
 * interpret.
 *
 * Determinism: no clocks, no RNG. The deterministic knobs a canvas exposes are pinned explicitly on
 * every call rather than assumed, because a shared context is ambient state.
 */

import { fail, invalidRequest, isFiniteNumber } from './glyphAtlasCore';

/** Every measurement the baker consumes must carry all of these, or the surface is not usable. */
const MEASUREMENT_FIELDS = Object.freeze([
  'width', 'actualBoundingBoxLeft', 'actualBoundingBoxRight',
  'actualBoundingBoxAscent', 'actualBoundingBoxDescent',
  'fontBoundingBoxAscent', 'fontBoundingBoxDescent',
]);

export const readMeasurement = (raw, what) => {
  if (raw === null || typeof raw !== 'object') {
    fail('glyphAtlasMetricsUnavailable', `The measurement surface returned no metrics for ${what}`);
  }
  const metrics = {};
  for (const field of MEASUREMENT_FIELDS) {
    const value = raw[field];
    if (!isFiniteNumber(value)) {
      fail('glyphAtlasMetricsUnavailable', `The measurement surface omitted ${field} for ${what}`);
    }
    metrics[field] = value;
  }
  return metrics;
};

/**
 * Canvas-backed surface used in the real WebView. Deterministic knobs are pinned explicitly:
 * kerning on, no letter or word spacing, and an LTR measurement direction — visual order is carried
 * in the descriptor as data, so the raster itself must not depend on the ambient direction.
 *
 * Spacing and direction are pinned by DEFAULT, and a caller may ask for different ones.
 *
 * The default is right for a per-cluster cell: spacing is a layout quantity there, not a glyph one,
 * and baking it into the raster would put it in atlas bytes no consumer could take back out.
 *
 * It is wrong for a whole shaped line. When the raster IS the line, the spacing, the word spacing
 * used to justify it and the paragraph direction that orders it are all part of what the line looks
 * like, and measuring or drawing without them describes a different line than the one on screen.
 * The cost is atlas identity — two spacings become two rasters — which is the honest price of the
 * mask and its advance coming from one operation instead of two that must agree.
 */
export const createCanvas2dMeasurementSurface = () => {
  const context = (() => {
    try {
      if (typeof document === 'undefined') return null;
      return document.createElement('canvas').getContext('2d', { willReadFrequently: true }) ?? null;
    } catch {
      return null;
    }
  })();
  if (context === null) {
    fail('glyphAtlasSurfaceUnavailable', 'A 2D canvas context is required to bake a glyph atlas');
  }

  /**
   * Put the context in a known state before every call.
   *
   * Explicit rather than assumed: a shared context carries whatever the last caller left, and a
   * measurement taken under someone else's letter spacing is a measurement of a different text.
   */
  const pin = (target, { letterSpacingPx = 0, wordSpacingPx = 0, direction = 'ltr' } = {}) => (
    Object.assign(target, {
      direction,
      fontKerning: 'normal',
      letterSpacing: `${letterSpacingPx}px`,
      wordSpacing: `${wordSpacingPx}px`,
      textAlign: 'left',
      textBaseline: 'alphabetic',
    })
  );

  return {
    measure(cssFont, text, options) {
      pin(context, options);
      context.font = cssFont;
      return context.measureText(text);
    },
    isFaceLoaded(cssFont, text) {
      try {
        return document.fonts?.check?.(cssFont, text) ?? null;
      } catch {
        return null;
      }
    },
    createTarget(widthPx, heightPx) {
      const canvas = document.createElement('canvas');
      canvas.width = widthPx;
      canvas.height = heightPx;
      const target = canvas.getContext('2d', { willReadFrequently: true });
      if (target === null) {
        fail('glyphAtlasSurfaceUnavailable', 'A 2D canvas context is required to rasterize a glyph atlas');
      }
      pin(target);
      // White coverage on transparent black: the alpha channel is the coverage mask the compositor
      // multiplies by the scene colour, so colour never bakes into the atlas.
      target.fillStyle = '#ffffff';
      return {
        drawGlyph({ cssFont, text, penXPx, baselineYPx, ...options }) {
          pin(target, options);
          target.font = cssFont;
          target.fillText(text, penXPx, baselineYPx);
        },
        readPixels: () => target.getImageData(0, 0, widthPx, heightPx).data,
      };
    },
  };
};

export const resolveSurface = (surface) => {
  if (surface === undefined || surface === null) return createCanvas2dMeasurementSurface();
  if (typeof surface.measure !== 'function' || typeof surface.createTarget !== 'function') {
    invalidRequest('surface must expose measure() and createTarget()');
  }
  return surface;
};
