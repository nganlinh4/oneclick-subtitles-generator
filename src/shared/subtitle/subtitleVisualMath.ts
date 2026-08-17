const REFERENCE_HEIGHT = 1_080;

export const scaleSubtitleStyleValue = (
  value: number,
  compositionHeight: number,
): number => Number(((value * compositionHeight) / REFERENCE_HEIGHT).toFixed(2));
