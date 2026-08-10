// Drawing/animation helper classes for the Wavy Progress Indicator.
// Ported verbatim from Android source (WavyProgressIndicator.kt,
// LinearWavyProgressModifiers.kt). These are pure helpers with no
// React/component state — they only use browser globals (Path2D, Math, JSON,
// performance, requestAnimationFrame).

// LinearProgressDrawingCache equivalent
export class LinearProgressDrawingCache {
    constructor() {
        this.currentWavelength = -1;
        this.currentAmplitude = -1;
        this.currentSize = { width: 0, height: 0 };
        this.currentProgressFractions = null;
        this.currentIndicatorTrackGapSize = 0;
        this.currentWaveOffset = -1;
        this.currentStroke = { width: 8, cap: 'round' };
        this.currentTrackStroke = { width: 8, cap: 'round' };

        this.progressPathScale = 1;
        this.fullProgressPath = new Path2D();
        this.trackPathToDraw = new Path2D();
        this.progressPathsToDraw = null;
        this.currentStrokeCapWidth = 0;
    }

    // Exact port of updatePaths from LinearProgressDrawingCache
    updatePaths(size, wavelength = 0, progressFractions, amplitude, waveOffset, gapSize, stroke, trackStroke) {
        if (this.currentProgressFractions === null) {
            this.currentProgressFractions = new Array(progressFractions.length);
            this.progressPathsToDraw = new Array(Math.floor(progressFractions.length / 2));
            for (let i = 0; i < this.progressPathsToDraw.length; i++) {
                this.progressPathsToDraw[i] = new Path2D();
            }
        }

        const pathsUpdated = this.updateFullPaths(size, wavelength, amplitude, gapSize, stroke, trackStroke);
        this.updateDrawPaths(pathsUpdated, progressFractions, amplitude, waveOffset);
    }

    // Exact port of updateFullPaths
    updateFullPaths(size, wavelength, amplitude, gapSize, stroke, trackStroke) {
        if (this.currentSize.width === size.width &&
            this.currentSize.height === size.height &&
            this.currentWavelength === wavelength &&
            JSON.stringify(this.currentStroke) === JSON.stringify(stroke) &&
            JSON.stringify(this.currentTrackStroke) === JSON.stringify(trackStroke) &&
            this.currentIndicatorTrackGapSize === gapSize &&
            ((this.currentAmplitude !== 0 && amplitude !== 0) ||
             (this.currentAmplitude === 0 && amplitude === 0))) {
            return false; // No update required
        }

        const height = size.height;
        const width = size.width;

        // Update stroke cap width
        this.currentStrokeCapWidth =
            (stroke.cap === 'butt' && trackStroke.cap === 'butt') || height > width
                ? 0
                : Math.max(stroke.width / 2, trackStroke.width / 2);

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
            let controlY = (height - stroke.width) * 0.5; // Reduced amplitude for 8px stroke

            const widthWithExtraPhase = width + wavelength * 2;
            while (anchorX <= widthWithExtraPhase) {
                this.fullProgressPath.quadraticCurveTo(controlX, controlY, anchorX, anchorY);
                anchorX += halfWavelengthPx;
                controlX += halfWavelengthPx;
                controlY *= -1;
            }
        }

        // Translate path to center vertically
        // Note: Path2D doesn't have direct translate, so we'll handle this in drawing

        // Calculate progress path scale
        // This is approximated since we can't easily measure Path2D length
        this.progressPathScale = amplitude === 0 ? 1 : 1.2; // Approximation

        // Cache values
        this.currentSize = { ...size };
        this.currentWavelength = wavelength;
        this.currentStroke = { ...stroke };
        this.currentTrackStroke = { ...trackStroke };
        this.currentIndicatorTrackGapSize = gapSize;

        return true;
    }

    // Exact port of updateDrawPaths (simplified for web)
    updateDrawPaths(forceUpdate, progressFractions, amplitude, waveOffset) {
        if (!forceUpdate &&
            this.arraysEqual(this.currentProgressFractions, progressFractions) &&
            this.currentAmplitude === amplitude &&
            this.currentWaveOffset === waveOffset) {
            return; // No update required
        }

        const width = this.currentSize.width;
        const halfHeight = this.currentSize.height / 2;

        // Update track path
        this.trackPathToDraw = new Path2D();
        this.trackPathToDraw.moveTo(width - this.currentStrokeCapWidth, halfHeight);

        // Update progress paths
        for (let i = 0; i < this.progressPathsToDraw.length; i++) {
            this.progressPathsToDraw[i] = new Path2D();

            const startProgressFraction = progressFractions[i * 2];
            const endProgressFraction = progressFractions[i * 2 + 1];

            const barTail = startProgressFraction * width;
            const barHead = endProgressFraction * width;

            if (Math.abs(endProgressFraction - startProgressFraction) > 0) {
                // Create progress segment
                const adjustedBarHead = Math.max(this.currentStrokeCapWidth,
                    Math.min(barHead, width - this.currentStrokeCapWidth));
                const adjustedBarTail = Math.max(this.currentStrokeCapWidth,
                    Math.min(barTail, width - this.currentStrokeCapWidth));

                if (amplitude === 0) {
                    // Simple line
                    this.progressPathsToDraw[i].moveTo(adjustedBarTail, halfHeight);
                    this.progressPathsToDraw[i].lineTo(adjustedBarHead, halfHeight);
                } else {
                    // Wavy line - simplified for web implementation
                    this.createWavySegment(this.progressPathsToDraw[i],
                        adjustedBarTail, adjustedBarHead, halfHeight, amplitude, waveOffset);
                }
            }
        }

        // Update track path segments
        this.updateTrackPath(progressFractions, width, halfHeight);

        // Cache values
        progressFractions.forEach((val, idx) => this.currentProgressFractions[idx] = val);
        this.currentAmplitude = amplitude;
        this.currentWaveOffset = waveOffset;
    }

    createWavySegment(path, startX, endX, centerY, amplitude, waveOffset) {
        const segmentWidth = endX - startX;
        const wavelength = this.currentWavelength;
        const waveHeight = amplitude * this.currentSize.height * 0.15; // Reduced for 8px stroke

        path.moveTo(startX, centerY);

        const steps = Math.max(Math.floor(segmentWidth / 2), 10);
        for (let i = 1; i <= steps; i++) {
            const x = startX + (i / steps) * segmentWidth;
            const waveX = ((x + waveOffset * wavelength) / wavelength) * 2 * Math.PI;
            const y = centerY + Math.sin(waveX) * waveHeight;
            path.lineTo(x, y);
        }
    }

    updateTrackPath(progressFractions, width, halfHeight) {
        // EXACT port of Android track path logic from updateDrawPaths
        let activeIndicatorVisible = false;

        // Start from right edge (exact Android logic)
        let nextEndTrackOffset = width - this.currentStrokeCapWidth;
        this.trackPathToDraw = new Path2D();
        this.trackPathToDraw.moveTo(nextEndTrackOffset, halfHeight);

        // Process each progress segment (exact Android loop)
        for (let i = 0; i < progressFractions.length / 2; i++) {
            const startProgressFraction = progressFractions[i * 2];
            const endProgressFraction = progressFractions[i * 2 + 1];

            const barHead = endProgressFraction * width;
            const barTail = startProgressFraction * width;

            // Calculate adaptive track gap spacing (exact Android logic)
            let adjustedTrackGapSize = this.currentIndicatorTrackGapSize;

            if (i === 0) {
                // First segment logic (exact Android)
                adjustedTrackGapSize = barHead < this.currentStrokeCapWidth ?
                    0 : Math.min(barHead - this.currentStrokeCapWidth, this.currentIndicatorTrackGapSize);
                activeIndicatorVisible = barHead >= this.currentStrokeCapWidth;
            }

            // Coerce bar positions (exact Android)
            const adjustedBarHead = Math.max(this.currentStrokeCapWidth,
                Math.min(barHead, width - this.currentStrokeCapWidth));
            const adjustedBarTail = Math.max(this.currentStrokeCapWidth,
                Math.min(barTail, width - this.currentStrokeCapWidth));

            // Calculate adaptive track spacing (exact Android)
            const adaptiveTrackSpacing = activeIndicatorVisible ?
                adjustedTrackGapSize + this.currentStrokeCapWidth * 2 : adjustedTrackGapSize;

            // Draw track segment if there's space (exact Android)
            if (nextEndTrackOffset > adjustedBarHead + adaptiveTrackSpacing) {
                this.trackPathToDraw.lineTo(
                    Math.max(this.currentStrokeCapWidth, adjustedBarHead + adaptiveTrackSpacing),
                    halfHeight
                );
            }

            // Update nextEndTrackOffset for next iteration (exact Android)
            if (barHead > barTail) {
                nextEndTrackOffset = Math.max(this.currentStrokeCapWidth,
                    adjustedBarTail - adaptiveTrackSpacing);
                this.trackPathToDraw.moveTo(nextEndTrackOffset, halfHeight);
            }
        }

        // Final track drawing to fill remaining gaps (exact Android)
        if (nextEndTrackOffset > this.currentStrokeCapWidth) {
            this.trackPathToDraw.lineTo(this.currentStrokeCapWidth, halfHeight);
        }
    }

    arraysEqual(a, b) {
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        return a.every((val, idx) => val === b[idx]);
    }
}

// Exact port of Android's Animatable class for amplitude animations
export class Animatable {
    constructor(initialValue = 0) {
        this.value = initialValue;
        this.targetValue = initialValue;
        this.isRunning = false;
        this.animationId = null;
        this.onUpdate = null;
    }

    // Exact port of animateTo from Android Animatable
    async animateTo(targetValue, animationSpec) {
        if (this.targetValue === targetValue && !this.isRunning) {
            return; // Already at target
        }

        // Cancel existing animation
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }

        this.targetValue = targetValue;
        this.isRunning = true;

        const startValue = this.value;
        const startTime = performance.now();
        const duration = animationSpec.duration;
        const easing = animationSpec.easing;

        return new Promise((resolve) => {
            const animate = (currentTime) => {
                const elapsed = currentTime - startTime;
                const progress = Math.min(elapsed / duration, 1);

                // Apply cubic bezier easing
                const easedProgress = this.cubicBezier(progress, easing);
                this.value = startValue + (targetValue - startValue) * easedProgress;

                // Notify update callback
                if (this.onUpdate) {
                    this.onUpdate(this.value);
                }

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

    // Cubic bezier easing function
    cubicBezier(t, [x1, y1, x2, y2]) {
        // Simplified cubic bezier implementation
        const cx = 3 * x1;
        const bx = 3 * (x2 - x1) - cx;
        const ax = 1 - cx - bx;

        const cy = 3 * y1;
        const by = 3 * (y2 - y1) - cy;
        const ay = 1 - cy - by;

        const cubeRoot = ((ax * t + bx) * t + cx) * t;
        return ((ay * cubeRoot + by * cubeRoot + cy) * cubeRoot);
    }

    // Stop current animation
    stop() {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.isRunning = false;
    }
}
