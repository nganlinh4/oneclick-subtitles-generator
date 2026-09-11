/**
 * Constants for subtitle settings
 */

import { defaultSubtitleCustomization } from '../../shared/subtitle/subtitleCustomizationDefaults';

// Default settings
export const defaultSettings = {
  fontFamily: defaultSubtitleCustomization.fontFamily,
  fontSize: String(defaultSubtitleCustomization.fontSize),
  fontWeight: '400',
  position: '90',
  boxWidth: '80',
  backgroundColor: '#000000',
  opacity: '0.7',
  textColor: '#ffffff',
  textAlign: 'center',
  textTransform: 'none',
  lineSpacing: '1.4',
  letterSpacing: '0',
  backgroundRadius: '4',
  backgroundPadding: '10',
  textShadow: false,
  showTranslatedSubtitles: false
};

// Text align options - using translation keys
export const getTextAlignOptions = (t) => [
  { value: 'left', label: t('subtitleSettings.textAlignLeft', 'Left') },
  { value: 'center', label: t('subtitleSettings.textAlignCenter', 'Center') },
  { value: 'right', label: t('subtitleSettings.textAlignRight', 'Right') }
];

// Text transform options - using translation keys
export const getTextTransformOptions = (t) => [
  { value: 'none', label: t('subtitleSettings.textTransformNone', 'None') },
  { value: 'uppercase', label: t('subtitleSettings.textTransformUppercase', 'UPPERCASE') },
  { value: 'lowercase', label: t('subtitleSettings.textTransformLowercase', 'lowercase') },
  { value: 'capitalize', label: t('subtitleSettings.textTransformCapitalize', 'Capitalize') }
];
