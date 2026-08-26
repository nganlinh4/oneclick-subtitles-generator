import { describe, expect, it } from 'vitest';

import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';
import {
  applyPreviewSettingsToProjectScene,
  previewCustomizationForNativeRender,
  previewSettingsFromProjectScene,
} from './projectPreviewSettings';

const scene = (customization = {}, selectedSubtitles = 'original') => ({
  selectedSubtitles,
  selectedNarration: 'none',
  renderSettings: { resolution: '1080p' },
  customization: { ...defaultCustomization, ...customization },
  crop: { width: 100 },
});

describe('one project-owned subtitle style', () => {
  it('round-trips every exposed editor value into the native fields', () => {
    const legacy = {
      fontFamily: 'Arial, sans-serif',
      fontSize: '96',
      fontWeight: '700',
      position: '20',
      boxWidth: '100',
      backgroundColor: '#6a004f',
      opacity: '1',
      textColor: '#00ffff',
      textAlign: 'right',
      textTransform: 'uppercase',
      lineSpacing: '1.5',
      letterSpacing: '2',
      backgroundRadius: '20',
      backgroundPadding: '24',
      textShadow: true,
      showTranslatedSubtitles: true,
    };
    const updated = applyPreviewSettingsToProjectScene(scene(), legacy);
    expect(updated).toMatchObject({
      selectedSubtitles: 'translated',
      customization: {
        fontFamily: 'Arial, sans-serif',
        fontSize: 96,
        fontWeight: 700,
        position: 'custom',
        customPositionY: 20,
        maxWidth: 100,
        backgroundColor: '#6a004f',
        backgroundOpacity: 100,
        textColor: '#00ffff',
        textAlign: 'right',
        textTransform: 'uppercase',
        lineHeight: 1.5,
        letterSpacing: 2,
        borderRadius: 20,
        backgroundPaddingX: 24,
        backgroundPaddingY: 24,
        textShadowEnabled: true,
      },
    });
    expect(previewSettingsFromProjectScene(updated)).toMatchObject(legacy);
  });

  it('changes only the edited basic field and preserves every advanced field', () => {
    const previous = scene({
      position: 'bottom',
      customPositionY: 17,
      gradientEnabled: true,
      gradientColorStart: '#123456',
      animationType: 'typewriter',
      preset: 'customer-preset',
    });
    const before = previewSettingsFromProjectScene(previous);
    const updated = applyPreviewSettingsToProjectScene(previous, { ...before, fontSize: '72' });
    expect(updated.customization).toMatchObject({
      fontSize: 72,
      position: 'bottom',
      customPositionY: 17,
      gradientEnabled: true,
      gradientColorStart: '#123456',
      animationType: 'typewriter',
      preset: 'customer-preset',
    });
  });

  it('bounds corrupt browser-era values before a one-time migration', () => {
    expect(previewCustomizationForNativeRender({
      fontFamily: `bad\u0000${'x'.repeat(300)}`,
      fontWeight: 555,
      opacity: 9,
      position: -1,
    })).toMatchObject({
      fontFamily: defaultCustomization.fontFamily,
      fontWeight: defaultCustomization.fontWeight,
      backgroundOpacity: defaultCustomization.backgroundOpacity,
      customPositionY: 90,
    });
  });
});
