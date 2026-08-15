import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applySubtitleAnimationEasing,
  SUBTITLE_ANIMATION_EASINGS,
} from '../../video-renderer/src/subtitleAnimationEasing';
import { scaleSubtitleStyleValue } from '../../video-renderer/src/subtitleVisualMath';

const SMOOTH = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
const BOUNCE = 'cubic-bezier(0.68, -0.55, 0.265, 1.55)';

describe('shared subtitle animation easing', () => {
  it('retains the five legacy easing results', () => {
    expect(applySubtitleAnimationEasing(0.25, 'linear')).toBe(0.25);
    expect(applySubtitleAnimationEasing(0.25, 'ease-in')).toBe(0.0625);
    expect(applySubtitleAnimationEasing(0.25, 'ease-out')).toBe(0.4375);
    expect(applySubtitleAnimationEasing(0.25, 'ease-in-out')).toBe(0.125);
    expect(applySubtitleAnimationEasing(0.25, 'ease')).toBe(0.125);
    expect(applySubtitleAnimationEasing(0.25, 'unknown')).toBe(0.25);
  });

  it('solves CSS cubic-bezier x before evaluating y', () => {
    expect(applySubtitleAnimationEasing(0.25, SMOOTH)).toBeCloseTo(0.4533762119857496, 10);
    expect(applySubtitleAnimationEasing(0.5, SMOOTH)).toBeCloseTo(0.7713235622464704, 10);
    expect(applySubtitleAnimationEasing(0.25, BOUNCE)).toBeCloseTo(-0.08280710882832257, 10);
    expect(applySubtitleAnimationEasing(0.75, BOUNCE)).toBeCloseTo(1.089165774813421, 10);
  });

  it('has exact endpoints and preserves the bounce overshoot', () => {
    for (const easing of SUBTITLE_ANIMATION_EASINGS) {
      expect(applySubtitleAnimationEasing(0, easing)).toBe(0);
      expect(applySubtitleAnimationEasing(1, easing)).toBe(1);
    }
    expect(applySubtitleAnimationEasing(0.2, BOUNCE)).toBeLessThan(0);
    expect(applySubtitleAnimationEasing(0.8, BOUNCE)).toBeGreaterThan(1);
  });

  it('is the sole easing authority for preview and native rendering', () => {
    const preview = readFileSync(
      resolve('src/components/SubtitledVideoComposition.js'),
      'utf8',
    );
    const renderer = readFileSync(
      resolve('video-renderer/src/components/SubtitledVideo.tsx'),
      'utf8',
    );
    for (const source of [preview, renderer]) {
      expect(source).toContain('applySubtitleAnimationEasing(progress, easing)');
      expect(source).toContain('scaleSubtitleStyleValue(value, compositionHeight)');
      expect(source).not.toMatch(/const\s+applyEasing\s*=/);
      expect(source).not.toContain('Math.round(value * scale)');
    }
  });

  it('uses identical two-decimal style scaling at every render resolution', () => {
    expect(scaleSubtitleStyleValue(1, 360)).toBe(0.33);
    expect(scaleSubtitleStyleValue(1, 480)).toBe(0.44);
    expect(scaleSubtitleStyleValue(1, 720)).toBe(0.67);
    expect(scaleSubtitleStyleValue(1, 1_080)).toBe(1);
    expect(scaleSubtitleStyleValue(1, 1_440)).toBe(1.33);
    expect(scaleSubtitleStyleValue(1, 2_160)).toBe(2);
  });
});
