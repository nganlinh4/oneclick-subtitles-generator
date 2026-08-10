/**
 * Reusable Wavy Progress Indicator Web Component
 *
 * Based on Android's Material Design 3 Wavy Progress Indicators
 * Ported from Android source code:
 * - WavyProgressIndicator.kt
 * - LinearWavyProgressModifiers.kt
 * - CircularWavyProgressModifiers.kt
 *
 * Features:
 * - Exact Android algorithms and animations
 * - Entrance and disappearance animations
 * - Theme-aware color support
 * - Configurable properties
 * - Accessibility support
 */

import { Animatable, LinearProgressDrawingCache } from './animationClasses';
import { AnimationSpecs, WavyProgressIndicatorDefaults } from './defaults';
import { easeOutCubic, easeInCubic } from './drawingUtils';
import {
    setupHighDPICanvas,
    applyAccessibilityAttributes,
    computeShouldShowStopIndicator,
    paintScaledIndicator,
} from './canvasHelpers';
import { getThemeColor, resolveThemeColors, buildShadowMarkup } from './domSetup';

// Exact LinearWavyProgressIndicator Web Component
class LinearWavyProgressIndicator extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        // Properties matching Android implementation
        this._currentProgress = 0;  // Current animated progress value
        this._targetProgress = 0;   // Target progress value to animate to
        this._progress = () => this._currentProgress;
        this._amplitude = WavyProgressIndicatorDefaults.indicatorAmplitude;
        this._color = this.getThemeColor('--figma-progress-color') || WavyProgressIndicatorDefaults.indicatorColor;
        this._trackColor = this.getThemeColor('--figma-track-color') || WavyProgressIndicatorDefaults.trackColor;
        this._stroke = WavyProgressIndicatorDefaults.linearIndicatorStroke;
        this._trackStroke = WavyProgressIndicatorDefaults.linearTrackStroke;
        this._gapSize = WavyProgressIndicatorDefaults.LinearIndicatorTrackGapSize;
        this._stopSize = WavyProgressIndicatorDefaults.LinearTrackStopIndicatorSize;
        this._wavelength = WavyProgressIndicatorDefaults.LinearDeterminateWavelength;
        this._waveSpeed = 1; // Default wave speed (1 cycle per second)

        // Progress animation properties
        this._progressAnimatable = new Animatable(0);
        this._progressAnimationJob = null;
        this._progressAnimationDuration = 300; // Default animation duration in ms

        // Wave acceleration during progress animation
        this._baseWaveSpeed = this._waveSpeed; // Store original wave speed
        this._isProgressAnimating = false;
        this._waveAccelerationFactor = 1.6; // Subtle, natural acceleration (Material Design 3)
        this._waveSpeedAnimatable = new Animatable(this._waveSpeed); // Initialize with current wave speed
        this._waveSpeedTransitionDuration = 200; // Smooth transition duration in ms

        // Animation state - exact port from Android
        this._waveOffset = 0;
        this._amplitudeAnimatable = null; // Will be created on first use
        this._offsetAnimationId = null;
        this._amplitudeAnimationJob = null;
        
        // NEW: Entrance and Disappearance Animation State
        this._isAnimatingEntrance = false;
        this._entranceStartTime = 0;
        this._isAnimatingDisappearance = false;
        this._disappearanceStartTime = 0;
        this._hasDisappeared = false; // Track if element has completed disappearance
        this.ENTRANCE_DISAPPEARANCE_DURATION = 400; // in milliseconds


        // Drawing cache
        this._progressDrawingCache = new LinearProgressDrawingCache();

        // Set up progress animation callback
        this._progressAnimatable.onUpdate = (value) => {
            this._currentProgress = value;
            this.invalidateDraw();
            // Update accessibility attributes
            this.updateAccessibility(value);
        };

        // Set up wave speed animation callback for smooth transitions
        this._waveSpeedAnimatable.onUpdate = (value) => {
            this._waveSpeed = value;
            // Update the animation duration for the existing loop without restarting
            this.updateWaveSpeedOnly();
        };

        this.render();
    }

    // Method to get current theme colors from CSS variables
    getThemeColor(cssVariable) {
        return getThemeColor(cssVariable);
    }

    // Method to update colors based on current theme
    updateThemeColors() {
        const { progressColor, trackColor } = resolveThemeColors();
        this._color = progressColor;
        this._trackColor = trackColor;
        this.invalidateDraw();
    }

    // Method to set custom colors programmatically
    setColors(progressColor, trackColor) {
        if (progressColor) this._color = progressColor;
        if (trackColor) this._trackColor = trackColor;
        this.invalidateDraw();
    }

    // Method to reset to default colors
    resetToDefaultColors() {
        this._color = WavyProgressIndicatorDefaults.indicatorColor;
        this._trackColor = WavyProgressIndicatorDefaults.trackColor;
        this.invalidateDraw();
    }

    static get observedAttributes() {
        return ['progress', 'color', 'track-color', 'amplitude',
                'wavelength', 'wave-speed', 'gap-size', 'stop-size'];
    }

    attributeChangedCallback(name, _oldValue, newValue) {
        switch (name) {
            case 'progress': {
                const progressValue = parseFloat(newValue) || 0;
                this.setProgress(progressValue);
                break;
            }
            case 'color':
                this._color = newValue || WavyProgressIndicatorDefaults.indicatorColor;
                break;
            case 'track-color':
                this._trackColor = newValue || WavyProgressIndicatorDefaults.trackColor;
                break;
            case 'amplitude':
                if (newValue && !isNaN(parseFloat(newValue))) {
                    const amp = Math.max(0, Math.min(1, parseFloat(newValue)));
                    this._amplitude = () => amp;
                } else {
                    this._amplitude = WavyProgressIndicatorDefaults.indicatorAmplitude;
                }
                break;
            case 'wavelength':
                this._wavelength = parseFloat(newValue) || WavyProgressIndicatorDefaults.LinearDeterminateWavelength;
                this.updateOffsetAnimation();
                break;
            case 'wave-speed':
                this._baseWaveSpeed = parseFloat(newValue) || 1; // Default to 1 for visible animation
                this._waveSpeed = this._baseWaveSpeed;
                // Don't restart animation to preserve continuity
                break;
            case 'gap-size':
                this._gapSize = parseFloat(newValue) || WavyProgressIndicatorDefaults.LinearIndicatorTrackGapSize;
                break;
            case 'stop-size':
                this._stopSize = parseFloat(newValue) || WavyProgressIndicatorDefaults.LinearTrackStopIndicatorSize;
                break;
        }
        this.invalidateDraw();
    }

    connectedCallback() {
        this.updateOffsetAnimation();
        // Start entrance animation if progress is at 0 when connected
        if (this.getProgress() === 0) {
            this.startEntranceAnimation();
        }
        this.startDrawLoop();
    }

    disconnectedCallback() {
        this.stopAllAnimations();
    }

    render() {
        const containerWidth = WavyProgressIndicatorDefaults.LinearContainerWidth;
        const containerHeight = WavyProgressIndicatorDefaults.LinearContainerHeight;

        this.shadowRoot.innerHTML = buildShadowMarkup(containerWidth, containerHeight);

        this.canvas = this.shadowRoot.querySelector('canvas');
        this.ctx = this.canvas.getContext('2d');

        // Set up high-DPI rendering for crisp visuals
        this.setupHighDPICanvas();

        // Set up accessibility
        this.setAttribute('role', 'progressbar');
        this.setAttribute('aria-valuemin', '0');
        this.setAttribute('aria-valuemax', '100');
    }

    // Set up high-DPI canvas rendering for crisp visuals
    setupHighDPICanvas() {
        // Store the device pixel ratio for later use
        this.devicePixelRatio = setupHighDPICanvas(this.canvas, this.ctx);
    }

    // Update wave speed without restarting animation (preserves continuity)
    updateWaveSpeedOnly() {
        // Just update the internal speed - the existing animation loop will adapt
        // No need to restart the animation, preserving wave continuity
    }

    // Exact port of updateOffsetAnimation from Android
    updateOffsetAnimation() {
        if (this._offsetAnimationId) {
            cancelAnimationFrame(this._offsetAnimationId);
            this._offsetAnimationId = null;
        }

        if (this._waveSpeed > 0 && this._wavelength > 0) {
            const startTime = performance.now();
            let lastTime = startTime;

            const animate = (currentTime) => {
                const deltaTime = currentTime - lastTime;
                lastTime = currentTime;

                // Calculate speed-based offset increment (preserves continuity during speed changes)
                const speedFactor = this._waveSpeed; // Direct speed factor for more visible effect
                const offsetIncrement = (deltaTime / 1000) * speedFactor;



                this._waveOffset = (this._waveOffset + offsetIncrement) % 1;

                this._offsetAnimationId = requestAnimationFrame(animate);
            };

            this._offsetAnimationId = requestAnimationFrame(animate);
        } else {
            this._waveOffset = 0;
        }
    }

    // EXACT port of updateAmplitudeAnimation from Android LinearWavyProgressModifiers.kt
    updateAmplitudeAnimation(targetAmplitudePx) {
        // Create Animatable if it doesn't exist (exact Android behavior)
        const currentAmplitudeAnimatable = this._amplitudeAnimatable ||
            new Animatable(targetAmplitudePx);

        if (!this._amplitudeAnimatable) {
            this._amplitudeAnimatable = currentAmplitudeAnimatable;
            // Set up update callback to trigger redraws
            currentAmplitudeAnimatable.onUpdate = () => {
                this.invalidateDraw();
            };
        }

        // Check if the amplitude target has changed AND animation is not already running
        // towards it. If so, launch the amplitude animation (exact Android logic)
        if (currentAmplitudeAnimatable.targetValue !== targetAmplitudePx &&
            (!this._amplitudeAnimationJob || !currentAmplitudeAnimatable.isRunning)) {

            // Cancel existing animation job
            if (this._amplitudeAnimationJob) {
                currentAmplitudeAnimatable.stop();
            }

            // Choose animation spec based on direction (exact Android logic)
            const animationSpec = currentAmplitudeAnimatable.value < targetAmplitudePx
                ? AnimationSpecs.increasingAmplitude  // IncreasingAmplitudeAnimationSpec
                : AnimationSpecs.decreasingAmplitude; // DecreasingAmplitudeAnimationSpec

            // Start animation (equivalent to coroutineScope.launch in Android)
            this._amplitudeAnimationJob = currentAmplitudeAnimatable.animateTo(
                targetAmplitudePx,
                animationSpec
            );
        }
    }



    getProgressFractions() {
        // Return 2 values for determinate progress
        return [0, this._progress()];
    }

    startDrawLoop() {
        const draw = () => {
            this.drawProgress();
            requestAnimationFrame(draw);
        };
        requestAnimationFrame(draw);
    }

    // [FIXED] Drawing logic with corrected entrance/disappearance animation handling
    drawProgress() {
        if (!this.ctx) return;

        const canvas = this.canvas;
        const ctx = this.ctx;
        const size = {
            width: parseInt(canvas.style.width) || canvas.width / (this.devicePixelRatio || 1),
            height: parseInt(canvas.style.height) || canvas.height / (this.devicePixelRatio || 1)
        };

        ctx.clearRect(0, 0, size.width, size.height);

        // --- Entrance and Disappearance Animation Logic ---
        let entranceProgress = 1;
        if (this._isAnimatingEntrance) {
            const elapsed = performance.now() - this._entranceStartTime;
            entranceProgress = Math.min(elapsed / this.ENTRANCE_DISAPPEARANCE_DURATION, 1);
            if (entranceProgress >= 1) {
                this._isAnimatingEntrance = false;
            }
        }

        let disappearanceProgress = 0;
        if (this._isAnimatingDisappearance) {
            const elapsed = performance.now() - this._disappearanceStartTime;
            disappearanceProgress = Math.min(elapsed / this.ENTRANCE_DISAPPEARANCE_DURATION, 1);
            if (disappearanceProgress >= 1) {
                this._isAnimatingDisappearance = false;
                this._hasDisappeared = true; // Mark as disappeared
            }
        }

        const easedEntranceProgress = easeOutCubic(entranceProgress);
        const easedDisappearanceProgress = easeInCubic(disappearanceProgress);
        let currentScale = easedEntranceProgress * (1 - easedDisappearanceProgress);

        if (this._hasDisappeared) {
            currentScale = 0;
        }

        if (currentScale <= 0.01) {
            return; // Nothing to draw if completely invisible
        }

        // Get current progress and amplitude
        const coercedProgress = Math.max(0, Math.min(1, this._progress()));
        const targetAmplitudePx = this._amplitude(coercedProgress);
        this.updateAmplitudeAnimation(targetAmplitudePx);
        const currentAmplitude = this._amplitudeAnimatable ? this._amplitudeAnimatable.value : 0;


        const progressFractions = this.getProgressFractions();

        paintScaledIndicator(ctx, size, currentScale, {
            cache: this._progressDrawingCache,
            wavelength: this._wavelength,
            progressFractions,
            currentAmplitude,
            waveOffset: this._waveOffset,
            gapSize: this._gapSize,
            stroke: this._stroke,
            trackStroke: this._trackStroke,
            trackColor: this._trackColor,
            color: this._color,
            coercedProgress,
            showStopIndicator: this.shouldShowStopIndicator(),
        });

        // Update accessibility attributes
        this.updateAccessibility(coercedProgress);
    }

    // Update accessibility attributes
    updateAccessibility(progress) {
        applyAccessibilityAttributes(this, progress);
    }

    // Check if stop indicator should be shown based on Material Design 3 guidelines
    shouldShowStopIndicator() {
        return computeShouldShowStopIndicator(this);
    }

    invalidateDraw() {
        // This is now handled by the continuous draw loop.
        // Calling it just ensures a draw on the *very next* frame if needed,
        // but the loop itself keeps it rendering.
    }

    stopAllAnimations() {
        if (this._offsetAnimationId) {
            cancelAnimationFrame(this._offsetAnimationId);
            this._offsetAnimationId = null;
        }
        if (this._amplitudeAnimatable) {
            this._amplitudeAnimatable.stop();
            this._amplitudeAnimationJob = null;
        }
        if (this._progressAnimatable) {
            this._progressAnimatable.stop();
            this._progressAnimationJob = null;
        }
        if (this._waveSpeedAnimatable) {
            this._waveSpeedAnimatable.stop();
        }
        // Stop wave acceleration
        this.stopWaveAcceleration();
    }

    // Public API methods
    setProgress(progress, animate = true) {
        const newProgress = Math.max(0, Math.min(1, progress));
        const oldProgress = this._currentProgress;

        // Store target progress
        this._targetProgress = newProgress;

        if (!animate || Math.abs(newProgress - oldProgress) < 0.001) {
            // No animation needed or very small change
            this._currentProgress = newProgress;
            this._progressAnimatable.value = newProgress;
            this.setAttribute('aria-valuenow', Math.round(newProgress * 100));
            this.invalidateDraw();
        } else {
            // Animate to new progress
            this.animateProgressTo(newProgress);
        }

        // Trigger disappearance animation only when reaching 100%
        if (newProgress >= 1 && oldProgress < 1) {
            // Delay disappearance until progress animation completes
            const delay = animate ? this._progressAnimationDuration : 0;
            setTimeout(() => {
                this.startDisappearanceAnimation();
            }, delay);
        }
        // If progress is set to something less than 1 while disappearing, cancel it
        else if (newProgress < 1 && this._isAnimatingDisappearance) {
            this.resetAnimationState();
        }
    }

    // Animate progress smoothly to target value
    async animateProgressTo(targetProgress) {
        // Cancel existing progress animation
        if (this._progressAnimationJob) {
            this._progressAnimatable.stop();
            this._progressAnimationJob = null;
        }

        // Calculate animation duration based on distance
        const distance = Math.abs(targetProgress - this._currentProgress);
        const duration = Math.max(150, Math.min(this._progressAnimationDuration, distance * 800));

        // Start wave acceleration for Material Design 3 Expressive behavior
        this.startWaveAcceleration();

        // Use smooth easing for progress animation
        const animationSpec = {
            duration: duration,
            easing: [0.4, 0, 0.2, 1] // Material Design standard easing
        };

        try {
            this._progressAnimationJob = this._progressAnimatable.animateTo(targetProgress, animationSpec);
            await this._progressAnimationJob;
        } catch (error) {
            // Animation was cancelled or failed
        } finally {
            this._progressAnimationJob = null;
            // Stop wave acceleration when progress animation completes
            this.stopWaveAcceleration();
        }
    }

    // Start wave acceleration during progress animation (Material Design 3 Expressive)
    startWaveAcceleration() {
        if (this._isProgressAnimating) return; // Already accelerating

        this._isProgressAnimating = true;
        const acceleratedSpeed = this._baseWaveSpeed * this._waveAccelerationFactor;

        // Smoothly animate to accelerated wave speed
        const animationSpec = {
            duration: this._waveSpeedTransitionDuration,
            easing: [0.4, 0, 0.2, 1] // Smooth easing
        };

        this._waveSpeedAnimatable.animateTo(acceleratedSpeed, animationSpec);
    }

    // Stop wave acceleration and return to normal speed
    stopWaveAcceleration() {
        if (!this._isProgressAnimating) return; // Not accelerating

        this._isProgressAnimating = false;



        // Smoothly animate back to normal wave speed
        const animationSpec = {
            duration: this._waveSpeedTransitionDuration,
            easing: [0.4, 0, 0.2, 1] // Smooth easing
        };

        this._waveSpeedAnimatable.animateTo(this._baseWaveSpeed, animationSpec);
    }

    // Set progress instantly without animation
    setProgressInstant(progress) {
        this.setProgress(progress, false);
    }

    getProgress() {
        return this._currentProgress;
    }

    getTargetProgress() {
        return this._targetProgress;
    }

    // Configuration methods for reusability
    setProgressAnimationDuration(duration) {
        this._progressAnimationDuration = Math.max(50, Math.min(2000, duration));
    }

    setWaveSpeed(speed) {
        this._baseWaveSpeed = Math.max(0, speed);
        // If not currently animating progress, smoothly update the actual wave speed
        if (!this._isProgressAnimating) {
            const animationSpec = {
                duration: 150, // Quick but smooth transition
                easing: [0.4, 0, 0.2, 1]
            };
            this._waveSpeedAnimatable.animateTo(this._baseWaveSpeed, animationSpec);
        }
        // Note: Don't call updateOffsetAnimation() here to preserve wave continuity
    }

    setWavelength(length) {
        this._wavelength = Math.max(0, length);
        this.updateOffsetAnimation();
        this.invalidateDraw();
    }

    setAmplitude(amplitude) {
        this._amplitude = Math.max(0, Math.min(1, amplitude));
        this.invalidateDraw();
    }

    // Configure wave acceleration during progress animation
    setWaveAccelerationFactor(factor) {
        this._waveAccelerationFactor = Math.max(1.2, Math.min(3, factor)); // Always accelerated: 1.2x to 3x
    }

    // Configure wave speed transition duration
    setWaveSpeedTransitionDuration(duration) {
        this._waveSpeedTransitionDuration = Math.max(50, Math.min(500, duration)); // 50ms to 500ms
    }

    // Methods to control entrance and disappearance animations
    startEntranceAnimation() {
        this.resetAnimationState();
        this._isAnimatingEntrance = true;
        this._entranceStartTime = performance.now();
    }

    startDisappearanceAnimation() {
        this._isAnimatingEntrance = false; // Ensure entrance animation stops
        this._isAnimatingDisappearance = true;
        this._disappearanceStartTime = performance.now();
    }
    
    resetAnimationState() {
        this._isAnimatingEntrance = false;
        this._isAnimatingDisappearance = false;
        this._entranceStartTime = 0;
        this._disappearanceStartTime = 0;
        this._hasDisappeared = false; // Reset disappeared state
        this.invalidateDraw();
    }
}

// Register the web component
customElements.define('wavy-progress-indicator', LinearWavyProgressIndicator);

// Make available globally for non-module usage
if (typeof window !== 'undefined') {
    window.LinearWavyProgressIndicator = LinearWavyProgressIndicator;
    window.WavyProgressIndicatorDefaults = WavyProgressIndicatorDefaults;
    window.AnimationSpecs = AnimationSpecs;
}

// Export for module usage (when used as ES6 module)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        default: LinearWavyProgressIndicator,
        LinearWavyProgressIndicator,
        WavyProgressIndicatorDefaults,
        AnimationSpecs
    };
}
