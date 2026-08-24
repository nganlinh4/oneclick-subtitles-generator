import { describe, expect, it } from 'vitest';

import { fontOptions } from '../components/subtitleCustomization/fontOptions';
import { MANAGED_PACK_STATE } from './fontCapability';
import { selectableFontOptions } from './selectableFonts';

const capability = Object.freeze({
  managedPack: MANAGED_PACK_STATE.installed,
  managedPackInstalled: true,
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

  it('offers no optimistic choices when platform identity is unknown', () => {
    expect(selectableFontOptions(fontOptions, { platform: null, capability })).toEqual([]);
  });
});
