import type { SubtitleAnimationEasing } from './subtitleAnimationEasing';

// Subtitle customization interface
export interface SubtitleCustomization {
  // Text Styling
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  textColor: string;
  textAlign: 'left' | 'center' | 'right' | 'justify';
  lineHeight: number;
  letterSpacing: number;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Background & Border
  backgroundColor: string;
  backgroundOpacity: number;
  backgroundPaddingX: number;
  backgroundPaddingY: number;
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  borderStyle: 'none' | 'solid' | 'dashed' | 'dotted' | 'double';

  // Shadow & Effects
  textShadowEnabled: boolean;
  textShadowColor: string;
  textShadowBlur: number;
  textShadowOffsetX: number;
  textShadowOffsetY: number;
  glowEnabled: boolean;
  glowColor: string;
  glowIntensity: number;

  // Advanced gradient effects
  gradientEnabled: boolean;
  gradientType: 'linear' | 'radial';
  gradientDirection: string;
  gradientColorStart: string;
  gradientColorEnd: string;
  gradientColorMid: string;

  // Advanced text effects
  strokeEnabled: boolean;
  strokeWidth: number;
  strokeColor: string;
  multiShadowEnabled: boolean;
  shadowLayers: number;

  // Kinetic effects
  pulseEnabled: boolean;
  pulseSpeed: number;
  shakeEnabled: boolean;
  shakeIntensity: number;

  // Positioning
  position: 'bottom' | 'top' | 'center' | 'custom';
  customPositionX: number; // percentage
  customPositionY: number; // percentage
  marginBottom: number;
  marginTop: number;
  marginLeft: number;
  marginRight: number;
  maxWidth: number; // percentage

  // Animation & Timing
  fadeInDuration: number;
  fadeOutDuration: number;
  animationType: 'fade' | 'slide-up' | 'slide-down' | 'slide-left' | 'slide-right' | 'scale' | 'bounce' | 'flip' | 'rotate' | 'typewriter';
  animationEasing: SubtitleAnimationEasing;

  // Advanced
  wordWrap: boolean;
  maxLines: number;
  lineBreakBehavior: 'auto' | 'manual';
  rtlSupport: boolean;

  // Preset Styles
  // Native validation accepts any non-empty, bounded, control-free preset identity.
  preset: string;
}


