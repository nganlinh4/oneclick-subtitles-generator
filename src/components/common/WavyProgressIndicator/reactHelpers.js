// Local helpers for the React WavyProgressIndicator.jsx.
//
// These are the variants the .jsx historically used. They intentionally differ
// from the sibling animationClasses.js / defaults.js ports and are kept
// separate to preserve the React component's exact runtime behavior:
//   - `Animatable.animateTo` here guards `easing` with `Array.isArray` and
//     falls back to an ease-out curve when no bezier is supplied.
//   - `LinearProgressDrawingCache` here is the lighter cache the .jsx draws
//     against (no createWavySegment/arraysEqual, different updatePaths shape).
//   - `WavyProgressDefaults` is a flat object (containerWidth, strokeWidth,
//     wavelength, gapSize, stopSize, indicatorAmplitude...), not the class form.
// Pure module — only browser globals (Path2D, Math, performance,
// requestAnimationFrame). No React/component state.

// Animation specifications from Android MotionTokens
export const AnimationSpecs = {
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
export const WavyProgressDefaults = {
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
export class Animatable {
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
export class LinearProgressDrawingCache {
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

    updateFullPaths(size, wavelength, amplitude, stroke, _trackStroke) {
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

// Easing functions used by the entrance/disappearance height animation.
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
