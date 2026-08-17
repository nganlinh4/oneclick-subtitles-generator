import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultCustomization as rendererDefaultCustomization } from '../../shared/subtitle/SubtitleCustomization';

import {
  defaultCustomization,
  mergeSubtitleCustomizationDefaults,
  parseStoredSubtitleCustomization,
} from './defaultCustomization';
import { presetOrder, presets } from './presetDefinitions';

describe('subtitle customization default authority', () => {
  it('shares one frozen value between editor and native renderer', () => {
    expect(defaultCustomization).toBe(rendererDefaultCustomization);
    expect(Object.isFrozen(defaultCustomization)).toBe(true);
    expect(defaultCustomization).toMatchObject({
      fontFamily: "'Arial', sans-serif",
      fontWeight: 400,
      backgroundOpacity: 70,
      strokeWidth: 0,
    });
  });

  it('fills partial legacy settings and drops unknown fields', () => {
    const merged = mergeSubtitleCustomizationDefaults({
      fontSize: 72,
      animationEasing: 'linear',
      unknownNativeField: 'do-not-forward',
    });
    expect(merged).toEqual({
      ...defaultCustomization,
      fontSize: 72,
      animationEasing: 'linear',
    });
    expect(Object.hasOwn(merged, 'unknownNativeField')).toBe(false);
  });

  it('does not execute accessors while merging persisted values', () => {
    let reads = 0;
    const candidate = {};
    Object.defineProperty(candidate, 'fontSize', {
      enumerable: true,
      get: () => {
        reads += 1;
        return 99;
      },
    });
    expect(mergeSubtitleCustomizationDefaults(candidate).fontSize).toBe(
      defaultCustomization.fontSize,
    );
    expect(reads).toBe(0);
  });

  it('falls back per field when persisted values violate the native render contract', () => {
    const merged = mergeSubtitleCustomizationDefaults({
      fontSize: Number.POSITIVE_INFINITY,
      fontFamily: 'unsafe\u0000font',
      fontWeight: 450,
      textColor: 'red',
      textAlign: 'middle',
      lineHeight: 100,
      borderStyle: 'groove',
      animationEasing: 'steps(2)',
      maxLines: 0,
      rtlSupport: 'false',
      preset: '',
      backgroundOpacity: 42,
      gradientDirection: '360deg',
    });

    expect(merged).toEqual({
      ...defaultCustomization,
      backgroundOpacity: 42,
      gradientDirection: '360deg',
    });
  });

  it('rejects malformed Unicode and accepts reviewed catalog boundary values', () => {
    const merged = mergeSubtitleCustomizationDefaults({
      fontFamily: '\ud800',
      preset: '\udc00',
      fontWeight: 900,
      textColor: '#abcd',
      textAlign: 'justify',
      borderStyle: 'double',
      shadowLayers: 16,
      maxLines: 32,
      animationEasing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    });

    expect(merged.fontFamily).toBe(defaultCustomization.fontFamily);
    expect(merged.preset).toBe(defaultCustomization.preset);
    expect(merged).toMatchObject({
      fontWeight: 900,
      textColor: '#abcd',
      textAlign: 'justify',
      borderStyle: 'double',
      shadowLayers: 16,
      maxLines: 32,
      animationEasing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    });
  });

  it('round-trips every built-in and bounded user preset identity', () => {
    for (const preset of presetOrder) {
      expect(parseStoredSubtitleCustomization(JSON.stringify(presets[preset])).preset).toBe(preset);
    }
    for (const preset of ['custom_1750000000000', 'brand-preset-01', '한글-😀']) {
      expect(parseStoredSubtitleCustomization(JSON.stringify({ preset })).preset).toBe(preset);
    }
  });

  it('falls back only the invalid preset identity at the native string boundaries', () => {
    for (const preset of ['', 'bad\u0000preset', '\ud800', 'x'.repeat(129)]) {
      const merged = mergeSubtitleCustomizationDefaults({ preset, fontSize: 72 });
      expect(merged.preset).toBe(defaultCustomization.preset);
      expect(merged.fontSize).toBe(72);
    }
    expect(mergeSubtitleCustomizationDefaults({ preset: '한'.repeat(43) }).preset).toBe(
      defaultCustomization.preset,
    );
    expect(mergeSubtitleCustomizationDefaults({ preset: '한'.repeat(42) + 'ab' }).preset).toBe(
      '한'.repeat(42) + 'ab',
    );
  });

  it.each([null, '', '{bad-json', 'null', '[]', '42'])(
    'recovers a complete default from malformed persisted input %#',
    (serialized) => {
      expect(parseStoredSubtitleCustomization(serialized)).toEqual(defaultCustomization);
      expect(parseStoredSubtitleCustomization(serialized)).not.toBe(defaultCustomization);
    },
  );

  // This also required the WebView composition to import the default rather than declare its own
  // fallback object. That composition is deleted, so what remains is the surviving half: the render
  // tab still reads its persisted style through this parser, and the read lives in the state module
  // that owns the default merge for both the preview and the export.
  it('reads the persisted style through one parser owned by the state module', () => {
    const stateSource = readFileSync(
      resolve('src/components/VideoRenderingSection/subtitleCustomizationState.js'),
      'utf8',
    );
    expect(stateSource).toContain('parseStoredSubtitleCustomization(');
    const sectionSource = readFileSync(resolve('src/components/VideoRenderingSection.js'), 'utf8');
    expect(sectionSource).toContain('useSubtitleCustomization()');
    expect(sectionSource).not.toContain('JSON.parse(saved)');
  });
});
