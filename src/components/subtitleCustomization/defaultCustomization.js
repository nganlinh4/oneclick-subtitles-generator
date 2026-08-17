import { defaultSubtitleCustomization } from '../../shared/subtitle/subtitleCustomizationDefaults';

// This leaf imports only the shared pure frozen value, so preset modules can
// still spread it safely while preview and final rendering share one authority.
export const defaultCustomization = defaultSubtitleCustomization;

const customizationKeys = Object.freeze(Object.keys(defaultCustomization));

const enumValidator = (...values) => {
  const allowed = new Set(values);
  return value => allowed.has(value);
};

const finiteWithin = (minimum, maximum) => value => (
  typeof value === 'number'
  && Number.isFinite(value)
  && value >= minimum
  && value <= maximum
);

const integerWithin = (minimum, maximum) => value => (
  Number.isInteger(value) && value >= minimum && value <= maximum
);

const isWellFormedUnicode = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const hasControlCharacter = value => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
});

const boundedText = maximumBytes => value => (
  typeof value === 'string'
  && value.length > 0
  && isWellFormedUnicode(value)
  && !hasControlCharacter(value)
  && new TextEncoder().encode(value).byteLength <= maximumBytes
);

const colorValidator = value => (
  typeof value === 'string'
  && /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/iu.test(value)
);

const gradientDirectionValidator = value => {
  if (typeof value !== 'string' || !/^\d+deg$/u.test(value)) return false;
  return Number(value.slice(0, -3)) <= 360;
};

const booleanValidator = value => typeof value === 'boolean';
const fontWeightValidator = value => (
  Number.isInteger(value) && value >= 100 && value <= 900 && value % 100 === 0
);

const customizationValidators = Object.freeze({
  fontSize: finiteWithin(1, 1_000),
  fontFamily: boundedText(256),
  fontWeight: fontWeightValidator,
  textColor: colorValidator,
  textAlign: enumValidator('left', 'center', 'right', 'justify'),
  lineHeight: finiteWithin(0.1, 10),
  letterSpacing: finiteWithin(-100, 1_000),
  textTransform: enumValidator('none', 'uppercase', 'lowercase', 'capitalize'),
  backgroundColor: colorValidator,
  backgroundOpacity: finiteWithin(0, 100),
  borderRadius: finiteWithin(0, 1_000),
  borderWidth: finiteWithin(0, 100),
  borderColor: colorValidator,
  borderStyle: enumValidator('none', 'solid', 'dashed', 'dotted', 'double'),
  textShadowEnabled: booleanValidator,
  textShadowColor: colorValidator,
  textShadowBlur: finiteWithin(0, 1_000),
  textShadowOffsetX: finiteWithin(-2_000, 2_000),
  textShadowOffsetY: finiteWithin(-2_000, 2_000),
  glowEnabled: booleanValidator,
  glowColor: colorValidator,
  glowIntensity: finiteWithin(0, 1_000),
  gradientEnabled: booleanValidator,
  gradientType: enumValidator('linear', 'radial'),
  gradientDirection: gradientDirectionValidator,
  gradientColorStart: colorValidator,
  gradientColorEnd: colorValidator,
  gradientColorMid: colorValidator,
  strokeEnabled: booleanValidator,
  strokeWidth: finiteWithin(0, 100),
  strokeColor: colorValidator,
  multiShadowEnabled: booleanValidator,
  shadowLayers: integerWithin(0, 16),
  pulseEnabled: booleanValidator,
  pulseSpeed: finiteWithin(0, 100),
  shakeEnabled: booleanValidator,
  shakeIntensity: finiteWithin(0, 1_000),
  position: enumValidator('bottom', 'top', 'center', 'custom'),
  customPositionX: finiteWithin(-1_000, 1_000),
  customPositionY: finiteWithin(-1_000, 1_000),
  marginBottom: finiteWithin(-10_000, 10_000),
  marginTop: finiteWithin(-10_000, 10_000),
  marginLeft: finiteWithin(-10_000, 10_000),
  marginRight: finiteWithin(-10_000, 10_000),
  maxWidth: finiteWithin(1, 1_000),
  fadeInDuration: finiteWithin(0, 60),
  fadeOutDuration: finiteWithin(0, 60),
  animationType: enumValidator(
    'fade',
    'slide-up',
    'slide-down',
    'slide-left',
    'slide-right',
    'scale',
    'bounce',
    'flip',
    'rotate',
    'typewriter',
  ),
  animationEasing: enumValidator(
    'linear',
    'ease',
    'ease-in',
    'ease-out',
    'ease-in-out',
    'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  ),
  wordWrap: booleanValidator,
  maxLines: integerWithin(1, 32),
  lineBreakBehavior: enumValidator('auto', 'manual'),
  rtlSupport: booleanValidator,
  // Built-in additions and user-created presets intentionally use open IDs.
  // Keep this identical to the bounded String accepted by the native contract.
  preset: boundedText(128),
});

export const mergeSubtitleCustomizationDefaults = (candidate) => {
  const merged = { ...defaultCustomization };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return merged;
  for (const key of customizationKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
    if (
      descriptor
      && Object.hasOwn(descriptor, 'value')
      && customizationValidators[key](descriptor.value)
    ) {
      merged[key] = descriptor.value;
    }
  }
  return merged;
};

export const parseStoredSubtitleCustomization = (serialized) => {
  if (typeof serialized !== 'string') return mergeSubtitleCustomizationDefaults(null);
  try {
    return mergeSubtitleCustomizationDefaults(JSON.parse(serialized));
  } catch {
    return mergeSubtitleCustomizationDefaults(null);
  }
};
