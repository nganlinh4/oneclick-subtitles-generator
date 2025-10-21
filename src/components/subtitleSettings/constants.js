/**
 * Constants for subtitle settings
 */

// Font options for the select element
export const fontOptions = [
  // Korean optimized fonts
  { value: "'Noto Sans KR', sans-serif", label: 'Noto Sans Korean', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Nanum Gothic', sans-serif", label: 'Nanum Gothic', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Malgun Gothic', sans-serif", label: 'Malgun Gothic', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Nanum Myeongjo', serif", label: 'Nanum Myeongjo', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Nanum Barun Gothic', sans-serif", label: 'Nanum Barun Gothic', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Spoqa Han Sans', sans-serif", label: 'Spoqa Han Sans', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'KoPub Batang', serif", label: 'KoPub Batang', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },
  { value: "'Gowun Dodum', sans-serif", label: 'Gowun Dodum', group: 'Korean Optimized', koreanSupport: true, vietnameseSupport: false },

  // Vietnamese optimized fonts
  { value: "'Google Sans', 'Be Vietnam Pro', sans-serif", label: 'Google Sans', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Noto Sans Vietnamese', sans-serif", label: 'Noto Sans Vietnamese', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Be Vietnam Pro', sans-serif", label: 'Be Vietnam Pro', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Sarabun', sans-serif", label: 'Sarabun', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Montserrat Alternates', sans-serif", label: 'Montserrat Alternates', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Josefin Sans', sans-serif", label: 'Josefin Sans', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },
  { value: "'Lexend', sans-serif", label: 'Lexend', group: 'Vietnamese Optimized', koreanSupport: false, vietnameseSupport: true },

  // Multilingual fonts with good support for both Korean and Vietnamese
  { value: "'Google Sans', 'Open Sans', sans-serif", label: 'Google Sans', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Open Sans', sans-serif", label: 'Open Sans', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Noto Sans', sans-serif", label: 'Noto Sans', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Noto Serif', serif", label: 'Noto Serif', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Arial Unicode MS', sans-serif", label: 'Arial Unicode', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Source Sans Pro', sans-serif", label: 'Source Sans Pro', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },

  // Standard sans-serif fonts
  { value: "'Poppins', sans-serif", label: 'Poppins', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Arial', sans-serif", label: 'Arial', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Helvetica', sans-serif", label: 'Helvetica', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Tahoma', sans-serif", label: 'Tahoma', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Verdana', sans-serif", label: 'Verdana', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },

  // Serif fonts
  { value: "'Georgia', serif", label: 'Georgia', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Times New Roman', serif", label: 'Times New Roman', group: 'Serif', koreanSupport: false, vietnameseSupport: true },

  // Monospace fonts
  { value: "'Nanum Gothic Coding', monospace", label: 'Nanum Gothic Coding', group: 'Monospace', koreanSupport: true, vietnameseSupport: false },
  { value: "'JetBrains Mono', monospace", label: 'JetBrains Mono', group: 'Monospace', koreanSupport: false, vietnameseSupport: true },
  { value: "'Courier New', monospace", label: 'Courier New', group: 'Monospace', koreanSupport: false, vietnameseSupport: false }
];

// Default settings
export const defaultSettings = {
  fontFamily: "'Noto Sans KR', sans-serif",
  fontSize: '24',
  fontWeight: '500',
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

// Font weight options - using translation keys
export const getFontWeightOptions = (t) => [
  { value: '300', label: t('subtitleSettings.fontWeightLight', 'Light') },
  { value: '400', label: t('subtitleSettings.fontWeightNormal', 'Normal') },
  { value: '500', label: t('subtitleSettings.fontWeightMedium', 'Medium') },
  { value: '600', label: t('subtitleSettings.fontWeightSemiBold', 'Semi Bold') },
  { value: '700', label: t('subtitleSettings.fontWeightBold', 'Bold') },
  { value: '800', label: t('subtitleSettings.fontWeightExtraBold', 'Extra Bold') }
];

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
