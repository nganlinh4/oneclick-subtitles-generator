/**
 * Pure preview maths mirrored from `osg-scene` and `osg-compositor`.
 *
 * The WebView owns the interactive renderer, while Rust owns export. Both consume the same shaped
 * line atlas. These functions are the small numeric seam between them and intentionally contain no
 * DOM or canvas calls, so fixture tests can lock them to Rust without exercising a UI.
 */

const REFERENCE_WIDTH = 1_920;
const REFERENCE_HEIGHT = 1_080;
const BISECTION_STEPS = 40;

export const round2 = (value) => Number(Number(value).toFixed(2));

export const scaleStyleValue = (value, compositionHeight) => (
  round2((Number(value) * compositionHeight) / REFERENCE_HEIGHT)
);

export const marginFraction = (value, reference) => (
  round2((Number(value) / reference) * 100) / 100
);

const cubicCoordinate = (parameter, first, second) => {
  const inverse = 1 - parameter;
  return (3 * inverse * inverse * parameter * first)
    + (3 * inverse * parameter * parameter * second)
    + (parameter * parameter * parameter);
};

const cubicBezier = (progress, x1, y1, x2, y2) => {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < BISECTION_STEPS; index += 1) {
    const parameter = (lower + upper) / 2;
    if (cubicCoordinate(parameter, x1, x2) < progress) lower = parameter;
    else upper = parameter;
  }
  return cubicCoordinate((lower + upper) / 2, y1, y2);
};

export const easeSubtitle = (progress, easing) => {
  if (easing === 'ease-in') return progress * progress;
  if (easing === 'ease-out') return 1 - ((1 - progress) ** 2);
  if (easing === 'ease' || easing === 'ease-in-out') {
    return progress < 0.5
      ? 2 * progress * progress
      : 1 - (((-2 * progress) + 2) ** 2) / 2;
  }
  if (easing === 'cubic-bezier(0.25, 0.46, 0.45, 0.94)') {
    return cubicBezier(progress, 0.25, 0.46, 0.45, 0.94);
  }
  if (easing === 'cubic-bezier(0.68, -0.55, 0.265, 1.55)') {
    return cubicBezier(progress, 0.68, -0.55, 0.265, 1.55);
  }
  return progress;
};

export const activeCueAt = (cues, instant, fadeInValue, fadeOutValue) => {
  const fadeIn = Number.isFinite(fadeInValue) && fadeInValue > 0 ? fadeInValue : 0;
  const fadeOut = Number.isFinite(fadeOutValue) && fadeOutValue > 0 ? fadeOutValue : 0;
  const index = cues.findIndex((cue) => instant >= cue.start - fadeIn && instant <= cue.end + fadeOut);
  if (index < 0) return null;
  const cue = cues[index];
  if (instant < cue.start) {
    return { cue, index, phase: 'fadingIn', progress: (instant - (cue.start - fadeIn)) / fadeIn };
  }
  if (instant > cue.end) {
    return { cue, index, phase: 'fadingOut', progress: 1 - ((instant - cue.end) / fadeOut) };
  }
  return { cue, index, phase: 'holding', progress: 1 };
};

const slide = (entering, leaving, remaining, onEnter, onLeave) => {
  if (entering) return remaining * onEnter;
  if (leaving) return remaining * onLeave;
  return 0;
};

export const cueTransformAt = (animationValue, phase, progress, easing) => {
  const animation = animationValue === 'fade' ? 'none' : animationValue;
  const eased = easeSubtitle(progress, easing);
  const remaining = 1 - eased;
  const entering = phase === 'fadingIn';
  const leaving = phase === 'fadingOut';
  const transform = { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 };
  if (animation === 'slide-up') transform.y = slide(entering, leaving, remaining, 50, -50);
  else if (animation === 'slide-down') transform.y = slide(entering, leaving, remaining, -50, 50);
  else if (animation === 'slide-left') transform.x = slide(entering, leaving, remaining, 100, -100);
  else if (animation === 'slide-right') transform.x = slide(entering, leaving, remaining, -100, 100);
  else if (animation === 'scale' && (entering || leaving)) transform.scale = 0.5 + eased * 0.5;
  else if (animation === 'bounce' && entering) {
    transform.scale = 1 + Math.sin(eased * Math.PI * 3) * 0.1 * remaining;
  } else if (animation === 'flip') {
    transform.rotateY = slide(entering, leaving, remaining, 90, -90);
  } else if (animation === 'rotate') {
    transform.rotate = slide(entering, leaving, remaining, 180, -180);
  }
  return transform;
};

export const resolveSubtitleGeometry = ({
  customization,
  composition,
  atlas,
}) => {
  const { width, height } = composition;
  const layout = atlas.layout;
  const glyphScale = scaleStyleValue(customization.fontSize, height) / atlas.face.fontSizePx;
  const lineHeight = atlas.metrics.lineHeightPx * glyphScale;
  const lineWidths = layout.lines.map((line) => line.advanceWidthPx * glyphScale);
  const textWidth = Math.max(0, ...lineWidths);
  const textHeight = layout.lines.length * lineHeight;
  const align = layout.textAlign;
  const position = customization.position;

  let left;
  let right;
  let anchorY;
  let anchorBias;
  if (position === 'custom') {
    const centreX = width * (customization.customPositionX / 100);
    left = centreX;
    right = centreX;
    anchorY = height * (customization.customPositionY / 100);
    anchorBias = 0.5;
  } else {
    left = width * marginFraction(customization.marginLeft, REFERENCE_WIDTH);
    right = width * (1 - marginFraction(customization.marginRight, REFERENCE_WIDTH));
    if (position === 'bottom') {
      anchorY = height * (1 - marginFraction(customization.marginBottom, REFERENCE_HEIGHT));
      anchorBias = 1;
    } else if (position === 'top') {
      anchorY = height * marginFraction(customization.marginTop, REFERENCE_HEIGHT);
      anchorBias = 0;
    } else {
      anchorY = height * 0.5;
      anchorBias = 0.5;
    }
  }

  let blockLeft;
  if (position === 'custom') blockLeft = left - textWidth / 2;
  else if (align === 'right') blockLeft = right - textWidth;
  else if (align === 'center') blockLeft = left + ((right - left) - textWidth) / 2;
  else blockLeft = left;

  // The export contract carries no padding controls; these are the compositor's shipped literals.
  const paddingX = scaleStyleValue(customization.backgroundPaddingX ?? 16, height);
  const paddingY = scaleStyleValue(customization.backgroundPaddingY ?? 8, height);
  const borderWidth = customization.borderStyle !== 'none' && customization.borderWidth > 0
    ? scaleStyleValue(customization.borderWidth, height)
    : 0;
  const paddingHeight = textHeight + paddingY * 2;
  const border = {
    left: blockLeft - paddingX - borderWidth,
    top: anchorY - anchorBias * (paddingHeight + borderWidth * 2),
    width: textWidth + (paddingX + borderWidth) * 2,
    height: paddingHeight + borderWidth * 2,
  };
  const padding = {
    left: border.left + borderWidth,
    top: border.top + borderWidth,
    width: border.width - borderWidth * 2,
    height: border.height - borderWidth * 2,
  };
  return {
    glyphScale,
    lineHeight,
    lineWidths,
    textWidth,
    textHeight,
    align,
    blockLeft,
    textTop: padding.top + paddingY,
    padding,
    border,
    borderWidth,
    radius: scaleStyleValue(customization.borderRadius, height),
  };
};

export const lineLeft = (geometry, lineWidth) => {
  if (geometry.align === 'right') return geometry.blockLeft + geometry.textWidth - lineWidth;
  if (geometry.align === 'center') return geometry.blockLeft + (geometry.textWidth - lineWidth) / 2;
  return geometry.blockLeft;
};
