export const SUBTITLE_ANIMATION_EASINGS = [
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
] as const;

export type SubtitleAnimationEasing = typeof SUBTITLE_ANIMATION_EASINGS[number];

const SMOOTH_EASING = SUBTITLE_ANIMATION_EASINGS[5];
const BOUNCE_EASING = SUBTITLE_ANIMATION_EASINGS[6];
const BISECTION_STEPS = 40;

const cubicCoordinate = (parameter: number, first: number, second: number): number => {
  const inverse = 1 - parameter;
  return (3 * inverse * inverse * parameter * first)
    + (3 * inverse * parameter * parameter * second)
    + (parameter * parameter * parameter);
};

const evaluateCubicBezier = (
  progress: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number => {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;

  // CSS cubic-bezier timing uses progress as x, not as the curve parameter.
  // These reviewed curves have monotonic x control points, so fixed-step
  // bisection is deterministic and seek-safe for both preview and rendering.
  let lower = 0;
  let upper = 1;
  for (let index = 0; index < BISECTION_STEPS; index += 1) {
    const parameter = (lower + upper) / 2;
    if (cubicCoordinate(parameter, x1, x2) < progress) lower = parameter;
    else upper = parameter;
  }
  return cubicCoordinate((lower + upper) / 2, y1, y2);
};

export const applySubtitleAnimationEasing = (
  progress: number,
  easing: SubtitleAnimationEasing | string,
): number => {
  switch (easing) {
    case 'ease-in':
      return progress * progress;
    case 'ease-out':
      return 1 - Math.pow(1 - progress, 2);
    case 'ease':
    case 'ease-in-out':
      return progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
    case SMOOTH_EASING:
      return evaluateCubicBezier(progress, 0.25, 0.46, 0.45, 0.94);
    case BOUNCE_EASING:
      return evaluateCubicBezier(progress, 0.68, -0.55, 0.265, 1.55);
    case 'linear':
    default:
      return progress;
  }
};
