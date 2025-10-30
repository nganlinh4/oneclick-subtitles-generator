import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react';

/**
 * Pure React Wavy Progress Indicator Component
 *
 * This is now a "dumb" component that renders the colors it is given via props.
 * It defaults to a light theme if no colors are provided.
 */

// Animation specifications from Android MotionTokens
const AnimationSpecs = {
    increasingAmplitude: {
        duration: 500,
        easing: [0.2, 0, 0, 1]
    },
    decreasingAmplitude: {
        duration: 500,
        easing: [0.05, 0.7, 0.1, 1]
    },
    progressAnimation: {
        duration: 500,
        easing: [0.4, 0, 0.2, 1]
    }
};

// Default configuration matching original
const WavyProgressDefaults = {
    indicatorColor: '#485E92',
    trackColor: '#D9DFF6',
    containerWidth: 240,
    containerHeight: 16,
    strokeWidth: 8,
    wavelength: 32,
    gapSize: 8,
    stopSize: 4,

    // Exact amplitude function from Android
    indicatorAmplitude: (progress) => {
        if (progress <= 0.1 || progress >= 0.95) return 0;
        return 1;
    }
};

// Exact port of Android's Animatable class for amplitude animations
class Animatable {
    constructor(initialValue = 0) {
        this.value = initialValue;
        this.targetValue = initialValue;
        this.isRunning = false;
        this.animationId = null;
        this.onUpdate = null;
    }

    async animateTo(targetValue, animationSpec) {
        if (this.targetValue === targetValue && !this.isRunning) {
            return;
        }

        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        this.targetValue = targetValue;
        this.isRunning = true;

        const startValue = this.value;
        const startTime = performance.now();
        const duration = animationSpec.duration;
        const easing = animationSpec?.easing;

        return new Promise((resolve) => {
            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // Apply cubic bezier easing if provided (matches web component behavior)
                const easedProgress = Array.isArray(easing)
                    ? this.cubicBezier(progress, easing)
                    : (progress * (2 - progress)); // fallback ease-out

                this.value = startValue + (targetValue - startValue) * easedProgress;

                if (this.onUpdate) this.onUpdate(this.value);

                if (progress < 1) {
                    this.animationId = requestAnimationFrame(animate);
                } else {
                    this.isRunning = false;
                    this.animationId = null;
                    resolve();
                }
            };
            this.animationId = requestAnimationFrame(animate);
        });
    }

    // Simplified cubic-bezier evaluation (kept consistent with Web Component)
    cubicBezier(t, [x1, y1, x2, y2]) {
        const cx = 3 * x1;
        const bx = 3 * (x2 - x1) - cx;
        const ax = 1 - cx - bx;

        const cy = 3 * y1;
        const by = 3 * (y2 - y1) - cy;
        const ay = 1 - cy - by;

        const x = ((ax * t + bx) * t + cx) * t;
        return ((ay * x + by * x + cy) * x);
    }

    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.isRunning = false;
    }
}

// Progress drawing cache for path management
class LinearProgressDrawingCache {
    constructor() {
        this.fullProgressPath = null;
        this.fullTrackPath = null;
        this.trackPathToDraw = null;
        this.progressPathsToDraw = [];
        this.currentSize = { width: 0, height: 0 };
        this.currentStrokeCapWidth = 4;
        this.currentIndicatorTrackGapSize = 4;
    }

    updatePaths(size, wavelength, progressFractions, amplitude, waveOffset, gapSize, stroke, trackStroke) {
        this.currentSize = size;
        this.currentStrokeCapWidth = stroke.width / 2;
        this.currentIndicatorTrackGapSize = gapSize;

        this.updateFullPaths(size, wavelength, amplitude, stroke, trackStroke);
        this.updateDrawPaths(progressFractions, amplitude, waveOffset);
    }

    updateFullPaths(size, wavelength, amplitude, stroke, trackStroke) {
        const width = size.width;
        const height = size.height;

        // Create the full progress path
        this.fullProgressPath = new Path2D();
        this.fullProgressPath.moveTo(0, 0);

        if (amplitude === 0) {
            // Just a line
            this.fullProgressPath.lineTo(width, 0);
        } else {
            // Create wavy path - exact algorithm from Android
            const halfWavelengthPx = wavelength / 2;
            let anchorX = halfWavelengthPx;
            const anchorY = 0;
            let controlX = halfWavelengthPx / 2;
            let controlY = (height - stroke.width) * 0.5;

            const widthWithExtraPhase = width + wavelength * 2;

            while (anchorX <= widthWithExtraPhase) {
                this.fullProgressPath.quadraticCurveTo(controlX, controlY, anchorX, anchorY);
                anchorX += halfWavelengthPx;
                controlX += halfWavelengthPx;
                controlY *= -1;
            }
        }

        // Create full track path
        this.fullTrackPath = new Path2D();
        this.fullTrackPath.moveTo(0, 0);
        this.fullTrackPath.lineTo(width, 0);

        return true;
    }

    updateDrawPaths(progressFractions, amplitude, waveOffset) {
        const width = this.currentSize.width;
        const halfHeight = this.currentSize.height / 2;

        // Update track path with receding animation
        this.updateTrackPath(progressFractions, width, halfHeight);

        // Update progress paths
        this.progressPathsToDraw = [];

        for (let i = 0; i < progressFractions.length / 2; i++) {
            const startFraction = progressFractions[i * 2];
            const endFraction = progressFractions[i * 2 + 1];

            if (endFraction > startFraction) {
                const progressPath = new Path2D();
                const startX = startFraction * width;
                const endX = endFraction * width;

                // Apply wave offset
                const offsetX = amplitude > 0 ? waveOffset * WavyProgressDefaults.wavelength : 0;

                // Create clipped progress path
                progressPath.addPath(this.fullProgressPath, new DOMMatrix().translate(offsetX, halfHeight));

                this.progressPathsToDraw.push({
                    path: progressPath,
                    startX: startX,
                    endX: endX
                });
            }
        }
    }

    updateTrackPath(progressFractions, width, halfHeight) {
        // Track receding animation - track appears behind progress with gap
        let activeIndicatorVisible = false;
        let nextEndTrackOffset = width - this.currentStrokeCapWidth;

        this.trackPathToDraw = new Path2D();
        this.trackPathToDraw.moveTo(nextEndTrackOffset, halfHeight);

        for (let i = 0; i < progressFractions.length / 2; i++) {
            const startProgressFraction = progressFractions[i * 2];
            const endProgressFraction = progressFractions[i * 2 + 1];

            const barHead = endProgressFraction * width;
            const barTail = startProgressFraction * width;

            let adjustedTrackGapSize = this.currentIndicatorTrackGapSize;

            if (i === 0) {
                adjustedTrackGapSize = barHead < this.currentStrokeCapWidth ?
                    0 : Math.min(barHead - this.currentStrokeCapWidth, this.currentIndicatorTrackGapSize);
                activeIndicatorVisible = barHead >= this.currentStrokeCapWidth;
            }

            const adjustedBarHead = Math.max(this.currentStrokeCapWidth,
                Math.min(barHead, width - this.currentStrokeCapWidth));

            const adaptiveTrackSpacing = activeIndicatorVisible ?
                adjustedTrackGapSize + this.currentStrokeCapWidth * 2 : adjustedTrackGapSize;

            if (nextEndTrackOffset > adjustedBarHead + adaptiveTrackSpacing) {
                this.trackPathToDraw.lineTo(
                    Math.max(this.currentStrokeCapWidth, adjustedBarHead + adaptiveTrackSpacing),
                    halfHeight
                );
            }

            nextEndTrackOffset = Math.min(nextEndTrackOffset, barTail - adaptiveTrackSpacing);
        }

        if (nextEndTrackOffset > this.currentStrokeCapWidth) {
            this.trackPathToDraw.lineTo(this.currentStrokeCapWidth, halfHeight);
        }
    }
}

// Pure React Wavy Progress Indicator with all original features
const WavyProgressIndicator = forwardRef(({
    progress = 0,
    animate = true,
    color,
    trackColor,
    stopIndicatorColor,
    wavelength = WavyProgressDefaults.wavelength,
    waveSpeed = 1,
    showStopIndicator = true,
    width: widthProp,
    height: heightProp,
    minWidth: minWidthProp,
    maxWidth: maxWidthProp,
    strokeWidth = WavyProgressDefaults.strokeWidth,
    gapSize = WavyProgressDefaults.gapSize,
    stopSize = WavyProgressDefaults.stopSize,
    forceFlat = false, // New prop to force flat appearance (no waves)
    // Shadows: apply to progress stroke and stop indicator only (not track)
    progressShadow = false,
    progressShadowColor = 'rgba(0, 0, 0, 0.8)',
    progressShadowBlur = 2,
    progressShadowOffsetX = 0,
    progressShadowOffsetY = 1,
    progressShadowBleed = 3,
    className,
    style
}, ref) => {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);
    const ctxRef = useRef(null);
    const drawingCacheRef = useRef(null);
    const amplitudeAnimatableRef = useRef(null);
    const progressAnimationRef = useRef(null);
    const drawRef = useRef(null);
    const lastWidthRef = useRef(null);
    const lastHeightRef = useRef(null);
    const lastDPRRef = useRef(typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);

    // Allow variable canvas dimensions via props (fallback to defaults)
    const hasExplicitWidth = widthProp !== undefined && widthProp !== null && !isNaN(Number(widthProp));
    // Remove hard 600px clamp so canvas can grow to fullscreen widths without stretching
    const parsedMinWidth = Number(minWidthProp);
    const parsedMaxWidth = Number(maxWidthProp);
    const minWidth = Number.isFinite(parsedMinWidth) ? Math.max(0, parsedMinWidth) : 40;
    const maxWidth = Number.isFinite(parsedMaxWidth) ? Math.max(minWidth, parsedMaxWidth) : Number.POSITIVE_INFINITY;

    // When minWidth or maxWidth are provided without explicit width, we want dynamic behavior
    const isDynamicWidth = !hasExplicitWidth && (minWidthProp !== undefined || maxWidthProp !== undefined);
    const computedWidth = hasExplicitWidth ? Number(widthProp) : WavyProgressDefaults.containerWidth;
    const width = Math.max(minWidth, Math.min(maxWidth, computedWidth));

    // Use explicit width styling only when width is explicitly set
    const shouldUseExplicitWidth = hasExplicitWidth;
    const height = Math.max(12, Math.min(48, Number(heightProp) || WavyProgressDefaults.containerHeight));

    // State for animations - ensure valid initial progress
    const [currentProgress, setCurrentProgress] = useState(Math.max(0, Math.min(1, progress || 0)));
    const [waveOffset, setWaveOffset] = useState(0);
    const [isAnimatingEntrance, setIsAnimatingEntrance] = useState(false);
    const [isAnimatingDisappearance, setIsAnimatingDisappearance] = useState(false);
    const [hasDisappeared, setHasDisappeared] = useState(false);
    const [entranceStartTime, setEntranceStartTime] = useState(0);
    const [disappearanceStartTime, setDisappearanceStartTime] = useState(0);

    // Prefer explicit props, then check CSS variables on :root (theme-aware), then fall back to defaults.
    const getRootCssVar = (name) => {
        if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null;
        const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return val || null;
    };
    
    const effectiveColor = color
        || getRootCssVar('--wavy-progress-color')
        || getRootCssVar('--figma-progress-color')
        || WavyProgressDefaults.indicatorColor;
    
    const effectiveTrackColor = trackColor
        || getRootCssVar('--wavy-track-color')
        || getRootCssVar('--figma-track-color')
        || WavyProgressDefaults.trackColor;
    
    // Debug: log computed theme and color sources at runtime (browser only)
    useEffect(() => {
        try {
            const info = {
                propColor: color || null,
                propTrackColor: trackColor || null,
                rootWavyProgressColor: getRootCssVar('--wavy-progress-color'),
                rootFigmaProgressColor: getRootCssVar('--figma-progress-color'),
                rootWavyTrackColor: getRootCssVar('--wavy-track-color'),
                rootFigmaTrackColor: getRootCssVar('--figma-track-color'),
                dataThemeRoot: (typeof document !== 'undefined') ? document.documentElement.getAttribute('data-theme') : null,
                dataThemeBody: (typeof document !== 'undefined') ? document.body.getAttribute('data-theme') : null,
                rootHasDarkClass: (typeof document !== 'undefined') ? document.documentElement.classList.contains('dark') : null,
                bodyHasDarkClass: (typeof document !== 'undefined') ? document.body.classList.contains('dark') : null,
                prefersDark: (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-color-scheme: dark)').matches : null,
                effectiveColor,
                effectiveTrackColor
            };
            // Use a concise label so it's easy to find in the console
            console.log('WavyProgressIndicator theme debug:', info);
        } catch (e) {
            // ignore in non-browser environments
        }
    }, [color, trackColor, effectiveColor, effectiveTrackColor]);

    // Constants
    const ENTRANCE_DISAPPEARANCE_DURATION = 500;

    // High DPI canvas setup (responsive to width/height props or parent container)
    const setupHighDPICanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        const devicePixelRatio = window.devicePixelRatio || 1;

        // Prefer this container's width only when width prop is not explicitly provided
        // Measure CSS pixel size of the canvas itself; let CSS control layout
        let containerWidth = (canvas.getBoundingClientRect?.().width) || canvas.clientWidth;

        // If canvas size is not available, try the parent container
        if ((!containerWidth || containerWidth === 0) && container) {
            const rect = container.getBoundingClientRect?.();
            containerWidth = (rect && rect.width) || container.clientWidth;
        }

        // If still no width, try the parent's parent (for nested flex containers)
        if ((!containerWidth || containerWidth === 0) && container && container.parentElement) {
            const rect = container.parentElement.getBoundingClientRect?.();
            containerWidth = (rect && rect.width) || container.parentElement.clientWidth;
        }

        // For dynamic width (when minWidth/maxWidth are set), be more aggressive about using container space
        let cssWidth;
        if (hasExplicitWidth) {
            cssWidth = width;
        } else {
            // Always try to use container width first
            if (containerWidth > 0 && Number.isFinite(containerWidth)) {
                cssWidth = Math.max(minWidth, Math.min(maxWidth, containerWidth));
            } else {
                // If no container width, use maxWidth for dynamic width, default width otherwise
                cssWidth = isDynamicWidth ? maxWidth : width;
            }
        }
        const baseCssHeight = Number(heightProp) || (canvas.getBoundingClientRect?.().height) || canvas.clientHeight || height;
        const extraBleed = (progressShadow ? progressShadowBleed * 2 : 0);
        const cssHeight = Math.max(1, baseCssHeight + extraBleed);

        // Avoid thrashing ResizeObserver: only resize drawing buffer if CSS size or DPR changed
        const needResize = (lastWidthRef.current !== cssWidth) || (lastHeightRef.current !== cssHeight) || (lastDPRRef.current !== devicePixelRatio);
        if (needResize) {
            lastWidthRef.current = cssWidth;
            lastHeightRef.current = cssHeight;
            lastDPRRef.current = devicePixelRatio;

            // Set the drawing buffer size (device pixels). Do NOT set style width/height here.
            canvas.width = Math.max(1, Math.round(cssWidth * devicePixelRatio));
            canvas.height = Math.max(1, Math.round(cssHeight * devicePixelRatio));

            // Reset and scale the drawing context so everything draws at the correct size
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(devicePixelRatio, devicePixelRatio);
        }

        ctxRef.current = ctx;
        drawingCacheRef.current = new LinearProgressDrawingCache();
    }, [width, height, progressShadow, progressShadowBleed, hasExplicitWidth, minWidth, maxWidth, isDynamicWidth, heightProp]);

    // Observe this element for responsiveness only when width is not explicitly provided
    useEffect(() => {
        if (hasExplicitWidth) return; // no observation when width is fixed by prop
        const container = containerRef.current;
        if (!container) return;

        // Initial measurement after a short delay to ensure layout is complete
        const initialTimeout = setTimeout(() => {
            setupHighDPICanvas();
            const fn = drawRef.current;
            if (typeof fn === 'function') requestAnimationFrame(() => fn());
        }, 10);

        // Additional measurement after longer delay for complex layouts
        const secondTimeout = setTimeout(() => {
            setupHighDPICanvas();
            const fn = drawRef.current;
            if (typeof fn === 'function') requestAnimationFrame(() => fn());
        }, 100);

        // Debounced resize handler to prevent ResizeObserver loop
        let resizeTimeout;
        const debouncedResize = () => {
            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                setupHighDPICanvas();
                const fn = drawRef.current;
                if (typeof fn === 'function') requestAnimationFrame(() => fn());
            }, 16); // ~60fps
        };

        const ro = new ResizeObserver(debouncedResize);
        ro.observe(container);

        // Also observe the canvas element directly for CSS size changes (e.g., during fullscreen)
        const canvas = canvasRef.current;
        if (canvas) {
            const roCanvas = new ResizeObserver(debouncedResize);
            roCanvas.observe(canvas);

            // Handle window resize and fullscreen change events to avoid stretched frames during transitions
            const handleViewportChange = () => {
                setupHighDPICanvas();
                const fn = drawRef.current;
                if (typeof fn === 'function') requestAnimationFrame(() => fn());
                setTimeout(() => {
                    setupHighDPICanvas();
                    const fn2 = drawRef.current;
                    if (typeof fn2 === 'function') requestAnimationFrame(() => fn2());
                }, 50);
            };
            window.addEventListener('resize', handleViewportChange);
            const fscEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
            fscEvents.forEach((ev) => document.addEventListener(ev, handleViewportChange));

            return () => {
                window.removeEventListener('resize', handleViewportChange);
                fscEvents.forEach((ev) => document.removeEventListener(ev, handleViewportChange));
                roCanvas.disconnect();
                clearTimeout(initialTimeout);
                clearTimeout(secondTimeout);
                clearTimeout(resizeTimeout);
                ro.disconnect();
            };
        }

        return () => {
            clearTimeout(initialTimeout);
            clearTimeout(secondTimeout);
            clearTimeout(resizeTimeout);
            ro.disconnect();
        };
    }, [setupHighDPICanvas, hasExplicitWidth]);
    
    useEffect(() => {
        setupHighDPICanvas();
    }, [setupHighDPICanvas]);
    
    // Re-initialize canvas when size props change
    useEffect(() => {
        setupHighDPICanvas();
    }, [setupHighDPICanvas]);

    // Wave offset animation using rAF for smoothness and continuity
    useEffect(() => {
        let rafId = null;
        let lastTime = performance.now();
        const animate = (now) => {
            const dt = now - lastTime;
            lastTime = now;
            setWaveOffset(prev => (prev + (dt / 1000) * Math.max(0, waveSpeed)) % 1);
            rafId = requestAnimationFrame(animate);
        };
        if (waveSpeed > 0) {
            rafId = requestAnimationFrame(animate);
        } else {
            setWaveOffset(0);
        }
        return () => { if (rafId) cancelAnimationFrame(rafId); };
    }, [waveSpeed]);

    // Stable progress animation
    const animateProgress = useCallback((targetProgress) => {
        const validTarget = Math.max(0, Math.min(1, targetProgress || 0));

        if (progressAnimationRef.current) {
            cancelAnimationFrame(progressAnimationRef.current);
        }

        const startProgress = currentProgress;
        const startTime = performance.now();
        const duration = 500;

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progressRatio = Math.min(elapsed / duration, 1);

            const eased = progressRatio * (2 - progressRatio);
            const newProgress = startProgress + (validTarget - startProgress) * eased;

            setCurrentProgress(Math.max(0, Math.min(1, newProgress)));

            if (progressRatio < 1) {
                progressAnimationRef.current = requestAnimationFrame(animate);
            } else {
                progressAnimationRef.current = null;
            }
        };

        progressAnimationRef.current = requestAnimationFrame(animate);
    }, [currentProgress]);

    // Update progress when prop changes - prevent loops
    useEffect(() => {
        const validProgress = Math.max(0, Math.min(1, progress || 0));

        // Only update if there's a meaningful difference
        if (Math.abs(currentProgress - validProgress) > 0.001) {
            if (animate) {
                animateProgress(validProgress);
            } else {
                setCurrentProgress(validProgress);
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [progress, animate]); // Removed animateProgress from deps to prevent loops

    // Amplitude animation system (matches Web Component behavior)
    const updateAmplitudeAnimation = useCallback((targetAmplitudePx) => {
        if (!amplitudeAnimatableRef.current) {
            amplitudeAnimatableRef.current = new Animatable(targetAmplitudePx);
            amplitudeAnimatableRef.current.onUpdate = () => {
                // Schedule a draw on the next frame using the latest draw function reference
                const fn = drawRef.current;
                if (typeof fn === 'function') requestAnimationFrame(() => fn());
            };
        }

        const currentAmplitudeAnimatable = amplitudeAnimatableRef.current;
        if (Math.abs(currentAmplitudeAnimatable.targetValue - targetAmplitudePx) > 0.001 || !currentAmplitudeAnimatable.isRunning) {
            const animationSpec = currentAmplitudeAnimatable.value < targetAmplitudePx
                ? AnimationSpecs.increasingAmplitude
                : AnimationSpecs.decreasingAmplitude;
            currentAmplitudeAnimatable.animateTo(targetAmplitudePx, animationSpec);
        }
    }, []);

    // Easing functions
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const easeInCubic = (t) => t * t * t;

    // Drawing function with proper track receding logic
    const drawProgress = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const canvasEl = canvasRef.current;
        const ctx = canvasEl ? canvasEl.getContext('2d') : null;
        if (!canvasEl || !ctx) return;

        // Use CSS pixel size for drawing (context is DPR-scaled already)
        const width = (lastWidthRef.current ?? canvasEl.clientWidth ?? 0) || WavyProgressDefaults.containerWidth;
        const totalHeight = (lastHeightRef.current ?? canvasEl.clientHeight ?? 0) || WavyProgressDefaults.containerHeight;
        const bleedTotal = (progressShadow ? progressShadowBleed * 2 : 0);
        const effectiveHeight = Math.max(1, totalHeight - bleedTotal);

        // Clear canvas in CSS pixel coordinates
        ctx.clearRect(0, 0, width, totalHeight);

        // Ensure progress is valid
        const validProgress = Math.max(0, Math.min(1, currentProgress || 0));

        // Entrance/disappearance height animation
        const now = performance.now();
        const ENTRANCE_DURATION = ENTRANCE_DISAPPEARANCE_DURATION;
        let heightFactor = 1;
        let keepAnimating = false;

        if (hasDisappeared) {
            heightFactor = 0;
        }
        if (isAnimatingEntrance) {
            const t = Math.min((now - entranceStartTime) / ENTRANCE_DURATION, 1);
            heightFactor = easeOutCubic(t);
            keepAnimating = t < 1;
            if (t >= 1) {
                heightFactor = 1; // entrance complete
                setIsAnimatingEntrance(false);
            }
        } else if (isAnimatingDisappearance) {
            const t = Math.min((now - disappearanceStartTime) / ENTRANCE_DURATION, 1);
            heightFactor = 1 - easeInCubic(t);
            keepAnimating = true;
            if (t >= 1) {
                heightFactor = 0;
                // End disappearance animation and mark as disappeared
                setIsAnimatingDisappearance(false);
                setHasDisappeared(true);
            }
        }

        // Track/progress geometry
        const strokeCapWidth = strokeWidth / 2;
        const halfHeight = totalHeight / 2;
        const progressFrontX = strokeCapWidth + validProgress * (width - strokeCapWidth * 2);

        if (heightFactor > 0) {
            // Draw track and progress scaled vertically around center
            ctx.save();
            ctx.translate(0, halfHeight);
            ctx.scale(1, heightFactor);

            // Track (no shadow)
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
            ctx.strokeStyle = effectiveTrackColor;
            ctx.lineWidth = strokeWidth;
            ctx.lineCap = 'round';

            if (validProgress > 0) {
                const trackStart = Math.min(progressFrontX + gapSize + strokeCapWidth, width - strokeCapWidth);
                const trackEnd = width - strokeCapWidth;
                if (trackStart < trackEnd) {
                    ctx.beginPath();
                    ctx.moveTo(trackStart, 0);
                    ctx.lineTo(trackEnd, 0);
                    ctx.stroke();
                }
            } else {
                ctx.beginPath();
                ctx.moveTo(strokeCapWidth, 0);
                ctx.lineTo(width - strokeCapWidth, 0);
                ctx.stroke();
            }

            // Progress
            if (validProgress > 0) {
                const progressWidth = validProgress * (width - strokeCapWidth * 2);

                // Smooth amplitude transition like the Web Component
                const targetAmplitude = forceFlat ? 0 : WavyProgressDefaults.indicatorAmplitude(validProgress);
                updateAmplitudeAnimation(targetAmplitude);
                const animatedAmplitude = amplitudeAnimatableRef.current ? amplitudeAnimatableRef.current.value : 0;
                const waveHeight = animatedAmplitude * (effectiveHeight * 0.15);

                ctx.strokeStyle = effectiveColor;
                ctx.lineWidth = strokeWidth;
                ctx.lineCap = 'round';
                // Apply shadow only to the progress stroke
                if (progressShadow) {
                    ctx.shadowColor = progressShadowColor;
                    ctx.shadowBlur = progressShadowBlur;
                    ctx.shadowOffsetX = progressShadowOffsetX;
                    ctx.shadowOffsetY = progressShadowOffsetY;
                } else {
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 0;
                }
                ctx.beginPath();

                if (animatedAmplitude === 0) {
                    ctx.moveTo(strokeCapWidth, 0);
                    ctx.lineTo(strokeCapWidth + progressWidth, 0);
                } else {
                    const steps = Math.max(Math.floor(progressWidth / 2), 10);
                    let firstPoint = true;
                    for (let i = 0; i <= steps; i++) {
                        const x = strokeCapWidth + (i / steps) * progressWidth;
                        const waveX = ((x + waveOffset * wavelength) / wavelength) * 2 * Math.PI;
                        const y = Math.sin(waveX) * waveHeight;
                        if (firstPoint) {
                            ctx.moveTo(x, y);
                            firstPoint = false;
                        } else {
                            ctx.lineTo(x, y);
                        }
                    }
                }
                ctx.stroke();
                // Reset shadow so it doesn't affect other elements
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
            }

            ctx.restore();

            if (keepAnimating) requestAnimationFrame(() => { const fn = drawRef.current || drawProgress; fn(); });
        } else if (keepAnimating) {
            // Nothing to draw but continue the animation loop until finished
            requestAnimationFrame(() => { const fn = drawRef.current || drawProgress; fn(); });
        }

        // Draw stop indicator only when visible
        if (heightFactor > 0 && showStopIndicator && validProgress < 1) {
            // Make stop indicator size proportional to height for better visibility
            const stopRadius = Math.max(2, Math.min(effectiveHeight * 0.3, stopSize / 2));
            const stopX = width - strokeCapWidth;
            const progressX = strokeCapWidth + validProgress * (width - strokeCapWidth * 2);

            if (progressX < stopX - stopRadius) {
                // Stop indicator should match the progress bar color
                if (progressShadow) {
                    ctx.shadowColor = progressShadowColor;
                    ctx.shadowBlur = progressShadowBlur;
                    ctx.shadowOffsetX = progressShadowOffsetX;
                    ctx.shadowOffsetY = progressShadowOffsetY;
                } else {
                    ctx.shadowColor = 'transparent';
                    ctx.shadowBlur = 0;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 0;
                }
                ctx.fillStyle = stopIndicatorColor || effectiveColor;
                ctx.beginPath();
                ctx.arc(stopX, halfHeight, stopRadius, 0, 2 * Math.PI);
                ctx.fill();
                // Reset shadow after drawing stop indicator
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.shadowOffsetX = 0;
                ctx.shadowOffsetY = 0;
            }
        }
    }, [currentProgress, waveOffset, effectiveColor, effectiveTrackColor, stopIndicatorColor, wavelength, showStopIndicator, isAnimatingEntrance, isAnimatingDisappearance, hasDisappeared, entranceStartTime, disappearanceStartTime, progressShadow, progressShadowBleed, progressShadowColor, progressShadowBlur, progressShadowOffsetX, progressShadowOffsetY, forceFlat, gapSize, stopSize, strokeWidth, updateAmplitudeAnimation]);

    // Keep latest draw function in a ref to avoid TDZ issues in callbacks above
    useEffect(() => {
        drawRef.current = drawProgress;
    }, [drawProgress]);

    // Draw when values change (no continuous loop)
    useEffect(() => {
        drawProgress();
    }, [drawProgress]);

    // Imperative API with all original methods
    useImperativeHandle(ref, () => ({
        setProgress: (newProgress, shouldAnimate = true) => {
            if (shouldAnimate) {
                animateProgress(newProgress);
            } else {
                setCurrentProgress(newProgress);
            }
        },
        getProgress: () => currentProgress,
        getTargetProgress: () => currentProgress,
        startEntranceAnimation: () => {
            setHasDisappeared(false);
            setIsAnimatingDisappearance(false);
            setIsAnimatingEntrance(true);
            setEntranceStartTime(performance.now());
        },
        startDisappearanceAnimation: () => {
            setIsAnimatingEntrance(false);
            setIsAnimatingDisappearance(true);
            setDisappearanceStartTime(performance.now());
        },
        resetAnimationState: () => {
            setIsAnimatingEntrance(false);
            setIsAnimatingDisappearance(false);
            setHasDisappeared(false);
            setEntranceStartTime(0);
            setDisappearanceStartTime(0);
        },
        getElement: () => canvasRef.current
    }), [currentProgress, animateProgress]);

    const containerWidthStyle = shouldUseExplicitWidth ? `${width}px` : '100%';
    // Let CSS fully control layout width/height of canvas; we only adjust drawing buffer
    return (
        <div ref={containerRef} style={{
            width: containerWidthStyle,
            minWidth: minWidthProp ? `${minWidth}px` : undefined,
            maxWidth: maxWidthProp ? `${maxWidth}px` : undefined
        }}>
            <canvas
                ref={canvasRef}
                className={className}
                style={{
                    width: shouldUseExplicitWidth ? `${width}px` : '100%',
                    height: `${height + (progressShadow ? progressShadowBleed * 2 : 0)}px`,
                    display: 'block',
                    ...style
                }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(currentProgress * 100)}
                aria-valuetext={`${Math.round(currentProgress * 100)}%`}
            />
        </div>
    );
});

WavyProgressIndicator.displayName = 'WavyProgressIndicator';

export default WavyProgressIndicator;