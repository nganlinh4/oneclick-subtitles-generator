import React, { useMemo, memo } from 'react';
import { AbsoluteFill, useCurrentFrame, Audio, Video, OffthreadVideo, useVideoConfig, Img } from 'remotion';
import { LyricEntry, VideoMetadata } from '../types';
import { ThemeProvider } from 'styled-components';
import { defaultCustomization } from './SubtitleCustomization';

// Dynamic font loading - only load fonts that are actually selected
const fontUrlMap: Record<string, string> = {
  // Korean fonts
  'Noto Sans KR': 'https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;700&display=swap',
  'Nanum Gothic': 'https://fonts.googleapis.com/css2?family=Nanum+Gothic:wght@400;700;800&display=swap',
  'Nanum Myeongjo': 'https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700&display=swap',
  'Nanum Barun Gothic': 'https://fonts.googleapis.com/css2?family=Nanum+Barun+Gothic&display=swap',
  'Spoqa Han Sans': 'https://fonts.googleapis.com/css2?family=Spoqa+Han+Sans:wght@400;500;700&display=swap',
  'KoPub Batang': 'https://fonts.googleapis.com/css2?family=KoPub+Batang&display=swap',
  'Gowun Dodum': 'https://fonts.googleapis.com/css2?family=Gowun+Dodum&display=swap',
  'Nanum Gothic Coding': 'https://fonts.googleapis.com/css2?family=Nanum+Gothic+Coding&display=swap',

  // Vietnamese fonts
  'Google Sans': 'https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap',
  'Noto Sans Vietnamese': 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600&display=swap',
  'Be Vietnam Pro': 'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600&display=swap',
  'Sarabun': 'https://fonts.googleapis.com/css2?family=Sarabun:wght@400;500;600&display=swap',
  'Montserrat Alternates': 'https://fonts.googleapis.com/css2?family=Montserrat+Alternates:wght@400;500;600&display=swap',
  'Josefin Sans': 'https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;500;600&display=swap',
  'Lexend': 'https://fonts.googleapis.com/css2?family=Lexend:wght@400;500;600&display=swap',

  // Multilingual fonts
  'Open Sans': 'https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap',
  'Noto Sans': 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;700&display=swap',
  'Noto Serif': 'https://fonts.googleapis.com/css2?family=Noto+Serif:wght@400;700&display=swap',
  'Arial Unicode MS': 'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400&display=swap',
  'Source Sans Pro': 'https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@400;600&display=swap',

  // Standard fonts
  'Poppins': 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap',
  'Inter': 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'Roboto': 'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap',
  'Montserrat': 'https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&display=swap',

  // Serif fonts
  'Georgia': 'https://fonts.googleapis.com/css2?family=Georgia&display=swap',
  'Times New Roman': 'https://fonts.googleapis.com/css2?family=Times+New+Roman&display=swap',
  'Playfair Display': 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&display=swap',
  'Cormorant Garamond': 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&display=swap',
  'Merriweather': 'https://fonts.googleapis.com/css2?family=Merriweather:wght@400;700&display=swap',
  'Lora': 'https://fonts.googleapis.com/css2?family=Lora:wght@400;700&display=swap',
  'Cinzel': 'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&display=swap',
  'Crimson Text': 'https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600&display=swap',
  'Libre Baskerville': 'https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&display=swap',

  // Monospace fonts
  'JetBrains Mono': 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap',
  'Courier New': 'https://fonts.googleapis.com/css2?family=Courier+Prime&display=swap',
  'Fira Code': 'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&display=swap',
  'Share Tech Mono': 'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap',

  // Display fonts
  'Impact': 'https://fonts.googleapis.com/css2?family=Impact&display=swap',
  'Orbitron': 'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700&display=swap',
  'Oswald': 'https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap',
  'Bebas Neue': 'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
  'Anton': 'https://fonts.googleapis.com/css2?family=Anton&display=swap',
  'Audiowide': 'https://fonts.googleapis.com/css2?family=Audiowide&display=swap',

  // Creative fonts
  'Creepster': 'https://fonts.googleapis.com/css2?family=Creepster&display=swap',
  'Nosifer': 'https://fonts.googleapis.com/css2?family=Nosifer&display=swap',
  'Bungee': 'https://fonts.googleapis.com/css2?family=Bungee&display=swap',
  'Fredoka One': 'https://fonts.googleapis.com/css2?family=Fredoka+One&display=swap',
  'Kalam': 'https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&display=swap',
  'Bangers': 'https://fonts.googleapis.com/css2?family=Bangers&display=swap',
  'Righteous': 'https://fonts.googleapis.com/css2?family=Righteous&display=swap',
  'Comic Sans MS': 'https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&display=swap',

  // Cute fonts
  'Nunito': 'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap',
  'Quicksand': 'https://fonts.googleapis.com/css2?family=Quicksand:wght@400;500;600;700&display=swap',
  'Comfortaa': 'https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;500;600;700&display=swap',

  // Gaming fonts
  'Press Start 2P': 'https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap',
  'VT323': 'https://fonts.googleapis.com/css2?family=VT323&display=swap',

  // Chinese fonts
  'Noto Sans SC': 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&display=swap',
  'Noto Sans TC': 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap',
  'Source Han Sans': 'https://fonts.googleapis.com/css2?family=Source+Han+Sans:wght@400;500;700&display=swap',
  'PingFang SC': 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400&display=swap',

  // Japanese fonts
  'Noto Sans JP': 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap',
  'Hiragino Sans': 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400&display=swap',
  'Yu Gothic': 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400&display=swap',

  // Arabic fonts
  'Noto Sans Arabic': 'https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@400;500;700&display=swap',
  'Amiri': 'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&display=swap',
  'Cairo': 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700&display=swap',

  // Popular Video Editing Fonts
  'Futura': 'https://fonts.googleapis.com/css2?family=Futura:wght@400;500;600;700&display=swap',
  'Calibri': 'https://fonts.googleapis.com/css2?family=Carlito:wght@400;700&display=swap',
  'Lato': 'https://fonts.googleapis.com/css2?family=Lato:wght@300;400;700;900&display=swap',
  'Ubuntu': 'https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&display=swap',
  'Raleway': 'https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700&display=swap',
  'Dosis': 'https://fonts.googleapis.com/css2?family=Dosis:wght@400;500;600;700&display=swap',
  'Cabin': 'https://fonts.googleapis.com/css2?family=Cabin:wght@400;500;600;700&display=swap',
  'PT Sans': 'https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&display=swap',
  'Exo': 'https://fonts.googleapis.com/css2?family=Exo:wght@400;500;600;700&display=swap',
  'Rajdhani': 'https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap',
  'Signika': 'https://fonts.googleapis.com/css2?family=Signika:wght@400;500;600;700&display=swap',
  'Rubik': 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap',
  'Work Sans': 'https://fonts.googleapis.com/css2?family=Work+Sans:wght@400;500;600;700&display=swap',
  'Fira Sans': 'https://fonts.googleapis.com/css2?family=Fira+Sans:wght@400;500;600;700&display=swap',
  'Barlow': 'https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap',
  'Karla': 'https://fonts.googleapis.com/css2?family=Karla:wght@400;500;600;700&display=swap',
  'Mukti': 'https://fonts.googleapis.com/css2?family=Mukti:wght@400;500;600;700&display=swap',
  'Niramit': 'https://fonts.googleapis.com/css2?family=Niramit:wght@400;500;600;700&display=swap',
  'Sarala': 'https://fonts.googleapis.com/css2?family=Sarala:wght@400;700&display=swap',
  'Teko': 'https://fonts.googleapis.com/css2?family=Teko:wght@400;500;600;700&display=swap',
  'Viga': 'https://fonts.googleapis.com/css2?family=Viga&display=swap',

  // Trending & Unique Fonts
  'Gotham': 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'Harriet Display': 'https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600&display=swap',
  'Doctor Glitch': 'https://fonts.googleapis.com/css2?family=Righteous&display=swap',
  'Azonix': 'https://fonts.googleapis.com/css2?family=Audiowide&display=swap',
  'Maximum Impact': 'https://fonts.googleapis.com/css2?family=Bungee&display=swap',
  'Episode 1': 'https://fonts.googleapis.com/css2?family=Creepster&display=swap',
  'Dollamin': 'https://fonts.googleapis.com/css2?family=Fredoka+One&display=swap',
  'Jomhuria': 'https://fonts.googleapis.com/css2?family=Jomhuria&display=swap',
  'Shrikhand': 'https://fonts.googleapis.com/css2?family=Shrikhand&display=swap',
  'Montages Retro': 'https://fonts.googleapis.com/css2?family=Righteous&display=swap',
  'Moenstories': 'https://fonts.googleapis.com/css2?family=Crimson+Text:wght@400;600&display=swap',
  'Peacock Showier': 'https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&display=swap',

  // Modern & Contemporary Fonts
  'Spectral': 'https://fonts.googleapis.com/css2?family=Spectral:wght@400;500;600;700&display=swap',
  'Crimson Pro': 'https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;500;600;700&display=swap',
  'Space Grotesk': 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap',
  'DM Sans': 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap',
  'Manrope': 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap',
  'Epilogue': 'https://fonts.googleapis.com/css2?family=Epilogue:wght@400;500;600;700&display=swap',
  'Figtree': 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap',
  'Lexend Deca': 'https://fonts.googleapis.com/css2?family=Lexend+Deca:wght@400;500;600;700&display=swap',
  'Readex Pro': 'https://fonts.googleapis.com/css2?family=Readex+Pro:wght@400;500;600;700&display=swap',
  'Outfit': 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap',
  'Plus Jakarta Sans': 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap'
};

// Function to extract font family name from CSS font-family string
const extractFontName = (fontFamily: string): string => {
  // Remove quotes and extract the first font name
  const cleanFont = fontFamily.replace(/['"]/g, '').split(',')[0].trim();
  return cleanFont;
};

// Generate font styles based on selected font
const generateFontStyles = (fontFamily: string): string => {
  const fontName = extractFontName(fontFamily);
  const fontUrl = fontUrlMap[fontName];

  if (fontUrl) {
    return `@import url('${fontUrl}');`;
  }

  // Font not found in static map - return empty string
  return '';
};

export interface Props {
  audioUrl: string; // Original video/audio file
  narrationUrl?: string; // Narration audio
  lyrics: LyricEntry[]; // Subtitles
  backgroundImageUrl?: string; // Optional background image
  metadata: VideoMetadata;
  isVideoFile?: boolean; // Flag to indicate if the main file is a video
  framesPathUrl?: string; // When provided, use server-extracted frames as background
  extractedAudioUrl?: string; // When using frames, play extracted audio
}

export const SubtitledVideoContent: React.FC<Props> = ({
  audioUrl,
  narrationUrl,
  lyrics,
  backgroundImageUrl,
  metadata,
  isVideoFile = false,
  framesPathUrl,
  extractedAudioUrl
}) => {
  const frame = useCurrentFrame();
  const { fps, height: compositionHeight } = useVideoConfig();
  const currentTimeInSeconds = frame / fps;

  // Create a scaling function that uses actual composition dimensions
  const getResponsiveScaledValue = (value: number): number => {
    const baseHeight = 1080; // Reference height (1080p)
    const scale = compositionHeight / baseHeight;
    return Math.round(value * scale);
  };

  // Memoize expensive calculations to improve performance
  const getConsistentRelativePosition = useMemo(() =>
    (pixelValue: number, dimension: 'width' | 'height'): string => {
      // Always calculate percentage based on 1080p reference dimensions
      const referenceDimension = dimension === 'width' ? 1920 : 1080;
      const percentage = (pixelValue / referenceDimension) * 100;
      return `${percentage.toFixed(2)}%`;
    }, []
  );

  // Determine if we should show video or just audio with background
  const showVideo = isVideoFile;
  const useServerFrames = showVideo && Boolean(framesPathUrl);

  // Memoize customization settings
  const customization = useMemo(() =>
    metadata.subtitleCustomization || defaultCustomization,
    [metadata.subtitleCustomization]
  );

  // Generate dynamic font styles based on selected font
  const dynamicFontStyles = useMemo(() =>
    generateFontStyles(customization.fontFamily),
    [customization.fontFamily]
  );

  
    // Compute flip transforms from metadata so server-frame rendering matches frontend preview
    const flipXScale = (metadata?.cropSettings as any)?.flipX ? -1 : 1;
    const flipYScale = (metadata?.cropSettings as any)?.flipY ? -1 : 1;
    const videoFlipTransform = `scaleX(${flipXScale}) scaleY(${flipYScale})`;
  
    // Compute adjusted positioning for cropping, taking flips into account.
    const computeCropPosition = (cs: any, metadataFlag?: any) => {
      if (metadataFlag?.framesPreCropped) return {}; 
      if (!cs) return {};
      const isIdentity = cs.width === 100 && cs.height === 100 && cs.x === 0 && cs.y === 0;
      if (isIdentity) return {};
      const widthPct = `${(100 / cs.width) * 100}%`;
      const heightPct = `${(100 / cs.height) * 100}%`;
      const leftPct = cs.flipX
        ? `${(-(100 - (cs.x) - cs.width) / cs.width) * 100}%`
        : `${(-(cs.x / cs.width) * 100)}%`;
      const topPct = cs.flipY
        ? `${(-(100 - (cs.y) - cs.height) / cs.height) * 100}%`
        : `${(-(cs.y / cs.height) * 100)}%`;
      return { widthPct, heightPct, leftPct, topPct };
    };
    const cropPosition = computeCropPosition(metadata?.cropSettings as any, metadata);

  // Process subtitles based on line threshold
  const processedSubtitles = useMemo(() => {
    if (!lyrics) {
      return lyrics;
    }
    return lyrics.map(subtitle => {
      return subtitle;
    });
  }, [lyrics]);

  // Find the current active subtitle (only one at a time)
  const getCurrentSubtitle = (currentTime: number) => {
    const fadeInDuration = customization.fadeInDuration;
    const fadeOutDuration = customization.fadeOutDuration;

    const activeSubtitle = processedSubtitles?.find(subtitle =>
      currentTime >= subtitle.start - fadeInDuration &&
      currentTime <= subtitle.end + fadeOutDuration
    );

    if (!activeSubtitle) return null;

    let animationProgress = 1;
    let isAnimatingIn = false;
    let isAnimatingOut = false;

    if (currentTime < activeSubtitle.start) {
      animationProgress = (currentTime - (activeSubtitle.start - fadeInDuration)) / fadeInDuration;
      isAnimatingIn = true;
    } else if (currentTime > activeSubtitle.end) {
      animationProgress = 1 - (currentTime - activeSubtitle.end) / fadeOutDuration;
      isAnimatingOut = true;
    }

    const clampedProgress = Math.max(0, Math.min(1, animationProgress));

    return {
      ...activeSubtitle,
      opacity: clampedProgress,
      animationProgress: clampedProgress,
      isAnimatingIn,
      isAnimatingOut
    };
  };

  // Calculate animation transforms based on animation type
  const getAnimationTransform = (progress: number, isAnimatingIn: boolean, isAnimatingOut: boolean) => {
    const animationType = customization.animationType;
    const easing = customization.animationEasing;
    const easedProgress = applyEasing(progress, easing);

    switch (animationType) {
      case 'slide-up': if (isAnimatingIn) { const t = (1 - easedProgress) * 50; return `translateY(${t}px)`; } else if (isAnimatingOut) { const t = (1 - easedProgress) * -50; return `translateY(${t}px)`; } return 'translateY(0px)';
      case 'slide-down': if (isAnimatingIn) { const t = (1 - easedProgress) * -50; return `translateY(${t}px)`; } else if (isAnimatingOut) { const t = (1 - easedProgress) * 50; return `translateY(${t}px)`; } return 'translateY(0px)';
      case 'slide-left': if (isAnimatingIn) { const t = (1 - easedProgress) * 100; return `translateX(${t}px)`; } else if (isAnimatingOut) { const t = (1 - easedProgress) * -100; return `translateX(${t}px)`; } return 'translateX(0px)';
      case 'slide-right': if (isAnimatingIn) { const t = (1 - easedProgress) * -100; return `translateX(${t}px)`; } else if (isAnimatingOut) { const t = (1 - easedProgress) * 100; return `translateX(${t}px)`; } return 'translateX(0px)';
      case 'scale': if (isAnimatingIn || isAnimatingOut) { const s = 0.5 + (easedProgress * 0.5); return `scale(${s})`; } return 'scale(1)';
      case 'bounce': if (isAnimatingIn) { const s = 1 + Math.sin(easedProgress * Math.PI * 3) * 0.1 * (1 - easedProgress); return `scale(${s})`; } return 'scale(1)';
      case 'flip': if (isAnimatingIn) { const r = (1 - easedProgress) * 90; return `rotateY(${r}deg)`; } else if (isAnimatingOut) { const r = (1 - easedProgress) * -90; return `rotateY(${r}deg)`; } return 'rotateY(0deg)';
      case 'rotate': if (isAnimatingIn) { const r = (1 - easedProgress) * 180; return `rotate(${r}deg)`; } else if (isAnimatingOut) { const r = (1 - easedProgress) * -180; return `rotate(${r}deg)`; } return 'rotate(0deg)';
      default: return 'none';
    }
  };

  const applyEasing = (t: number, easing: string) => { switch (easing) { case 'ease-in': return t * t; case 'ease-out': return 1 - Math.pow(1 - t, 2); case 'ease-in-out': case 'ease': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; default: return t; } };
  const getTypewriterText = (text: string, progress: number, isAnimatingIn: boolean) => { if (customization.animationType !== 'typewriter' || !isAnimatingIn) { return text; } const targetLength = Math.floor(text.length * progress); return text.substring(0, targetLength); };

  return (
    <ThemeProvider theme={{ resolution: metadata.resolution, frameRate: metadata.frameRate }}>
      <style dangerouslySetInnerHTML={{ __html: dynamicFontStyles }} />
      <AbsoluteFill style={{ backgroundColor: '#000', overflow: 'hidden', position: 'relative' }}>
        {showVideo ? (
          <div style={{ width: '100%', height: '100%', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
            {metadata.cropSettings && ((metadata.cropSettings.canvasBgMode === 'solid' || metadata.cropSettings.canvasBgMode === 'blur' || metadata.cropSettings.width > 100 || metadata.cropSettings.height > 100 || metadata.cropSettings.x < 0 || metadata.cropSettings.y < 0 || (metadata.cropSettings.x + metadata.cropSettings.width) > 100 || (metadata.cropSettings.y + metadata.cropSettings.height) > 100)) && (
              <>
                {metadata.cropSettings.canvasBgMode === 'solid' && (<div style={{ position: 'absolute', inset: 0, backgroundColor: metadata.cropSettings.canvasBgColor || '#000' }} />)}
                {metadata.cropSettings.canvasBgMode === 'blur' && (useServerFrames ? (<Img src={`${framesPathUrl}/${String(frame + 1).padStart(6, '0')}.png`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: `blur(${(metadata.cropSettings?.canvasBgBlur ?? 24)}px) brightness(0.7)`, transform: `scale(1.06) ${videoFlipTransform}`, transformOrigin: 'center center' }} />) : (<OffthreadVideo src={audioUrl} volume={0} transparent={false} toneMapped={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: `blur(${(metadata.cropSettings?.canvasBgBlur ?? 24)}px) brightness(0.7)`, transform: `scale(1.06) ${videoFlipTransform}`, transformOrigin: 'center center' }} />))}
              </>
            )}

            {useServerFrames ? (
              <Img
                src={`${framesPathUrl}/${String(frame + 1).padStart(6, '0')}.png`}
                style={{
                  position: 'absolute',
                  ...(metadata.cropSettings && (metadata.cropSettings.width !== 100 || metadata.cropSettings.height !== 100 || metadata.cropSettings.x !== 0 || metadata.cropSettings.y !== 0)
                    ? {
                        width: cropPosition.widthPct,
                        height: cropPosition.heightPct,
                        left: cropPosition.leftPct,
                        top: cropPosition.topPct,
                        objectFit: 'cover', // FIX: 'cover' prevents stretching by preserving aspect ratio.
                      }
                    : {
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        objectFit: 'contain',
                      }
                  ),
                  backgroundColor: '#000',
                  transform: videoFlipTransform,
                  transformOrigin: 'center center'
                }}
              />
            ) : (
              <OffthreadVideo
                src={audioUrl}
                volume={(metadata.originalAudioVolume ?? 100) / 100}
                transparent={false}
                toneMapped={false}
                style={{
                  ...(metadata.cropSettings && (metadata.cropSettings.width !== 100 || metadata.cropSettings.height !== 100 || metadata.cropSettings.x !== 0 || metadata.cropSettings.y !== 0) ? {
                    position: 'absolute',
                    width: cropPosition.widthPct,
                    height: cropPosition.heightPct,
                    left: cropPosition.leftPct,
                    top: cropPosition.topPct,
                    objectFit: 'cover' // FIX: 'cover' prevents stretching by preserving aspect ratio.
                  } : {
                    width: '100%',
                    height: '100%',
                    objectFit: 'contain'
                  }),
                  transform: videoFlipTransform,
                  transformOrigin: 'center center'
                }}
              />
            )}
          </div>
        ) : (
          backgroundImageUrl && (<div style={{ position: 'absolute', inset: 0, backgroundImage: `linear-gradient(rgba(0,0,0,0.4), rgba(0,0,0,0.5)), url(${backgroundImageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />)
        )}

        <div style={{ position: 'absolute', ...(customization.position === 'bottom' && { bottom: getConsistentRelativePosition(customization.marginBottom, 'height') }), ...(customization.position === 'top' && { top: getConsistentRelativePosition(customization.marginTop, 'height') }), ...(customization.position === 'center' && { top: '50%', transform: 'translateY(-50%)' }), ...(customization.position === 'custom' && { left: `${customization.customPositionX}%`, top: `${customization.customPositionY}%`, transform: 'translate(-50%, -50%)' }), ...(customization.position !== 'custom' && { left: getConsistentRelativePosition(customization.marginLeft, 'width'), right: getConsistentRelativePosition(customization.marginRight, 'width') }), display: 'flex', flexDirection: 'column', alignItems: customization.textAlign === 'left' ? 'flex-start' : customization.textAlign === 'right' ? 'flex-end' : 'center', justifyContent: 'center', zIndex: 10 }}>
          {(() => {
            const currentSubtitle = getCurrentSubtitle(currentTimeInSeconds);
            if (!currentSubtitle || currentSubtitle.opacity <= 0) return null;
            const textShadow = customization.textShadowEnabled ? `${getResponsiveScaledValue(customization.textShadowOffsetX)}px ${getResponsiveScaledValue(customization.textShadowOffsetY)}px ${getResponsiveScaledValue(customization.textShadowBlur)}px ${customization.textShadowColor}` : 'none';
            const boxShadow = customization.glowEnabled ? `0 0 ${getResponsiveScaledValue(customization.glowIntensity)}px ${customization.glowColor}` : 'none';
            const backgroundColor = customization.backgroundOpacity > 0 ? `${customization.backgroundColor}${Math.round(customization.backgroundOpacity * 2.55).toString(16).padStart(2, '0')}` : 'transparent';
            const border = customization.borderWidth > 0 && customization.borderStyle !== 'none' ? `${getResponsiveScaledValue(customization.borderWidth)}px ${customization.borderStyle} ${customization.borderColor}` : 'none';
            const textStroke = customization.strokeEnabled ? `${getResponsiveScaledValue(customization.strokeWidth)}px ${customization.strokeColor}` : 'none';
            let textColor = customization.textColor;
            let backgroundImage = 'none';
            if (customization.gradientEnabled) { textColor = 'transparent'; backgroundImage = `linear-gradient(${customization.gradientDirection}, ${customization.gradientColorStart}, ${customization.gradientColorEnd})`; }
            const transform = getAnimationTransform(currentSubtitle.animationProgress, currentSubtitle.isAnimatingIn, currentSubtitle.isAnimatingOut);
            let displayText = currentSubtitle.text;
            if (customization.textTransform !== 'none') { switch (customization.textTransform) { case 'uppercase': displayText = displayText.toUpperCase(); break; case 'lowercase': displayText = displayText.toLowerCase(); break; case 'capitalize': displayText = displayText.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()); break; } }
            if (customization.animationType === 'typewriter') { displayText = getTypewriterText(displayText, currentSubtitle.animationProgress, currentSubtitle.isAnimatingIn); }
            return (<div style={{ opacity: currentSubtitle.opacity, transform: transform !== 'none' ? transform : undefined, fontSize: getResponsiveScaledValue(customization.fontSize), fontFamily: customization.fontFamily, fontWeight: customization.fontWeight, color: textColor, textAlign: customization.textAlign, lineHeight: customization.lineHeight, letterSpacing: getResponsiveScaledValue(customization.letterSpacing || 0), textShadow, backgroundColor, border, borderRadius: getResponsiveScaledValue(customization.borderRadius), padding: `${getResponsiveScaledValue(8)}px ${getResponsiveScaledValue(16)}px`, maxWidth: `${customization.maxWidth}%`, whiteSpace: customization.wordWrap ? 'pre-wrap' : 'nowrap', boxShadow, WebkitTextStroke: textStroke, backgroundImage: backgroundImage, WebkitBackgroundClip: customization.gradientEnabled ? 'text' : 'initial', backgroundClip: customization.gradientEnabled ? 'text' : 'initial', textTransform: customization.textTransform || 'none', direction: customization.rtlSupport ? 'rtl' : 'ltr', transformOrigin: 'center center' }}>{displayText}</div>);
          })()}
        </div>

        {useServerFrames && (<Audio src={(typeof extractedAudioUrl === 'string' && extractedAudioUrl) ? extractedAudioUrl : audioUrl} volume={(metadata.originalAudioVolume ?? 100) / 100} />)}
        {!useServerFrames && !showVideo && (<Audio src={audioUrl} volume={(metadata.originalAudioVolume ?? 100) / 100} />)}
        {narrationUrl && <Audio src={narrationUrl} volume={(metadata.narrationVolume ?? 100) / 100} />}
      </AbsoluteFill>
    </ThemeProvider>
  );
};

export default memo(SubtitledVideoContent);