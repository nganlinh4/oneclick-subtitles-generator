import React, { useMemo, memo } from 'react';
import { AbsoluteFill, useCurrentFrame, Audio, Video, OffthreadVideo, useVideoConfig } from 'remotion';
import { LyricEntry, VideoMetadata } from '../types';
import { ThemeProvider } from 'styled-components';
import { defaultCustomization } from './SubtitleCustomization';

// Optimized font loading - only load essential fonts to reduce component loading time
const fontStyles = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
`;







export interface Props {
  audioUrl: string; // Original video/audio file
  narrationUrl?: string; // Narration audio
  lyrics: LyricEntry[]; // Subtitles
  backgroundImageUrl?: string; // Optional background image
  metadata: VideoMetadata;
  isVideoFile?: boolean; // Flag to indicate if the main file is a video
}

export const SubtitledVideoContent: React.FC<Props> = ({
  audioUrl,
  narrationUrl,
  lyrics,
  backgroundImageUrl,
  metadata,
  isVideoFile = false
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


  // Memoize customization settings
  const customization = useMemo(() =>
    metadata.subtitleCustomization || defaultCustomization,
    [metadata.subtitleCustomization]
  );

  // Process subtitles based on line threshold
  const processedSubtitles = useMemo(() => {
    if (!lyrics) {
      return lyrics;
    }

    return lyrics.map(subtitle => {
      // Keep subtitles as they are - no need to split them
      return subtitle;
    });
  }, [lyrics]);



  // Find the current active subtitle (only one at a time)
  const getCurrentSubtitle = (currentTime: number) => {
    // Find the subtitle that should be displayed at the current time
    const fadeInDuration = customization.fadeInDuration;
    const fadeOutDuration = customization.fadeOutDuration;

    const activeSubtitle = processedSubtitles?.find(subtitle =>
      currentTime >= subtitle.start - fadeInDuration &&
      currentTime <= subtitle.end + fadeOutDuration
    );

    if (!activeSubtitle) return null;

    // Calculate animation progress
    let animationProgress = 1;
    let isAnimatingIn = false;
    let isAnimatingOut = false;

    if (currentTime < activeSubtitle.start) {
      // Fade in
      animationProgress = (currentTime - (activeSubtitle.start - fadeInDuration)) / fadeInDuration;
      isAnimatingIn = true;
    } else if (currentTime > activeSubtitle.end) {
      // Fade out
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

    // Apply easing function
    const easedProgress = applyEasing(progress, easing);

    switch (animationType) {
      case 'slide-up':
        if (isAnimatingIn) {
          const translateY = (1 - easedProgress) * 50; // Start 50px below
          return `translateY(${translateY}px)`;
        } else if (isAnimatingOut) {
          const translateY = (1 - easedProgress) * -50; // End 50px above
          return `translateY(${translateY}px)`;
        }
        return 'translateY(0px)';

      case 'slide-down':
        if (isAnimatingIn) {
          const translateY = (1 - easedProgress) * -50; // Start 50px above
          return `translateY(${translateY}px)`;
        } else if (isAnimatingOut) {
          const translateY = (1 - easedProgress) * 50; // End 50px below
          return `translateY(${translateY}px)`;
        }
        return 'translateY(0px)';

      case 'slide-left':
        if (isAnimatingIn) {
          const translateX = (1 - easedProgress) * 100; // Start 100px right
          return `translateX(${translateX}px)`;
        } else if (isAnimatingOut) {
          const translateX = (1 - easedProgress) * -100; // End 100px left
          return `translateX(${translateX}px)`;
        }
        return 'translateX(0px)';

      case 'slide-right':
        if (isAnimatingIn) {
          const translateX = (1 - easedProgress) * -100; // Start 100px left
          return `translateX(${translateX}px)`;
        } else if (isAnimatingOut) {
          const translateX = (1 - easedProgress) * 100; // End 100px right
          return `translateX(${translateX}px)`;
        }
        return 'translateX(0px)';

      case 'scale':
        if (isAnimatingIn) {
          const scale = 0.5 + (easedProgress * 0.5); // Start at 50% scale
          return `scale(${scale})`;
        } else if (isAnimatingOut) {
          const scale = 0.5 + (easedProgress * 0.5); // End at 50% scale
          return `scale(${scale})`;
        }
        return 'scale(1)';

      case 'bounce':
        if (isAnimatingIn) {
          const bounceScale = 1 + Math.sin(easedProgress * Math.PI * 3) * 0.1 * (1 - easedProgress);
          return `scale(${bounceScale})`;
        }
        return 'scale(1)';

      case 'flip':
        if (isAnimatingIn) {
          const rotateY = (1 - easedProgress) * 90; // Start rotated 90 degrees
          return `rotateY(${rotateY}deg)`;
        } else if (isAnimatingOut) {
          const rotateY = (1 - easedProgress) * -90; // End rotated -90 degrees
          return `rotateY(${rotateY}deg)`;
        }
        return 'rotateY(0deg)';

      case 'rotate':
        if (isAnimatingIn) {
          const rotate = (1 - easedProgress) * 180; // Start rotated 180 degrees
          return `rotate(${rotate}deg)`;
        } else if (isAnimatingOut) {
          const rotate = (1 - easedProgress) * -180; // End rotated -180 degrees
          return `rotate(${rotate}deg)`;
        }
        return 'rotate(0deg)';

      case 'typewriter':
        // For typewriter, we'll handle this differently in the text rendering
        return 'none';

      case 'fade':
      default:
        return 'none';
    }
  };

  // Apply easing functions
  const applyEasing = (t: number, easing: string) => {
    switch (easing) {
      case 'ease-in':
        return t * t;
      case 'ease-out':
        return 1 - Math.pow(1 - t, 2);
      case 'ease-in-out':
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      case 'ease':
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // Similar to ease-in-out
      case 'linear':
      default:
        return t;
    }
  };

  // Calculate typewriter effect text
  const getTypewriterText = (text: string, progress: number, isAnimatingIn: boolean) => {
    if (customization.animationType !== 'typewriter' || !isAnimatingIn) {
      return text;
    }

    const targetLength = Math.floor(text.length * progress);
    return text.substring(0, targetLength);
  };

  return (
    <ThemeProvider theme={{
      resolution: metadata.resolution,
      frameRate: metadata.frameRate
    }}>
      <style dangerouslySetInnerHTML={{ __html: fontStyles }} />
      <AbsoluteFill
        style={{
          backgroundColor: '#000',
          overflow: 'hidden',
          position: 'relative'
        }}
      >
        {/* Video background if uploaded file is a video */}
        {showVideo ? (
          <div style={{
            width: '100%',
            height: '100%',
            backgroundColor: '#000',
            position: 'relative',
            overflow: 'hidden'
          }}>
            {/* Canvas background when padding is detected */}
            {metadata.cropSettings && (
              (metadata.cropSettings.width > 100 || metadata.cropSettings.height > 100 || metadata.cropSettings.x < 0 || metadata.cropSettings.y < 0 ||
               (metadata.cropSettings.x + metadata.cropSettings.width) > 100 || (metadata.cropSettings.y + metadata.cropSettings.height) > 100)
            ) && (
              <>
                {metadata.cropSettings.canvasBgMode === 'solid' && (
                  <div style={{ position: 'absolute', inset: 0, backgroundColor: metadata.cropSettings.canvasBgColor || '#000' }} />
                )}
                {metadata.cropSettings.canvasBgMode === 'blur' && showVideo && (
                  <OffthreadVideo
                    src={audioUrl}
                    volume={0}
                    transparent={false}
                    toneMapped={false}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: `blur(${(metadata.cropSettings?.canvasBgBlur ?? 24)}px) brightness(0.7)`, transform: 'scale(1.06)' }}
                  />
                )}
              </>
            )}
            <OffthreadVideo
              src={audioUrl}
              volume={(metadata.originalAudioVolume ?? 100) / 100}
              transparent={false} // Use faster BMP extraction instead of PNG
              toneMapped={false} // Disable tone mapping for faster rendering
              style={{
                // When cropping, scale up the video and reposition
                ...(metadata.cropSettings && (metadata.cropSettings.width !== 100 || metadata.cropSettings.height !== 100 || metadata.cropSettings.x !== 0 || metadata.cropSettings.y !== 0) ? {
                  position: 'absolute',
                  width: `${(100 / metadata.cropSettings.width) * 100}%`,
                  height: `${(100 / metadata.cropSettings.height) * 100}%`,
                  left: `${-(metadata.cropSettings.x / metadata.cropSettings.width) * 100}%`,
                  top: `${-(metadata.cropSettings.y / metadata.cropSettings.height) * 100}%`,
                  objectFit: 'contain'
                } : {
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain'
                })
              }}
            />
          </div>
        ) : (
          /* Background image if provided and no video */
          backgroundImageUrl && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.4), rgba(0, 0, 0, 0.5)), url(${backgroundImageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }} />
          )
        )}

        {/* Subtitle container */}
        <div
          style={{
            position: 'absolute',
            ...(customization.position === 'bottom' && {
              bottom: getConsistentRelativePosition(customization.marginBottom, 'height')
            }),
            ...(customization.position === 'top' && {
              top: getConsistentRelativePosition(customization.marginTop, 'height')
            }),
            ...(customization.position === 'center' && {
              top: '50%',
              transform: 'translateY(-50%)'
            }),
            ...(customization.position === 'custom' && {
              left: `${customization.customPositionX}%`,
              top: `${customization.customPositionY}%`,
              transform: 'translate(-50%, -50%)'
            }),
            ...(customization.position !== 'custom' && {
              left: getConsistentRelativePosition(customization.marginLeft, 'width'),
              right: getConsistentRelativePosition(customization.marginRight, 'width')
            }),
            display: 'flex',
            flexDirection: 'column',
            alignItems: customization.textAlign === 'left' ? 'flex-start' :
                       customization.textAlign === 'right' ? 'flex-end' : 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          {(() => {
            const currentSubtitle = getCurrentSubtitle(currentTimeInSeconds);

            if (!currentSubtitle || currentSubtitle.opacity <= 0) return null;

            // Create dynamic styles based on customization
            const textShadow = customization.textShadowEnabled
              ? `${getResponsiveScaledValue(customization.textShadowOffsetX)}px ${getResponsiveScaledValue(customization.textShadowOffsetY)}px ${getResponsiveScaledValue(customization.textShadowBlur)}px ${customization.textShadowColor}`
              : 'none';

            const boxShadow = customization.glowEnabled
              ? `0 0 ${getResponsiveScaledValue(customization.glowIntensity)}px ${customization.glowColor}`
              : 'none';

            const backgroundColor = customization.backgroundOpacity > 0
              ? `${customization.backgroundColor}${Math.round(customization.backgroundOpacity * 2.55).toString(16).padStart(2, '0')}`
              : 'transparent';

            const border = customization.borderWidth > 0 && customization.borderStyle !== 'none'
              ? `${getResponsiveScaledValue(customization.borderWidth)}px ${customization.borderStyle} ${customization.borderColor}`
              : 'none';

            // Advanced styling features
            const textStroke = customization.strokeEnabled
              ? `${getResponsiveScaledValue(customization.strokeWidth)}px ${customization.strokeColor}`
              : 'none';

            // Gradient text support
            let textColor = customization.textColor;
            let backgroundImage = 'none';
            if (customization.gradientEnabled) {
              textColor = 'transparent';
              backgroundImage = `linear-gradient(${customization.gradientDirection}, ${customization.gradientColorStart}, ${customization.gradientColorEnd})`;
            }

            // Get animation transform
            const transform = getAnimationTransform(
              currentSubtitle.animationProgress,
              currentSubtitle.isAnimatingIn,
              currentSubtitle.isAnimatingOut
            );

            // Apply text transform
            let displayText = currentSubtitle.text;
            if (customization.textTransform !== 'none') {
              switch (customization.textTransform) {
                case 'uppercase':
                  displayText = displayText.toUpperCase();
                  break;
                case 'lowercase':
                  displayText = displayText.toLowerCase();
                  break;
                case 'capitalize':
                  displayText = displayText.replace(/\w\S*/g, (txt) =>
                    txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
                  break;
              }
            }

            // Apply typewriter effect if needed
            if (customization.animationType === 'typewriter') {
              displayText = getTypewriterText(
                displayText,
                currentSubtitle.animationProgress,
                currentSubtitle.isAnimatingIn
              );
            }

            return (
              <div
                style={{
                  opacity: currentSubtitle.opacity,
                  transform: transform !== 'none' ? transform : undefined,
                  fontSize: getResponsiveScaledValue(customization.fontSize),
                  fontFamily: customization.fontFamily,
                  fontWeight: customization.fontWeight,
                  color: textColor,
                  textAlign: customization.textAlign,
                  lineHeight: customization.lineHeight,
                  letterSpacing: getResponsiveScaledValue(customization.letterSpacing || 0),
                  textShadow,
                  backgroundColor,
                  border,
                  borderRadius: getResponsiveScaledValue(customization.borderRadius),
                  padding: `${getResponsiveScaledValue(8)}px ${getResponsiveScaledValue(16)}px`,
                  maxWidth: `${customization.maxWidth}%`,
                  whiteSpace: customization.wordWrap ? 'pre-wrap' : 'nowrap',
                  boxShadow,
                  // Advanced styling features
                  WebkitTextStroke: textStroke,
                  textStroke: textStroke,
                  backgroundImage: backgroundImage,
                  WebkitBackgroundClip: customization.gradientEnabled ? 'text' : 'initial',
                  backgroundClip: customization.gradientEnabled ? 'text' : 'initial',
                  textTransform: customization.textTransform || 'none',
                  direction: customization.rtlSupport ? 'rtl' : 'ltr',
                  // Note: CSS transitions don't work in server-side rendering (Remotion)
                  // All animations are handled manually through opacity and transform calculations
                  transformOrigin: 'center center', // For scale animations
                }}
              >
                {displayText}
              </div>
            );
          })()}
        </div>

        {/* Audio tracks - only add separate audio if not using video (video already includes audio) */}
        {!showVideo && <Audio src={audioUrl} volume={(metadata.originalAudioVolume ?? 100) / 100} />}
        {narrationUrl && <Audio src={narrationUrl} volume={(metadata.narrationVolume ?? 100) / 100} />}
      </AbsoluteFill>
    </ThemeProvider>
  );
};

// Memoize the component to prevent unnecessary re-renders and improve performance
export default memo(SubtitledVideoContent);
