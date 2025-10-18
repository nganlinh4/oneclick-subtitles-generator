import React from 'react';

/**
 * Comprehensive font options with multilingual support
 * Based on video-renderer font options with additional fonts
 */

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
  { value: "'Arial', sans-serif", label: 'Arial', group: 'Multilingual', koreanSupport: false, vietnameseSupport: false },
  { value: "'Helvetica', sans-serif", label: 'Helvetica', group: 'Multilingual', koreanSupport: false, vietnameseSupport: false },
  { value: "'Roboto', sans-serif", label: 'Roboto', group: 'Multilingual', koreanSupport: true, vietnameseSupport: true },
  { value: "'Montserrat', sans-serif", label: 'Montserrat', group: 'Multilingual', koreanSupport: false, vietnameseSupport: true },
  { value: "'Poppins', sans-serif", label: 'Poppins', group: 'Multilingual', koreanSupport: false, vietnameseSupport: true },

  // Chinese optimized fonts
  { value: "'Noto Sans SC', sans-serif", label: 'Noto Sans Simplified Chinese', group: 'Chinese Optimized', chineseSupport: true },
  { value: "'Noto Sans TC', sans-serif", label: 'Noto Sans Traditional Chinese', group: 'Chinese Optimized', chineseSupport: true },
  { value: "'Source Han Sans', sans-serif", label: 'Source Han Sans', group: 'Chinese Optimized', chineseSupport: true },
  { value: "'PingFang SC', sans-serif", label: 'PingFang SC', group: 'Chinese Optimized', chineseSupport: true },

  // Japanese optimized fonts
  { value: "'Noto Sans JP', sans-serif", label: 'Noto Sans Japanese', group: 'Japanese Optimized', japaneseSupport: true },
  { value: "'Hiragino Sans', sans-serif", label: 'Hiragino Sans', group: 'Japanese Optimized', japaneseSupport: true },
  { value: "'Yu Gothic', sans-serif", label: 'Yu Gothic', group: 'Japanese Optimized', japaneseSupport: true },

  // Arabic optimized fonts
  { value: "'Noto Sans Arabic', sans-serif", label: 'Noto Sans Arabic', group: 'Arabic Optimized', arabicSupport: true, rtl: true },
  { value: "'Amiri', serif", label: 'Amiri', group: 'Arabic Optimized', arabicSupport: true, rtl: true },
  { value: "'Cairo', sans-serif", label: 'Cairo', group: 'Arabic Optimized', arabicSupport: true, rtl: true },

  // Standard sans-serif fonts
  { value: "'Poppins', sans-serif", label: 'Poppins', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Inter', sans-serif", label: 'Inter', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Roboto', sans-serif", label: 'Roboto', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Montserrat', sans-serif", label: 'Montserrat', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: true },
  { value: "'Arial', sans-serif", label: 'Arial', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Helvetica', sans-serif", label: 'Helvetica', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Tahoma', sans-serif", label: 'Tahoma', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Verdana', sans-serif", label: 'Verdana', group: 'Sans-serif', koreanSupport: false, vietnameseSupport: false },

  // Serif fonts
  { value: "'Georgia', serif", label: 'Georgia', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Times New Roman', serif", label: 'Times New Roman', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Playfair Display', serif", label: 'Playfair Display', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Cormorant Garamond', serif", label: 'Cormorant Garamond', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Merriweather', serif", label: 'Merriweather', group: 'Serif', koreanSupport: false, vietnameseSupport: false },
  { value: "'Lora', serif", label: 'Lora', group: 'Serif', koreanSupport: false, vietnameseSupport: false },

  // Monospace fonts
  { value: "'Nanum Gothic Coding', monospace", label: 'Nanum Gothic Coding', group: 'Monospace', koreanSupport: true, vietnameseSupport: false },
  { value: "'JetBrains Mono', monospace", label: 'JetBrains Mono', group: 'Monospace', koreanSupport: false, vietnameseSupport: false },
  { value: "'Courier New', monospace", label: 'Courier New', group: 'Monospace', koreanSupport: false, vietnameseSupport: false },
  { value: "'Fira Code', monospace", label: 'Fira Code', group: 'Monospace', koreanSupport: false, vietnameseSupport: false },

  // Display fonts
  { value: "'Impact', sans-serif", label: 'Impact', group: 'Display', koreanSupport: false, vietnameseSupport: false },
  { value: "'Orbitron', sans-serif", label: 'Orbitron', group: 'Display', koreanSupport: false, vietnameseSupport: false },
  { value: "'Oswald', sans-serif", label: 'Oswald', group: 'Display', koreanSupport: false, vietnameseSupport: false },
  { value: "'Bebas Neue', sans-serif", label: 'Bebas Neue', group: 'Display', koreanSupport: false, vietnameseSupport: false },
  { value: "'Anton', sans-serif", label: 'Anton', group: 'Display', koreanSupport: false, vietnameseSupport: false },
  { value: "'Audiowide', cursive", label: 'Audiowide', group: 'Display', koreanSupport: false, vietnameseSupport: false },

  // Creative & Artistic fonts
  { value: "'Creepster', cursive", label: 'Creepster', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Nosifer', cursive", label: 'Nosifer', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Bungee', cursive", label: 'Bungee', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Fredoka One', cursive", label: 'Fredoka One', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Kalam', cursive", label: 'Kalam', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Bangers', cursive", label: 'Bangers', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Righteous', cursive", label: 'Righteous', group: 'Creative', koreanSupport: false, vietnameseSupport: false },
  { value: "'Comic Sans MS', cursive", label: 'Comic Sans MS', group: 'Creative', koreanSupport: false, vietnameseSupport: false },

  // Elegant & Luxury fonts
  { value: "'Cinzel', serif", label: 'Cinzel', group: 'Elegant', koreanSupport: false, vietnameseSupport: false },
  { value: "'Crimson Text', serif", label: 'Crimson Text', group: 'Elegant', koreanSupport: false, vietnameseSupport: false },
  { value: "'Libre Baskerville', serif", label: 'Libre Baskerville', group: 'Elegant', koreanSupport: false, vietnameseSupport: false },

  // Gaming & Tech fonts
  { value: "'Press Start 2P', cursive", label: 'Press Start 2P', group: 'Gaming', koreanSupport: false, vietnameseSupport: false },
  { value: "'VT323', monospace", label: 'VT323', group: 'Gaming', koreanSupport: false, vietnameseSupport: false },
  { value: "'Share Tech Mono', monospace", label: 'Share Tech Mono', group: 'Gaming', koreanSupport: false, vietnameseSupport: false },

  // Cute & Kawaii fonts
  { value: "'Nunito', sans-serif", label: 'Nunito', group: 'Cute', koreanSupport: false, vietnameseSupport: false },
  { value: "'Quicksand', sans-serif", label: 'Quicksand', group: 'Cute', koreanSupport: false, vietnameseSupport: false },
  { value: "'Comfortaa', cursive", label: 'Comfortaa', group: 'Cute', koreanSupport: false, vietnameseSupport: false },

  // Popular Video Editing Fonts (from CapCut, Adobe, DaVinci research)
  { value: "'Futura', sans-serif", label: 'Futura', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Calibri', sans-serif", label: 'Calibri', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Lato', sans-serif", label: 'Lato', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Ubuntu', sans-serif", label: 'Ubuntu', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Raleway', sans-serif", label: 'Raleway', group: 'Professional', koreanSupport: false, vietnameseSupport: true },
  { value: "'Dosis', sans-serif", label: 'Dosis', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Cabin', sans-serif", label: 'Cabin', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'PT Sans', sans-serif", label: 'PT Sans', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Exo', sans-serif", label: 'Exo', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Rajdhani', sans-serif", label: 'Rajdhani', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Signika', sans-serif", label: 'Signika', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Rubik', sans-serif", label: 'Rubik', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Work Sans', sans-serif", label: 'Work Sans', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Fira Sans', sans-serif", label: 'Fira Sans', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Barlow', sans-serif", label: 'Barlow', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Karla', sans-serif", label: 'Karla', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Mukti', sans-serif", label: 'Mukti', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Niramit', sans-serif", label: 'Niramit', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Sarala', sans-serif", label: 'Sarala', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Teko', sans-serif", label: 'Teko', group: 'Professional', koreanSupport: false, vietnameseSupport: false },
  { value: "'Viga', sans-serif", label: 'Viga', group: 'Professional', koreanSupport: false, vietnameseSupport: false },

  // Trending & Unique Fonts (2024-2025 popular)
  { value: "'Gotham', sans-serif", label: 'Gotham', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Harriet Display', serif", label: 'Harriet Display', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Doctor Glitch', cursive", label: 'Doctor Glitch', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Azonix', cursive", label: 'Azonix', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Maximum Impact', cursive", label: 'Maximum Impact', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Episode 1', cursive", label: 'Episode 1', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Dollamin', cursive", label: 'Dollamin', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Jomhuria', cursive", label: 'Jomhuria', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Shrikhand', cursive", label: 'Shrikhand', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Montages Retro', cursive", label: 'Montages Retro', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Moenstories', serif", label: 'Moenstories', group: 'Trending', koreanSupport: false, vietnameseSupport: false },
  { value: "'Peacock Showier', cursive", label: 'Peacock Showier', group: 'Trending', koreanSupport: false, vietnameseSupport: false },

  // Modern & Contemporary Fonts
  { value: "'Spectral', serif", label: 'Spectral', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Crimson Pro', serif", label: 'Crimson Pro', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Space Grotesk', sans-serif", label: 'Space Grotesk', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'DM Sans', sans-serif", label: 'DM Sans', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Manrope', sans-serif", label: 'Manrope', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Epilogue', sans-serif", label: 'Epilogue', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Figtree', sans-serif", label: 'Figtree', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Lexend Deca', sans-serif", label: 'Lexend Deca', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Readex Pro', sans-serif", label: 'Readex Pro', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Outfit', sans-serif", label: 'Outfit', group: 'Modern', koreanSupport: false, vietnameseSupport: false },
  { value: "'Plus Jakarta Sans', sans-serif", label: 'Plus Jakarta Sans', group: 'Modern', koreanSupport: false, vietnameseSupport: false }
];

// Animation types - now using translation keys
export const getAnimationTypes = (t) => [
  { value: 'fade', label: t('videoRendering.fade', 'Fade In/Out') },
  { value: 'slide-up', label: t('videoRendering.slideUp', 'Slide Up') },
  { value: 'slide-down', label: t('videoRendering.slideDown', 'Slide Down') },
  { value: 'slide-left', label: t('videoRendering.slideLeft', 'Slide Left') },
  { value: 'slide-right', label: t('videoRendering.slideRight', 'Slide Right') },
  { value: 'scale', label: t('videoRendering.scale', 'Scale') },
  { value: 'typewriter', label: t('videoRendering.typewriter', 'Typewriter') },
  { value: 'bounce', label: t('videoRendering.bounceIn', 'Bounce') },
  { value: 'flip', label: t('videoRendering.flip', 'Flip') },
  { value: 'rotate', label: t('videoRendering.rotateIn', 'Rotate') }
];

// Keep the old export for backward compatibility
export const animationTypes = [
  { value: 'fade', label: 'Fade In/Out' },
  { value: 'slide-up', label: 'Slide Up' },
  { value: 'slide-down', label: 'Slide Down' },
  { value: 'slide-left', label: 'Slide Left' },
  { value: 'slide-right', label: 'Slide Right' },
  { value: 'scale', label: 'Scale' },
  { value: 'typewriter', label: 'Typewriter' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'flip', label: 'Flip' },
  { value: 'rotate', label: 'Rotate' }
];

// Animation easing options - now using translation keys
export const getAnimationEasing = (t) => [
  { value: 'linear', label: t('videoRendering.linear', 'Linear') },
  { value: 'ease', label: t('videoRendering.ease', 'Ease') },
  { value: 'ease-in', label: t('videoRendering.easeIn', 'Ease In') },
  { value: 'ease-out', label: t('videoRendering.easeOut', 'Ease Out') },
  { value: 'ease-in-out', label: t('videoRendering.easeInOut', 'Ease In Out') },
  { value: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', label: t('videoRendering.smooth', 'Smooth') },
  { value: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)', label: t('videoRendering.bounceEasing', 'Bounce') }
];

// Keep the old export for backward compatibility
export const animationEasing = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease', label: 'Ease' },
  { value: 'ease-in', label: 'Ease In' },
  { value: 'ease-out', label: 'Ease Out' },
  { value: 'ease-in-out', label: 'Ease In Out' },
  { value: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', label: 'Smooth' },
  { value: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)', label: 'Bounce' }
];

// Font weight options - now using translation keys
export const getFontWeightOptions = (t) => [
  { value: 100, label: t('videoRendering.thin', 'Thin') },
  { value: 200, label: t('videoRendering.extraLight', 'Extra Light') },
  { value: 300, label: t('videoRendering.light', 'Light') },
  { value: 400, label: t('videoRendering.normal', 'Normal') },
  { value: 500, label: t('videoRendering.medium', 'Medium') },
  { value: 600, label: t('videoRendering.semiBold', 'Semi Bold') },
  { value: 700, label: t('videoRendering.bold', 'Bold') },
  { value: 800, label: t('videoRendering.extraBold', 'Extra Bold') },
  { value: 900, label: t('videoRendering.black', 'Black') }
];

// Keep the old export for backward compatibility
export const fontWeightOptions = [
  { value: 100, label: 'Thin' },
  { value: 200, label: 'Extra Light' },
  { value: 300, label: 'Light' },
  { value: 400, label: 'Normal' },
  { value: 500, label: 'Medium' },
  { value: 600, label: 'Semi Bold' },
  { value: 700, label: 'Bold' },
  { value: 800, label: 'Extra Bold' },
  { value: 900, label: 'Black' }
];

// Text alignment options - now using translation keys
export const getTextAlignOptions = (t) => [
  { value: 'left', label: t('videoRendering.left', 'Left') },
  { value: 'center', label: t('videoRendering.center', 'Center') },
  { value: 'right', label: t('videoRendering.right', 'Right') },
  { value: 'justify', label: t('videoRendering.justify', 'Justify') }
];

// Text transform options - now using translation keys
export const getTextTransformOptions = (t) => [
  { value: 'none', label: t('videoRendering.none', 'None') },
  { value: 'uppercase', label: t('videoRendering.uppercase', 'UPPERCASE') },
  { value: 'lowercase', label: t('videoRendering.lowercase', 'lowercase') },
  { value: 'capitalize', label: t('videoRendering.capitalize', 'Capitalize') }
];

// Border style options - now using translation keys
export const getBorderStyleOptions = (t) => [
  { value: 'none', label: t('videoRendering.none', 'None') },
  { value: 'solid', label: t('videoRendering.solid', 'Solid') },
  { value: 'dashed', label: t('videoRendering.dashed', 'Dashed') },
  { value: 'dotted', label: t('videoRendering.dotted', 'Dotted') },
  { value: 'double', label: t('videoRendering.double', 'Double') }
];

// Position options - now using translation keys
export const getPositionOptions = (t) => [
  { value: 'bottom', label: t('videoRendering.bottom', 'Bottom') },
  { value: 'top', label: t('videoRendering.top', 'Top') },
  { value: 'center', label: t('videoRendering.center', 'Center') },
  { value: 'custom', label: t('videoRendering.custom', 'Custom') }
];

// Keep the old exports for backward compatibility
export const textAlignOptions = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' }
];

export const textTransformOptions = [
  { value: 'none', label: 'None' },
  { value: 'uppercase', label: 'UPPERCASE' },
  { value: 'lowercase', label: 'lowercase' },
  { value: 'capitalize', label: 'Capitalize' }
];

export const borderStyleOptions = [
  { value: 'none', label: 'None' },
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'double', label: 'Double' }
];

export const positionOptions = [
  { value: 'bottom', label: 'Bottom' },
  { value: 'top', label: 'Top' },
  { value: 'center', label: 'Center' },
  { value: 'custom', label: 'Custom' }
];

/**
 * Group fonts by category
 * @param {Array} fonts - Array of font options
 * @returns {Object} - Grouped fonts by category
 */
export const groupFontsByCategory = (fonts = fontOptions) => {
  return fonts.reduce((groups, font) => {
    if (!groups[font.group]) {
      groups[font.group] = [];
    }
    groups[font.group].push(font);
    return groups;
  }, {});
};

/**
 * Get font support flags for display
 * @param {Object} font - Font object
 * @returns {Array} - Support flags as array of JSX elements
 */
export const getFontSupportFlags = (font) => {
  const flags = [];
  if (font.koreanSupport) flags.push(<span key="kr">🇰🇷</span>);
  if (font.vietnameseSupport) flags.push(<span key="vn">🇻🇳</span>);
  if (font.chineseSupport) flags.push(<span key="cn">🇨🇳</span>);
  if (font.japaneseSupport) flags.push(<span key="jp">🇯🇵</span>);
  if (font.arabicSupport) flags.push(<span key="sa">🇸🇦</span>);
  if (font.rtl) flags.push(<span key="rtl" className="material-symbols-rounded">format_textdirection_r_to_l</span>);
  return flags;
};

/**
 * Get sample text for a font based on its language support
 * @param {Object} font - Font object
 * @returns {String} - Sample text in appropriate language
 */
export const getFontSampleText = (font) => {
  // Korean optimized fonts
  if (font.koreanSupport && font.group === 'Korean Optimized') {
    return '한글 샘플 텍스트';
  }

  // Vietnamese optimized fonts
  if (font.vietnameseSupport && font.group === 'Vietnamese Optimized') {
    return 'Văn bản tiếng Việt';
  }

  // Chinese optimized fonts
  if (font.chineseSupport) {
    return font.label.includes('Simplified') ? '简体中文样本' : '繁體中文樣本';
  }

  // Japanese optimized fonts
  if (font.japaneseSupport) {
    return '日本語サンプル';
  }

  // Arabic optimized fonts
  if (font.arabicSupport) {
    return 'نص عربي نموذجي';
  }

  // Multilingual fonts - show mixed text
  if (font.group === 'Multilingual') {
    if (font.koreanSupport && font.vietnameseSupport) {
      return 'Sample • 샘플 • Mẫu';
    } else if (font.koreanSupport) {
      return 'Sample • 샘플';
    } else if (font.vietnameseSupport) {
      return 'Sample • Mẫu';
    }
  }

  // Display fonts - show stylized text
  if (font.group === 'Display') {
    return 'DISPLAY FONT';
  }

  // Monospace fonts
  if (font.group === 'Monospace') {
    return 'Code Sample';
  }

  // Serif fonts
  if (font.group === 'Serif') {
    return 'Elegant Text';
  }

  // Default for sans-serif and others
  return 'Sample Text';
};

/**
 * Get recommended fonts for a specific language
 * @param {String} language - Language code (ko, vi, zh, ja, ar, etc.)
 * @returns {Array} - Recommended fonts for the language
 */
export const getRecommendedFonts = (language) => {
  const languageMap = {
    ko: fontOptions.filter(f => f.koreanSupport),
    vi: fontOptions.filter(f => f.vietnameseSupport),
    zh: fontOptions.filter(f => f.chineseSupport),
    ja: fontOptions.filter(f => f.japaneseSupport),
    ar: fontOptions.filter(f => f.arabicSupport),
    en: fontOptions.filter(f => f.group === 'Sans-serif' || f.group === 'Serif')
  };

  return languageMap[language] || fontOptions.filter(f => f.group === 'Multilingual');
};
