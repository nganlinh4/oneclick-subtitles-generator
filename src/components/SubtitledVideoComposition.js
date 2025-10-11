import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, Audio, Video, useVideoConfig } from 'remotion';

// Font styles with multilingual support
const fontStyles = `
/* Korean fonts */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@100;300;400;500;700;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Nanum+Gothic:wght@400;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Nanum+Myeongjo:wght@400;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Gowun+Dodum&display=swap');

/* Vietnamese fonts */
@import url('https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@100;200;300;400;500;600;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@100;200;300;400;500;600;700;800;900&display=swap');

/* Multilingual fonts */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Source+Sans+Pro:wght@200;300;400;600;700;900&display=swap');

/* Chinese fonts */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100;300;400;500;700;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@100;300;400;500;700;900&display=swap');

/* Japanese fonts */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@100;300;400;500;700;900&display=swap');

/* Arabic fonts */
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Arabic:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Cairo:wght@200;300;400;500;600;700;800;900&display=swap');

/* Standard fonts */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Roboto:wght@100;300;400;500;700;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@100;200;300;400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Oswald:wght@200;300;400;500;600;700&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap');

/* Monospace fonts */
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@100;200;300;400;500;600;700;800&display=swap');
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@300;400;500;600;700&display=swap');
`;

// Default customization settings
const defaultCustomization = {
  fontSize: 48,
  fontFamily: "'Noto Sans', sans-serif",
  fontWeight: 'bold',
  textColor: '#ffffff',
  textAlign: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  textShadowEnabled: true,
  textShadowColor: '#000000',
  textShadowOffsetX: 2,
  textShadowOffsetY: 2,
  textShadowBlur: 4,
  glowEnabled: false,
  glowColor: '#ffffff',
  glowIntensity: 10,
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  borderWidth: 0,
  borderStyle: 'solid',
  borderColor: '#ffffff',
  borderRadius: 0,
  position: 'bottom',
  marginTop: 50,
  marginBottom: 50,
  marginLeft: 50,
  marginRight: 50,
  customPositionX: 50,
  customPositionY: 50,
  maxWidth: 90,
  wordWrap: true,
  textTransform: 'none',
  animationType: 'fade',
  animationEasing: 'ease-in-out',
  fadeInDuration: 0.3,
  fadeOutDuration: 0.3,
  rtlSupport: false
};

export const SubtitledVideoComposition = ({
  videoUrl,
  narrationUrl,
  subtitles,
  backgroundImageUrl,
  metadata,
  isVideoFile = false,
  originalAudioVolume = 100,
  narrationVolume = 100,
  cropSettings
}) => {
  const frame = useCurrentFrame();
  const { fps, height: compositionHeight } = useVideoConfig();
  const currentTimeInSeconds = frame / fps;

  // Create a scaling function that uses actual composition dimensions
  const getResponsiveScaledValue = (value) => {
    const baseHeight = 1080; // Reference height (1080p)
    const scale = compositionHeight / baseHeight;
    // Preserve fractional pixel values (up to 2 decimal places) so stroke widths can be non-integer
    if (typeof value !== 'number') return value;
    return Number((value * scale).toFixed(2));
  };

  // Get consistent relative position as percentage (based on 1080p reference)
  const getConsistentRelativePosition = (pixelValue, dimension) => {
    // Always calculate percentage based on 1080p reference dimensions
    const referenceDimension = dimension === 'width' ? 1920 : 1080;
    const percentage = (pixelValue / referenceDimension) * 100;
    return `${percentage.toFixed(2)}%`;
  };

  // Determine if we should show video or just audio with background
  const showVideo = isVideoFile;

  // Get customization settings
  const customization = metadata?.subtitleCustomization || defaultCustomization;

  // Process subtitles based on line threshold
  const processedSubtitles = useMemo(() => {
    if (!subtitles) {
      return subtitles;
    }

    return subtitles.map(subtitle => {
      // Keep subtitles as they are - no need to split them
      return subtitle;
    });
  }, [subtitles]);

  // Find the current active subtitle (only one at a time)
  const getCurrentSubtitle = (currentTime) => {
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
  const getAnimationTransform = (progress, isAnimatingIn, isAnimatingOut) => {
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
  const applyEasing = (t, easing) => {
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
  const getTypewriterText = (text, progress, isAnimatingIn) => {
    if (customization.animationType !== 'typewriter' || !isAnimatingIn) {
      return text;
    }

    const targetLength = Math.floor(text.length * progress);
    return text.substring(0, targetLength);
  };

  // Compute flip transforms from cropSettings so preview matches final render
  const flipXScale = cropSettings?.flipX ? -1 : 1;
  const flipYScale = cropSettings?.flipY ? -1 : 1;
  const videoFlipTransform = `scaleX(${flipXScale}) scaleY(${flipYScale})`;
  
  // Compute adjusted positioning for cropping, taking flips into account.
  // When flipX is true the visible crop origin mirrored horizontally, so left must be computed from the opposite edge.
  // NOTE: if frames were pre-cropped server-side, composition should NOT re-apply cropping (double-zoom bug).
  const computeCropPosition = (cs, metadataFlag) => {
    if (metadataFlag?.framesPreCropped) {
      // Frames are already cropped to the requested rectangle; composition should render them as full-frame images.
      return {};
    }
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
  const cropPosition = computeCropPosition(cropSettings, metadata);
  return (
    <>
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
            {cropSettings && (
              (cropSettings.width > 100 || cropSettings.height > 100 || cropSettings.x < 0 || cropSettings.y < 0 ||
               (cropSettings.x + cropSettings.width) > 100 || (cropSettings.y + cropSettings.height) > 100)
            ) && (
              <>
                {cropSettings.canvasBgMode === 'solid' && (
                  <div style={{ position: 'absolute', inset: 0, backgroundColor: cropSettings.canvasBgColor || '#000' }} />
                )}
                {cropSettings.canvasBgMode === 'blur' && showVideo && (
                  <Video
                    src={videoUrl}
                    volume={0}
                    style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: `blur(${(cropSettings.canvasBgBlur ?? 24)}px) brightness(0.7)`, transform: `scale(1.06) ${videoFlipTransform}`, transformOrigin: 'center center' }}
                  />
                )}
              </>
            )}
            <Video
              src={videoUrl}
              volume={originalAudioVolume / 100}
              style={{
                // When cropping, scale up the video and reposition.
                // Use the same math as the renderer (SubtitledVideo.tsx) so preview matches final output,
                // including correct handling when flipX/flipY are enabled.
                ...(cropSettings && (cropSettings.width !== 100 || cropSettings.height !== 100 || cropSettings.x !== 0 || cropSettings.y !== 0)
                  ? {
                      position: 'absolute',
                      width: cropPosition.widthPct,
                      height: cropPosition.heightPct,
                      left: cropPosition.leftPct,
                      top: cropPosition.topPct,
                      objectFit: 'contain',
                      transform: videoFlipTransform,
                      transformOrigin: 'center center'
                    }
                  : {
                      width: '100%',
                      height: '100%',
                      objectFit: 'contain',
                      transform: videoFlipTransform,
                      transformOrigin: 'center center'
                    }
                )
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
                default:
                  // No transformation needed
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

            const subtitleStyleProperties = {
              opacity: currentSubtitle.opacity,
              transform: transform !== 'none' ? transform : undefined,
              fontSize: getResponsiveScaledValue(customization.fontSize),
              fontFamily: customization.fontFamily,
              fontWeight: customization.fontWeight,
              color: textColor, // Assuming textColor is already defined based on gradient logic
              textAlign: customization.textAlign,
              lineHeight: customization.lineHeight,
              letterSpacing: getResponsiveScaledValue(customization.letterSpacing || 0),
              textShadow, // Assuming textShadow is already defined
              backgroundColor, // Assuming backgroundColor is already defined
              border, // Assuming border is already defined
              borderRadius: getResponsiveScaledValue(customization.borderRadius),
              padding: `${getResponsiveScaledValue(8)}px ${getResponsiveScaledValue(16)}px`,
              maxWidth: `${customization.maxWidth}%`,
              whiteSpace: customization.wordWrap ? 'pre-wrap' : 'nowrap',
              boxShadow, // Assuming boxShadow is already defined
              direction: customization.rtlSupport ? 'rtl' : 'ltr',
              backgroundImage: backgroundImage, // Assuming backgroundImage is already defined for gradient
              WebkitBackgroundClip: customization.gradientEnabled ? 'text' : 'initial',
              backgroundClip: customization.gradientEnabled ? 'text' : 'initial',
              textTransform: customization.textTransform || 'none',
              transformOrigin: 'center center',
            };

            if (customization.strokeEnabled) {
              const strokeValue = `${getResponsiveScaledValue(customization.strokeWidth)}px ${customization.strokeColor}`;
              subtitleStyleProperties.WebkitTextStroke = strokeValue;
              subtitleStyleProperties.textStroke = strokeValue;
              // Ensure explicit width and color are also set if needed, though shorthand should be enough
              subtitleStyleProperties.WebkitTextStrokeWidth = `${getResponsiveScaledValue(customization.strokeWidth)}px`;
              subtitleStyleProperties.textStrokeWidth = `${getResponsiveScaledValue(customization.strokeWidth)}px`;
              subtitleStyleProperties.WebkitTextStrokeColor = customization.strokeColor;
              subtitleStyleProperties.textStrokeColor = customization.strokeColor;
            } else {
              subtitleStyleProperties.WebkitTextStroke = 'none'; // Keep this as a general reset
              subtitleStyleProperties.textStroke = 'none';       // Keep this
              subtitleStyleProperties.WebkitTextStrokeWidth = '0px'; // Explicitly set width to 0
              subtitleStyleProperties.textStrokeWidth = '0px';       // Explicitly set width to 0
              subtitleStyleProperties.WebkitTextStrokeColor = 'transparent'; // Explicitly set color to transparent
              subtitleStyleProperties.textStrokeColor = 'transparent';       // Explicitly set color to transparent
            }

            return (
              <div style={subtitleStyleProperties}>
                {displayText}
              </div>
            );
          })()}
        </div>

        {/* Audio tracks - only add separate audio if not using video (video already includes audio) */}
        {!showVideo && <Audio src={videoUrl} volume={originalAudioVolume / 100} />}
        {narrationUrl && <Audio src={narrationUrl} volume={narrationVolume / 100} />}
      </AbsoluteFill>
    </>
  );
};

export default SubtitledVideoComposition;
