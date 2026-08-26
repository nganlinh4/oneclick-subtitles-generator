import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';

const boundedNumber = (value, fallback, minimum, maximum) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : fallback;
};

const validNativeColor = (value, fallback) => (
  typeof value === 'string'
    && /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/iu.test(value)
    ? value
    : fallback
);

const validNativeFontFamily = (value) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return defaultCustomization.fontFamily;
  }
  const encoded = new TextEncoder().encode(value);
  return encoded.byteLength <= 256 && !Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  }) ? value : defaultCustomization.fontFamily;
};

const validNativeFontWeight = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    && numeric >= 100
    && numeric <= 900
    && numeric % 100 === 0
    ? numeric
    : defaultCustomization.fontWeight;
};

const semanticPositionY = Object.freeze({ top: 10, center: 50, bottom: 90 });

/**
 * Parse the browser-era editor controls into the complete native customization contract.
 *
 * This remains only as a bounded compatibility/browser-render adapter. Shipping desktop previews
 * never use its defaults as a second style authority; they consume the durable project scene.
 */
export const previewCustomizationForNativeRender = (settings = {}) => {
  const position = boundedNumber(settings.position, 90, 0, 100);
  const textAlign = ['left', 'center', 'right'].includes(settings.textAlign)
    ? settings.textAlign
    : defaultCustomization.textAlign;
  const textTransform = ['none', 'uppercase', 'lowercase', 'capitalize'].includes(
    settings.textTransform,
  ) ? settings.textTransform : defaultCustomization.textTransform;
  const padding = boundedNumber(
    settings.backgroundPadding,
    defaultCustomization.backgroundPaddingY,
    0,
    1_000,
  );
  return {
    ...defaultCustomization,
    fontSize: boundedNumber(settings.fontSize, defaultCustomization.fontSize, 1, 1_000),
    fontFamily: validNativeFontFamily(settings.fontFamily),
    fontWeight: validNativeFontWeight(settings.fontWeight),
    textColor: validNativeColor(settings.textColor, defaultCustomization.textColor),
    textAlign,
    lineHeight: boundedNumber(settings.lineSpacing, defaultCustomization.lineHeight, 0.1, 10),
    letterSpacing: boundedNumber(
      settings.letterSpacing,
      defaultCustomization.letterSpacing,
      -100,
      1_000,
    ),
    textTransform,
    backgroundColor: validNativeColor(
      settings.backgroundColor,
      defaultCustomization.backgroundColor,
    ),
    backgroundOpacity: boundedNumber(
      Number(settings.opacity) * 100,
      defaultCustomization.backgroundOpacity,
      0,
      100,
    ),
    borderRadius: boundedNumber(
      settings.backgroundRadius,
      defaultCustomization.borderRadius,
      0,
      1_000,
    ),
    backgroundPaddingX: padding,
    backgroundPaddingY: padding,
    textShadowEnabled: settings.textShadow === true || settings.textShadow === 'true',
    position: 'custom',
    customPositionX: 50,
    customPositionY: position,
    maxWidth: boundedNumber(settings.boxWidth, defaultCustomization.maxWidth, 1, 100),
  };
};

const displayPositionY = (customization) => (
  customization.position === 'custom'
    ? customization.customPositionY
    : semanticPositionY[customization.position] ?? customization.customPositionY
);

/** Project scene -> the intentionally small controls exposed beside the main preview. */
export const previewSettingsFromProjectScene = (scene) => {
  const customization = scene?.customization ?? defaultCustomization;
  return Object.freeze({
    fontFamily: customization.fontFamily,
    fontSize: String(customization.fontSize),
    fontWeight: String(customization.fontWeight),
    position: String(displayPositionY(customization)),
    boxWidth: String(customization.maxWidth),
    backgroundColor: customization.backgroundColor,
    opacity: String(customization.backgroundOpacity / 100),
    textColor: customization.textColor,
    textAlign: customization.textAlign,
    textTransform: customization.textTransform,
    lineSpacing: String(customization.lineHeight),
    letterSpacing: String(customization.letterSpacing),
    backgroundRadius: String(customization.borderRadius),
    backgroundPadding: String(customization.backgroundPaddingY),
    textShadow: customization.textShadowEnabled,
    showTranslatedSubtitles: scene?.selectedSubtitles === 'translated',
  });
};

const sameControlValue = (left, right) => (
  typeof left === 'boolean' || typeof right === 'boolean'
    ? left === right
    : String(left) === String(right)
);

/**
 * Apply only controls the customer actually changed, preserving every advanced Render-tab field.
 * A full-object callback used to replace those fields from an unrelated default object.
 */
export const applyPreviewSettingsToProjectScene = (previous, nextSettings) => {
  const before = previewSettingsFromProjectScene(previous);
  const parsed = previewCustomizationForNativeRender(nextSettings);
  const customization = { ...previous.customization };

  const copyIfChanged = (control, ...keys) => {
    if (sameControlValue(before[control], nextSettings[control])) return;
    keys.forEach((key) => {
      customization[key] = parsed[key];
    });
  };

  copyIfChanged('fontFamily', 'fontFamily');
  copyIfChanged('fontSize', 'fontSize');
  copyIfChanged('fontWeight', 'fontWeight');
  copyIfChanged('textColor', 'textColor');
  copyIfChanged('textAlign', 'textAlign');
  copyIfChanged('lineSpacing', 'lineHeight');
  copyIfChanged('letterSpacing', 'letterSpacing');
  copyIfChanged('textTransform', 'textTransform');
  copyIfChanged('backgroundColor', 'backgroundColor');
  copyIfChanged('opacity', 'backgroundOpacity');
  copyIfChanged('backgroundRadius', 'borderRadius');
  copyIfChanged('textShadow', 'textShadowEnabled');
  if (!sameControlValue(before.position, nextSettings.position)) {
    customization.position = 'custom';
    customization.customPositionY = parsed.customPositionY;
  }
  copyIfChanged('boxWidth', 'maxWidth');
  if (!sameControlValue(before.backgroundPadding, nextSettings.backgroundPadding)) {
    customization.backgroundPaddingX = parsed.backgroundPaddingX;
    customization.backgroundPaddingY = parsed.backgroundPaddingY;
  }

  return {
    ...previous,
    selectedSubtitles: nextSettings.showTranslatedSubtitles ? 'translated' : 'original',
    customization,
  };
};
