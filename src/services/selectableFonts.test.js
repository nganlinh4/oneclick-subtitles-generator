import { describe, expect, it } from 'vitest';

import { fontOptions } from '../components/subtitleCustomization/fontOptions';
import { MANAGED_PACK_STATE } from './fontCapability';
import {
  currentFontSelection,
  fontChoiceMatchesSelection,
  fontSelectionModel,
  selectableFontOptions,
  selectableFontWeights,
  systemFontProbe,
} from './selectableFonts';
import { DEFAULT_SUBTITLE_FONT_FAMILY } from '../shared/subtitle/defaultSubtitleFont';
import { UNAVAILABLE_REASON, sameFontIdentity } from './fontIdentity';

const capability = Object.freeze({
  managedPack: MANAGED_PACK_STATE.installed,
  managedPackInstalled: true,
});

const completeMetrics = (width) => ({
  width,
  actualBoundingBoxLeft: 0,
  actualBoundingBoxRight: width,
  actualBoundingBoxAscent: 12,
  actualBoundingBoxDescent: 4,
  fontBoundingBoxAscent: 13,
  fontBoundingBoxDescent: 4,
});

/** A browser-like surface where the requested face either participates or silently falls back. */
const faceMeasurementSurface = ({ participates }) => ({
  measure(cssFont) {
    const generic = ['monospace', 'serif', 'sans-serif'].find(
      family => cssFont.endsWith(family),
    );
    const genericWidth = { monospace: 160, serif: 144, 'sans-serif': 128 }[generic];
    const requested = cssFont.includes('"Arial"');
    return completeMetrics(requested && participates ? 119 : genericWidth);
  },
});

describe('renderer-backed font choices', () => {
  it('does not offer catalog entries the packaged renderer must refuse', () => {
    const choices = selectableFontOptions(fontOptions, {
      requestedWeight: 600,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    });
    expect(choices.length).toBeGreaterThan(1);
    expect(choices.length).toBeLessThan(fontOptions.length);
    expect(choices.some((font) => font.value.includes('Google Sans'))).toBe(true);
    expect(choices.some((font) => font.value.includes('Roboto'))).toBe(false);
    expect(choices.every((font) => Number.isInteger(font.resolvedWeight))).toBe(true);
    expect(new Set(choices.map(font => font.resolvedIdentityKey)).size).toBe(choices.length);
    expect(choices.filter(font => font.value === DEFAULT_SUBTITLE_FONT_FAMILY)).toHaveLength(1);
  });

  it('carries an actual system-face weight when the current slider value is unsupported', () => {
    const [arial] = selectableFontOptions([
      { value: "'Arial', sans-serif", label: 'Arial', group: 'Sans-serif' },
    ], {
      requestedWeight: 600,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    });
    expect(arial.resolvedWeight).toBe(400);
  });

  it('offers only the exact reviewed weight for the single-face Impact font', () => {
    expect(selectableFontWeights({
      fontFamily: "'Impact', sans-serif",
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    })).toEqual([400]);
  });

  it('offers every bounded exact weight of the managed variable face', () => {
    expect(selectableFontWeights({
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => false,
    })).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
  });

  it('keeps unavailable legacy catalog faces out of every renderer-backed picker', () => {
    const choices = selectableFontOptions(fontOptions, {
      requestedWeight: 400,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    });
    const labels = new Set(choices.map(choice => choice.label));
    expect(labels).not.toContain('Noto Sans Korean');
    expect(labels).not.toContain('JetBrains Mono');
    expect(labels).not.toContain('Helvetica');
  });

  it('offers no optimistic choices when platform identity is unknown', () => {
    expect(selectableFontOptions(fontOptions, {
      platform: null,
      capability,
      isSystemFaceInstalled: () => true,
    })).toEqual([]);
  });

  it('does not advertise a declared face when FontFaceSet says true but metrics prove fallback', () => {
    const fonts = { check: () => true };
    const isSystemFaceInstalled = systemFontProbe(
      fonts,
      faceMeasurementSurface({ participates: false }),
    );
    const choices = selectableFontOptions([
      { value: "'Arial', sans-serif", label: 'Arial', group: 'Sans-serif' },
      { value: DEFAULT_SUBTITLE_FONT_FAMILY, label: 'Google Sans', group: 'Sans-serif' },
    ], {
      requestedWeight: 400,
      platform: 'windows',
      capability,
      isSystemFaceInstalled,
    });
    expect(choices.map(choice => choice.label)).toEqual(['Google Sans']);
  });

  it('uses FontFaceSet only as a veto after metrics prove the exact face', () => {
    const surface = faceMeasurementSurface({ participates: true });
    const face = { family: 'Arial', weight: 400, style: 'normal', platform: 'windows' };
    expect(systemFontProbe(null, surface)(face)).toBe(true);
    expect(systemFontProbe({ check: () => true }, surface)(face)).toBe(true);
    expect(systemFontProbe({ check: () => false }, surface)(face)).toBe(false);
  });

  it.each([
    DEFAULT_SUBTITLE_FONT_FAMILY,
    'Google Sans, sans-serif',
    "'Google Sans', 'Be Vietnam Pro', sans-serif",
    "'Google Sans', 'Open Sans', sans-serif",
  ])('maps the canonical and legacy Google Sans stacks to one exact card: %s', (fontFamily) => {
    const model = fontSelectionModel(fontOptions, {
      fontFamily,
      fontWeight: 400,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    });
    expect(model.displayName).toBe('Google Sans');
    expect(model.selectedResolution.status).toBe('exact');
    expect(model.selectedOption?.value).toBe(DEFAULT_SUBTITLE_FONT_FAMILY);
    expect(sameFontIdentity(
      model.selectedOption?.resolvedIdentity,
      model.selectedResolution.identity,
    )).toBe(true);
    expect(fontChoiceMatchesSelection(model.selectedOption, model)).toBe(true);
    expect(model.options.filter(option => option.value === DEFAULT_SUBTITLE_FONT_FAMILY))
      .toHaveLength(1);
  });

  it('does not mark a fallback-weight card selected for an unavailable persisted weight', () => {
    const model = fontSelectionModel([
      { value: "'Arial', sans-serif", label: 'Arial', group: 'Sans-serif' },
    ], {
      fontFamily: "'Arial', sans-serif",
      fontWeight: 600,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => true,
    });
    expect(model.selectedResolution).toMatchObject({
      status: 'unavailable', reason: UNAVAILABLE_REASON.weightNotInFace,
    });
    expect(model.selectedOption).toBeNull();
    expect(model.displayName).toBe('Arial');
    expect(model.options[0]).toMatchObject({ resolvedWeight: 400 });
    expect(fontChoiceMatchesSelection(model.options[0], model)).toBe(false);
  });

  it('resolves the closed control without walking and probing the full catalog', () => {
    let probes = 0;
    const current = currentFontSelection(fontOptions, {
      fontFamily: "'Arial', sans-serif",
      fontWeight: 400,
      platform: 'windows',
      capability,
      isSystemFaceInstalled: () => {
        probes += 1;
        return true;
      },
    });
    expect(current.selectedResolution.status).toBe('exact');
    expect(current.displayName).toBe('Arial');
    expect(probes).toBe(1);
  });

  it.each([
    ["'Customer Font', sans-serif", 400, true],
    ["'Helvetica', sans-serif", 400, true],
    [DEFAULT_SUBTITLE_FONT_FAMILY, 400, false],
    [' , ', 400, true],
  ])('never selects an unavailable request: %s', (fontFamily, fontWeight, installed) => {
    const model = fontSelectionModel(fontOptions, {
      fontFamily,
      fontWeight,
      platform: 'windows',
      capability: { ...capability, managedPackInstalled: installed },
      isSystemFaceInstalled: () => true,
    });
    expect(model.selectedResolution.status).toBe('unavailable');
    expect(model.selectedOption).toBeNull();
  });
});
