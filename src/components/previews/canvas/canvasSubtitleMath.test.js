import { describe, expect, it } from 'vitest';

import fixture from '../../../../crates/osg-scene/tests/fixtures/subtitle-math-golden.json';
import {
  activeCueAt,
  cueTransformAt,
  easeSubtitle,
  resolveSubtitleGeometry,
  scaleStyleValue,
} from './canvasSubtitleMath';

describe('canvas preview shares the frozen Rust scene maths', () => {
  it('matches every easing sample in the cross-language fixture', () => {
    for (const sample of fixture.easingSamples) {
      expect(easeSubtitle(sample.progress, sample.easing)).toBe(sample.eased);
    }
  });

  it('matches every resolution-scaling sample in the cross-language fixture', () => {
    for (const sample of fixture.scaleSamples) {
      expect(scaleStyleValue(sample.value, sample.compositionHeight)).toBe(sample.scaled);
    }
  });
});

describe('canvas cue selection and placement', () => {
  const cues = [
    { start: 1, end: 2, text: 'first' },
    { start: 1.5, end: 3, text: 'overlap' },
  ];

  it('widens by fades and keeps the exporter first-match-wins rule', () => {
    expect(activeCueAt(cues, 0.8, 0.3, 0.2)).toMatchObject({ index: 0, phase: 'fadingIn' });
    expect(activeCueAt(cues, 1.75, 0.3, 0.2)).toMatchObject({ index: 0, phase: 'holding' });
    expect(activeCueAt(cues, 2.1, 0.3, 0.2)).toMatchObject({ index: 0, phase: 'fadingOut' });
  });

  it('uses the same asymmetric animation transforms as export', () => {
    expect(cueTransformAt('slide-up', 'fadingIn', 0.5, 'linear').y).toBe(25);
    expect(cueTransformAt('slide-up', 'fadingOut', 0.5, 'linear').y).toBe(-25);
    expect(cueTransformAt('bounce', 'fadingOut', 0.5, 'linear').scale).toBe(1);
    expect(cueTransformAt('fade', 'holding', 1, 'linear')).toEqual({
      x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0,
    });
  });

  it('places a custom-positioned shaped line from its atlas metrics', () => {
    const geometry = resolveSubtitleGeometry({
      customization: {
        fontSize: 50,
        backgroundPaddingX: 16,
        backgroundPaddingY: 8,
        borderWidth: 0,
        borderStyle: 'none',
        borderRadius: 4,
        position: 'custom',
        customPositionX: 50,
        customPositionY: 90,
      },
      composition: { width: 1_920, height: 1_080 },
      atlas: {
        face: { fontSizePx: 50 },
        metrics: { lineHeightPx: 60 },
        layout: {
          textAlign: 'center',
          lines: [{ advanceWidthPx: 200 }],
        },
      },
    });
    expect(geometry.glyphScale).toBe(1);
    expect(geometry.textWidth).toBe(200);
    expect(geometry.border.left).toBe(844);
    expect(geometry.border.top).toBe(934);
    expect(geometry.border.width).toBe(232);
    expect(geometry.border.height).toBe(76);
  });
});
