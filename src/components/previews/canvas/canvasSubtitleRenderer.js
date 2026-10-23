import { scaleStyleValue, lineLeft, resolveSubtitleGeometry } from './canvasSubtitleMath.js';
import { rgba, subtitleBackgroundRgba } from './canvasSubtitleColor.js';
import { drawVideoUnderlay, fitContain, videoIsDrawable } from './canvasVideoUnderlay.js';
import { findWordCellRange, revealCount, wordRevealCount } from './canvasGlyphReveal.js';

const STROKE_TAPS = 24;

const roundedRect = (context, rect, radiusValue) => {
  const radius = Math.max(0, Math.min(radiusValue, rect.width / 2, rect.height / 2));
  context.beginPath();
  context.moveTo(rect.left + radius, rect.top);
  context.lineTo(rect.left + rect.width - radius, rect.top);
  context.quadraticCurveTo(rect.left + rect.width, rect.top, rect.left + rect.width, rect.top + radius);
  context.lineTo(rect.left + rect.width, rect.top + rect.height - radius);
  context.quadraticCurveTo(
    rect.left + rect.width,
    rect.top + rect.height,
    rect.left + rect.width - radius,
    rect.top + rect.height,
  );
  context.lineTo(rect.left + radius, rect.top + rect.height);
  context.quadraticCurveTo(rect.left, rect.top + rect.height, rect.left, rect.top + rect.height - radius);
  context.lineTo(rect.left, rect.top + radius);
  context.quadraticCurveTo(rect.left, rect.top, rect.left + radius, rect.top);
  context.closePath();
};

/**
 * The strips a CSS border occupies, measured inward from the border box's outer edge.
 *
 * Rust's compositor defines `double` as two one-third-width rings with a one-third-width gap.
 * Keeping that split as data makes the canvas path use the same contract instead of accidentally
 * treating every style other than dashed/dotted as one solid ring.
 */
export const subtitleBorderBands = (width, style) => {
  if (!Number.isFinite(width) || width <= 0) return Object.freeze([]);
  if (style !== 'double') {
    return Object.freeze([Object.freeze({ inset: 0, width })]);
  }
  const third = width / 3;
  return Object.freeze([
    Object.freeze({ inset: 0, width: third }),
    Object.freeze({ inset: 2 * third, width: third }),
  ]);
};


const setCompositionTransform = (context, viewport, geometry, cueTransform) => {
  const centreX = geometry.border.left + geometry.border.width / 2;
  const centreY = geometry.border.top + geometry.border.height / 2;
  context.setTransform(viewport.scale, 0, 0, viewport.scale, viewport.left, viewport.top);
  context.translate(
    scaleStyleValue(cueTransform.x, viewport.height / viewport.scale),
    scaleStyleValue(cueTransform.y, viewport.height / viewport.scale),
  );
  context.translate(centreX, centreY);
  context.rotate((cueTransform.rotate * Math.PI) / 180);
  context.scale(cueTransform.scale * Math.cos((cueTransform.rotateY * Math.PI) / 180), cueTransform.scale);
  context.translate(-centreX, -centreY);
};


const drawGlyphMask = ({
  context,
  atlasCanvas,
  atlas,
  geometry,
  viewport,
  cueTransform,
  revealed,
  startCell = 0,
}) => {
  context.save();
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  setCompositionTransform(context, viewport, geometry, cueTransform);
  let placed = 0;
  for (const [lineIndex, line] of atlas.layout.lines.entries()) {
    const left = lineLeft(geometry, geometry.lineWidths[lineIndex]);
    const baseline = geometry.textTop + line.baselineYPx * geometry.glyphScale;
    for (const [position, index] of line.glyphs.entries()) {
      if (revealed !== null && placed >= revealed) {
        context.restore();
        return;
      }
      const shouldDraw = placed >= startCell;
      placed += 1;
      if (!shouldDraw) continue;

      const glyph = atlas.glyphs[index];
      if (!glyph || glyph.widthPx <= 0 || glyph.heightPx <= 0) continue;
      const pen = left + line.penXPx[position] * geometry.glyphScale;
      context.drawImage(
        atlasCanvas,
        glyph.xPx,
        glyph.yPx,
        glyph.widthPx,
        glyph.heightPx,
        pen - glyph.originXPx * geometry.glyphScale,
        baseline - glyph.originYPx * geometry.glyphScale,
        glyph.widthPx * geometry.glyphScale,
        glyph.heightPx * geometry.glyphScale,
      );
    }
  }
  context.restore();
};

const tintMask = (target, scratch, mask, paint, alpha) => {
  scratch.save();
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(0, 0, scratch.canvas.width, scratch.canvas.height);
  scratch.drawImage(mask, 0, 0);
  scratch.globalCompositeOperation = 'source-in';
  scratch.fillStyle = paint;
  scratch.globalAlpha = alpha;
  scratch.fillRect(0, 0, scratch.canvas.width, scratch.canvas.height);
  scratch.restore();
  target.drawImage(scratch.canvas, 0, 0);
};

const transformedPoint = (point, viewport, geometry, cueTransform) => {
  const centreX = geometry.border.left + geometry.border.width / 2;
  const centreY = geometry.border.top + geometry.border.height / 2;
  let x = (point.x - centreX) * cueTransform.scale * Math.cos((cueTransform.rotateY * Math.PI) / 180);
  let y = (point.y - centreY) * cueTransform.scale;
  const radians = (cueTransform.rotate * Math.PI) / 180;
  const rotatedX = x * Math.cos(radians) - y * Math.sin(radians);
  const rotatedY = x * Math.sin(radians) + y * Math.cos(radians);
  x = centreX + rotatedX + scaleStyleValue(cueTransform.x, viewport.height / viewport.scale);
  y = centreY + rotatedY + scaleStyleValue(cueTransform.y, viewport.height / viewport.scale);
  return { x: viewport.left + x * viewport.scale, y: viewport.top + y * viewport.scale };
};

export const subtitleGradientVector = (gradientDirection) => {
  const degrees = Number.parseInt(gradientDirection, 10) || 0;
  const radians = (degrees * Math.PI) / 180;
  return { x: Math.sin(radians), y: -Math.cos(radians) };
};

const gradientPaint = (context, customization, viewport, geometry, cueTransform) => {
  const direction = subtitleGradientVector(customization.gradientDirection);
  const length = Math.abs(geometry.padding.width * direction.x)
    + Math.abs(geometry.padding.height * direction.y);
  const centre = {
    x: geometry.padding.left + geometry.padding.width / 2,
    y: geometry.padding.top + geometry.padding.height / 2,
  };
  const start = transformedPoint({
    x: centre.x - direction.x * length / 2,
    y: centre.y - direction.y * length / 2,
  }, viewport, geometry, cueTransform);
  const end = transformedPoint({
    x: centre.x + direction.x * length / 2,
    y: centre.y + direction.y * length / 2,
  }, viewport, geometry, cueTransform);
  const gradient = context.createLinearGradient(start.x, start.y, end.x, end.y);
  gradient.addColorStop(0, rgba(customization.gradientColorStart));
  gradient.addColorStop(1, rgba(customization.gradientColorEnd));
  return gradient;
};

const paintSubtitle = ({
  context,
  maskContext,
  scratchContext,
  atlasCanvas,
  atlas,
  customization,
  composition,
  viewport,
  active,
  cueTransform,
}) => {
  const geometry = resolveSubtitleGeometry({ customization, composition, atlas });
  const eased = active === null ? 0 : active.eased;
  // The persisted vocabulary has no flat cue-opacity control. Export uses 1.0, then the fade.
  const alpha = eased;
  if (alpha <= 0) return;
  const instantMs = (active?.instant != null ? active.instant : (active?.cue?.start || 0)) * 1000;
  let revealed = null;
  if (customization.animationType === 'typewriter' && active.phase === 'fadingIn') {
    revealed = revealCount(atlas, active.progress);
  } else if (customization.animationType === 'word-reveal') {
    revealed = wordRevealCount(atlas, active.cue?.words, instantMs);
  }
  drawGlyphMask({
    context: maskContext,
    atlasCanvas,
    atlas,
    geometry,
    viewport,
    cueTransform,
    revealed,
  });

  context.save();
  setCompositionTransform(context, viewport, geometry, cueTransform);
  if (customization.glowEnabled && customization.glowIntensity > 0) {
    // Canvas shadows inherit the source shape's alpha. The old 0.001-alpha source therefore
    // quantized the whole glow away, so changing Glow Color committed durably while publishing
    // byte-identical preview pixels. Render the shadow on the scratch surface from an opaque box,
    // then cut that box back out before compositing. This mirrors osg-compositor's outer-shadow
    // mask and prevents the glow shining through a translucent subtitle background.
    scratchContext.save();
    scratchContext.setTransform(1, 0, 0, 1, 0, 0);
    scratchContext.clearRect(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
    setCompositionTransform(scratchContext, viewport, geometry, cueTransform);
    scratchContext.globalCompositeOperation = 'source-over';
    scratchContext.globalAlpha = alpha;
    scratchContext.shadowColor = rgba(customization.glowColor);
    scratchContext.shadowBlur = scaleStyleValue(
      customization.glowIntensity,
      composition.height,
    ) * viewport.scale;
    scratchContext.fillStyle = 'rgba(0,0,0,1)';
    roundedRect(scratchContext, geometry.border, geometry.radius);
    scratchContext.fill();
    scratchContext.shadowBlur = 0;
    scratchContext.shadowColor = 'rgba(0,0,0,0)';
    scratchContext.globalAlpha = 1;
    scratchContext.globalCompositeOperation = 'destination-out';
    roundedRect(scratchContext, geometry.border, geometry.radius);
    scratchContext.fill();
    scratchContext.restore();
    // The scratch surface already contains the transformed, viewport-positioned glow. Copying that
    // full-frame surface through the subtitle transform would apply the viewport and cue transform
    // a second time, shrinking and displacing the glow away from the box that cast it.
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.drawImage(scratchContext.canvas, 0, 0);
    context.restore();
  }
  if (!customization.gradientEnabled && customization.backgroundOpacity > 0) {
    context.fillStyle = subtitleBackgroundRgba(
      customization.backgroundColor,
      customization.backgroundOpacity,
      alpha,
    );
    roundedRect(context, geometry.border, geometry.radius);
    context.fill();
  }
  if (geometry.borderWidth > 0) {
    context.strokeStyle = rgba(customization.borderColor, alpha);
    context.setLineDash(customization.borderStyle === 'dashed'
      ? [geometry.borderWidth * 3, geometry.borderWidth * 3]
      : customization.borderStyle === 'dotted' ? [0, geometry.borderWidth * 2] : []);
    context.lineCap = customization.borderStyle === 'dotted' ? 'round' : 'butt';
    for (const band of subtitleBorderBands(geometry.borderWidth, customization.borderStyle)) {
      const centreInset = band.inset + band.width / 2;
      context.lineWidth = band.width;
      roundedRect(context, {
        left: geometry.border.left + centreInset,
        top: geometry.border.top + centreInset,
        width: geometry.border.width - centreInset * 2,
        height: geometry.border.height - centreInset * 2,
      }, Math.max(0, geometry.radius - centreInset));
      context.stroke();
    }
  }
  context.restore();

  if (customization.textShadowEnabled) {
    const offsetX = scaleStyleValue(customization.textShadowOffsetX, composition.height) * viewport.scale;
    const offsetY = scaleStyleValue(customization.textShadowOffsetY, composition.height) * viewport.scale;
    scratchContext.save();
    scratchContext.setTransform(1, 0, 0, 1, 0, 0);
    scratchContext.clearRect(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
    scratchContext.filter = `blur(${Math.min(
      scaleStyleValue(customization.textShadowBlur, composition.height) * viewport.scale * 0.5,
      64,
    )}px)`;
    scratchContext.drawImage(maskContext.canvas, offsetX, offsetY);
    scratchContext.filter = 'none';
    scratchContext.globalCompositeOperation = 'source-in';
    scratchContext.fillStyle = rgba(customization.textShadowColor);
    scratchContext.globalAlpha = alpha;
    scratchContext.fillRect(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
    scratchContext.restore();
    context.drawImage(scratchContext.canvas, 0, 0);
  }

  if (customization.strokeEnabled && customization.strokeWidth > 0) {
    const radius = scaleStyleValue(customization.strokeWidth, composition.height) * viewport.scale / 2;
    scratchContext.save();
    scratchContext.setTransform(1, 0, 0, 1, 0, 0);
    scratchContext.clearRect(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
    for (let tap = 0; tap < STROKE_TAPS; tap += 1) {
      const angle = (tap / STROKE_TAPS) * Math.PI * 2;
      scratchContext.drawImage(maskContext.canvas, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    scratchContext.globalCompositeOperation = 'source-in';
    scratchContext.fillStyle = rgba(customization.strokeColor);
    scratchContext.globalAlpha = alpha;
    scratchContext.fillRect(0, 0, scratchContext.canvas.width, scratchContext.canvas.height);
    scratchContext.restore();
    context.drawImage(scratchContext.canvas, 0, 0);
  }

  const fill = customization.gradientEnabled
    ? gradientPaint(context, customization, viewport, geometry, cueTransform)
    : rgba(customization.textColor);
  tintMask(context, scratchContext, maskContext.canvas, fill, alpha);

  if (customization.animationType === 'word-highlight' && Array.isArray(active?.cue?.words) && active.cue.words.length > 0) {
    const activeWord = active.cue.words.find((w) => {
      const start = w.startMs ?? w.start_ms ?? Math.round((w.start || 0) * 1000);
      const end = w.endMs ?? w.end_ms ?? Math.round((w.end || 0) * 1000);
      return start <= instantMs && instantMs < end;
    });
    if (activeWord) {
      const { startCell, endCell } = findWordCellRange(atlas, active.cue.words, activeWord);
      if (startCell !== null && endCell !== null) {
        drawGlyphMask({
          context: maskContext,
          atlasCanvas,
          atlas,
          geometry,
          viewport,
          cueTransform,
          startCell,
          revealed: endCell,
        });
        const highlightColor = rgba(customization.highlightColor || '#B4B5FF');
        tintMask(context, scratchContext, maskContext.canvas, highlightColor, alpha);
      }
    }
  }
};

const resizeWorkCanvas = (canvas, width, height) => {
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
};

export const createAtlasCanvas = (atlas) => {
  const canvas = document.createElement('canvas');
  canvas.width = atlas.atlas.widthPx;
  canvas.height = atlas.atlas.heightPx;
  const context = canvas.getContext('2d', { alpha: true });
  if (context === null) throw new Error('canvasPreviewUnavailable');
  if (canvas.width > 0 && canvas.height > 0) {
    const pixels = new Uint8ClampedArray(
      atlas.pixels.buffer,
      atlas.pixels.byteOffset,
      atlas.pixels.byteLength,
    );
    context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  }
  return canvas;
};

export const createCanvasSubtitleRenderer = (canvas, { drawVideo = true } = {}) => {
  // The visible canvas is a presentation surface, not a work surface. A desynchronised context may
  // expose the intermediate video-only paint before the subtitle pass completes, which looks like
  // the subtitle blinking even though the cue and atlas never changed.
  const context = canvas.getContext('2d', { alpha: !drawVideo });
  if (context === null) throw new Error('canvasPreviewUnavailable');
  const frame = document.createElement('canvas');
  const mask = document.createElement('canvas');
  const scratch = document.createElement('canvas');
  const staticOverlay = document.createElement('canvas');
  const sourceFrames = [document.createElement('canvas'), document.createElement('canvas')];
  const frameContext = frame.getContext('2d', { alpha: !drawVideo });
  const maskContext = mask.getContext('2d', { alpha: true });
  const scratchContext = scratch.getContext('2d', { alpha: true });
  const staticOverlayContext = staticOverlay.getContext('2d', { alpha: true });
  const sourceFrameContexts = sourceFrames.map(source => source.getContext('2d', { alpha: false }));
  if (frameContext === null || maskContext === null || scratchContext === null
      || staticOverlayContext === null || sourceFrameContexts.some(source => source === null)) {
    throw new Error('canvasPreviewUnavailable');
  }
  let staticState = null;

  const isStaticSubtitle = (active, cueTransform) => active?.phase === 'holding'
    && active.eased === 1
    && cueTransform.x === 0
    && cueTransform.y === 0
    && cueTransform.scale === 1
    && cueTransform.rotate === 0
    && cueTransform.rotateY === 0;

  const staticStateMatches = ({ atlasEntry, customization, composition, viewport }) => (
    staticState !== null
    && staticState.atlasEntry === atlasEntry
    && staticState.customization === customization
    && staticState.composition === composition
    && staticState.width === canvas.width
    && staticState.height === canvas.height
    && staticState.viewportLeft === viewport.left
    && staticState.viewportTop === viewport.top
    && staticState.viewportWidth === viewport.width
    && staticState.viewportHeight === viewport.height
  );

  return Object.freeze({
    captureVideoFrame(video, retained = null) {
      const width = Number(video?.videoWidth ?? 0);
      const height = Number(video?.videoHeight ?? 0);
      if (!(width > 0 && height > 0 && video?.readyState >= 2)) return null;
      const retainedImage = retained?.image ?? retained;
      const index = sourceFrames[0] === retainedImage ? 1 : 0;
      const source = sourceFrames[index];
      const sourceContext = sourceFrameContexts[index];
      resizeWorkCanvas(source, width, height);
      sourceContext.setTransform(1, 0, 0, 1, 0, 0);
      sourceContext.globalAlpha = 1;
      sourceContext.filter = 'none';
      sourceContext.drawImage(video, 0, 0, width, height);
      return Object.freeze({
        image: source,
        videoWidth: width,
        videoHeight: height,
        readyState: 4,
      });
    },
    /**
     * Whether a captured frame looks like the solid-black transitioning decoder surface that
     * drawImage may legally return around a seek boundary. Nine sampled pixels, one readback —
     * callers gate this to the first capture(s) of a seek generation so steady playback never
     * pays for it. Real black CONTENT also matches, which is why callers reject at most a bounded
     * number of captures before accepting the picture as truth.
     */
    captureLooksBlack(captured) {
      const image = captured?.image ?? captured;
      const width = Number(captured?.videoWidth ?? image?.width ?? 0);
      const height = Number(captured?.videoHeight ?? image?.height ?? 0);
      if (!(width > 0 && height > 0) || typeof image?.getContext !== 'function') return false;
      const context = image.getContext('2d');
      if (context === null) return false;
      for (const xRatio of [0.1, 0.5, 0.9]) {
        for (const yRatio of [0.1, 0.5, 0.9]) {
          const x = Math.min(width - 1, Math.round(width * xRatio));
          const y = Math.min(height - 1, Math.round(height * yRatio));
          let data;
          try {
            data = context.getImageData(x, y, 1, 1).data;
          } catch {
            return false;
          }
          if (data[0] + data[1] + data[2] > 24) return false;
        }
      }
      return true;
    },
    draw({ video, composition, crop, atlasEntry, customization, active, cueTransform }) {
      const width = canvas.width;
      const height = canvas.height;
      if (width <= 0 || height <= 0) return null;
      resizeWorkCanvas(frame, width, height);
      resizeWorkCanvas(mask, width, height);
      resizeWorkCanvas(scratch, width, height);
      frameContext.setTransform(1, 0, 0, 1, 0, 0);
      frameContext.globalAlpha = 1;
      frameContext.filter = 'none';
      const viewport = fitContain(width, height, composition.width, composition.height);
      let videoReady;
      if (drawVideo) {
        frameContext.fillStyle = '#000';
        frameContext.fillRect(0, 0, width, height);
        videoReady = drawVideoUnderlay(frameContext, video, viewport, crop);
      } else {
        frameContext.clearRect(0, 0, width, height);
        videoReady = videoIsDrawable(video);
      }
      // The work canvas begins black. Publishing it while the decoder is between frames replaces a
      // valid visible composition with a transient blank one (most visibly during seeks). Leave the
      // presentation canvas untouched until an entire replacement frame can be composed.
      if (!videoReady) return { drewVideo: false, viewport, overlayRebuilt: false };
      let overlayRebuilt = false;
      if (atlasEntry !== null && active !== null) {
        const args = {
          maskContext,
          scratchContext,
          atlasCanvas: atlasEntry.canvas,
          atlas: atlasEntry.atlas,
          customization,
          composition,
          viewport,
          active,
          cueTransform,
        };
        if (isStaticSubtitle(active, cueTransform)) {
          resizeWorkCanvas(staticOverlay, width, height);
          if (!staticStateMatches({ atlasEntry, customization, composition, viewport })) {
            staticOverlayContext.setTransform(1, 0, 0, 1, 0, 0);
            staticOverlayContext.clearRect(0, 0, width, height);
            paintSubtitle({ context: staticOverlayContext, ...args });
            staticState = {
              atlasEntry,
              customization,
              composition,
              width,
              height,
              viewportLeft: viewport.left,
              viewportTop: viewport.top,
              viewportWidth: viewport.width,
              viewportHeight: viewport.height,
            };
            overlayRebuilt = true;
          }
          frameContext.drawImage(staticOverlay, 0, 0);
        } else {
          paintSubtitle({ context: frameContext, ...args });
        }
      }
      // One visible-canvas operation publishes the complete video + subtitle frame. The browser
      // can no longer present the interval between clearing the prior frame and painting text.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.globalAlpha = 1;
      context.filter = 'none';
      // `copy` replaces the complete presentation bitmap in one operation, including transparent
      // pixels. With a direct-video underlay, source-over would retain subtitle pixels from the
      // prior cue anywhere the new transparent overlay does not repaint.
      context.globalCompositeOperation = 'copy';
      context.drawImage(frame, 0, 0);
      context.globalCompositeOperation = 'source-over';
      return { drewVideo: videoReady, viewport, overlayRebuilt };
    },
  });
};
