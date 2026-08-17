import { globSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import {
  applySubtitleAnimationEasing,
  SUBTITLE_ANIMATION_EASINGS,
} from './subtitleAnimationEasing';
import { scaleSubtitleStyleValue } from './subtitleVisualMath';

const ROOT = resolve(__dirname, '..', '..', '..');
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

  /**
   * This used to read the two WebView compositors and require both to call THESE functions instead
   * of a local copy. Both compositors are deleted, so the same statement is now made about what is
   * left: nothing in the product carries a second easing curve. The curve itself stays locked to
   * the native renderer by `crates/osg-scene/tests/fixtures/subtitle-math-golden.json`, asserted
   * from Rust and from `scripts/render-parity-fixture.test.mjs`.
   *
   * Scaling is deliberately NOT scanned the same way: `src/components/previews/native/
   * nativePreviewGeometry.js` mirrors `scaleSubtitleStyleValue` on purpose, because it derives
   * glyph-atlas geometry rather than a CSS style, and it says so where it defines the mirror. What
   * is banned is the rounding the old compositors did INSTEAD of that function.
   */
  it('is the only easing curve left in the product', () => {
    const modules = globSync('src/**/*.{js,jsx,ts,tsx}', { cwd: ROOT, absolute: true })
      .filter((path) => !/[\\/]shared[\\/]subtitle[\\/]subtitleAnimationEasing\./.test(path));
    expect(modules.length).toBeGreaterThan(100);
    for (const path of modules) {
      const source = readFileSync(path, 'utf8');
      expect(source, `${relative(ROOT, path)} defines a second easing curve`)
        .not.toMatch(/const\s+applyEasing\s*=/);
      expect(source, `${relative(ROOT, path)} rounds a scaled style itself`)
        .not.toContain('Math.round(value * scale)');
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
