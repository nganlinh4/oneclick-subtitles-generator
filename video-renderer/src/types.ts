export interface SubtitleEntry {
  start: number;
  end: number;
  text: string;
}

// Keep LyricEntry as alias for backward compatibility
export type LyricEntry = SubtitleEntry;

export type Resolution = '360p' | '480p' | '720p' | '1080p' | '1440p' | '4K' | '8K';
export type FrameRate = 24 | 25 | 30 | 50 | 60 | 120;

export interface VideoMetadata {
  videoType: 'Subtitled Video';
  resolution: Resolution; // Video resolution (1080p, 1440p, 4K, etc.)
  frameRate: FrameRate; // Frame rate (30 or 60 fps)
  originalAudioVolume: number; // Volume for original audio/video (0-100)
  narrationVolume: number; // Volume for narration audio (0-100)
  subtitleCustomization?: SubtitleCustomization; // Subtitle styling options
  cropSettings?: CropSettings; // Video crop settings
}

// Crop settings interface
export interface CropSettings {
  x: number; // X position as percentage (0-100)
  y: number; // Y position as percentage (0-100)
  width: number; // Width as percentage (0-100)
  height: number; // Height as percentage (0-100)
  aspectRatio: number | null; // Aspect ratio value or null for custom
}

// Subtitle customization interface
export interface SubtitleCustomization {
  // Text Styling
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  textColor: string;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  letterSpacing: number;
  textTransform: 'none' | 'uppercase' | 'lowercase' | 'capitalize';

  // Background & Border
  backgroundColor: string;
  backgroundOpacity: number;
  borderRadius: number;
  borderWidth: number;
  borderColor: string;
  borderStyle: 'none' | 'solid' | 'dashed' | 'dotted';

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
  animationEasing: 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';

  // Advanced
  wordWrap: boolean;
  maxLines: number;
  lineBreakBehavior: 'auto' | 'manual';
  rtlSupport: boolean;

  // Preset Styles
  preset: 'default' | 'modern' | 'classic' | 'neon' | 'minimal' | 'gaming' | 'cinematic' | 'gradient' | 'retro' | 'elegant' | 'custom';
}

export interface AudioFiles {
  main: File | null; // Original video audio
  narration?: File | null; // Narration audio track
}

export interface Props {
  audioUrl: string; // Original video audio
  narrationUrl?: string; // Narration audio
  lyrics: LyricEntry[]; // Subtitles
  backgroundImageUrl?: string; // Optional background image
  metadata: VideoMetadata;
  isVideoFile?: boolean; // Flag to indicate if the main file is a video
}

// Interface for components that can work with either a File or URL
export interface AudioProps {
  audioFile?: File; // Original video audio
  narrationFile?: File; // Narration audio
  audioUrl?: string;
  narrationUrl?: string;
  lyrics: LyricEntry[];
  backgroundImageUrl?: string;
}


