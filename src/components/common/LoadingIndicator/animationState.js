/**
 * Animation-state helpers for the Material 3 Expressive loading indicator.
 *
 * These functions are not pure: several read from and mutate the `state` object
 * (the component's `animationState.current`). To keep them decoupled from React,
 * the state object, refs, props and drawing callbacks are passed in explicitly
 * rather than closed over from another module.
 */

import { createFallbackShape } from './shapeFactory.js';

/**
 * Resolve the shape fill color from theme/container settings, honoring an override.
 * @param {Object} opts
 * @param {string} opts.theme - 'light' or 'dark'
 * @param {boolean} opts.showContainer
 * @param {string} [opts.color] - explicit override
 * @param {Object} opts.COLORS - palette
 */
export const getShapeColor = ({ theme, showContainer, color, COLORS }) => {
  if (color) return color;
  const isDarkMode = theme === 'dark';
  if (isDarkMode) {
    return showContainer ? COLORS.shapeDarkWithContainer : COLORS.shapeDarkNoContainer;
  } else {
    return showContainer ? COLORS.shapeLightWithContainer : COLORS.shapeLightNoContainer;
  }
};

/**
 * Draw the Material 3 background container disc.
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} opts
 */
export const drawMaterial3Container = (ctx, { showContainer, size, containerColor, theme, COLORS }) => {
  if (!showContainer) return;

  // Use dynamic canvas size based on component size with larger scaling to prevent clipping
  const scaleFactor = size <= 24 ? 3.0 : size <= 48 ? 2.5 : 2.2;
  const canvasSize = Math.round(size * scaleFactor);
  const centerX = canvasSize / 2;
  const centerY = canvasSize / 2;
  const radius = Math.min(canvasSize, canvasSize) * 0.45; // Larger radius to better match SVG shapes

  ctx.save();
  ctx.translate(centerX, centerY);

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, 2 * Math.PI);

  // Use container override if provided, otherwise based on theme
  const contColor = containerColor || (theme === 'dark' ? COLORS.containerDark : COLORS.containerLight);
  ctx.fillStyle = contColor;
  ctx.fill();

  ctx.restore();
};

/**
 * Apply the spinning / scaling / pulsing transforms for a frame.
 * Mutates `state` (animationTime, discreteSpinSpeed, rotationAngle, pulseValue).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} state - animationState.current
 * @param {number} size
 */
export const applyMaterial3ExpressiveEffects = (ctx, state, size) => {
  // Update animation time
  state.animationTime += 0.05;

  // Material 3 Expressive spinning with bounce
  if (state.currentMorph && state.morphProgress < 1.0) {
    const morphPhase = state.morphProgress;

    if (morphPhase < 0.8) {
      state.discreteSpinSpeed = 6.0;
    } else {
      const bouncePhase = (morphPhase - 0.8) / 0.2;
      const speedFactor = 1 - bouncePhase;
      const bounce = Math.sin(bouncePhase * Math.PI * 2.5);
      const overshootIntensity = -1.2;

      state.discreteSpinSpeed = 6.0 * speedFactor + overshootIntensity * bounce * speedFactor;
    }
  } else {
    state.discreteSpinSpeed = 0.05;
  }

  state.rotationAngle += state.discreteSpinSpeed;
  ctx.rotate((state.rotationAngle * Math.PI) / 180);

  // DYNAMIC baseScale based on component size for better appearance in buttons
  const baseScale = size <= 24 ? 1.5 : 2.5;

  // Scaling effect
  let syncedScale;
  if (state.currentMorph && state.morphProgress < 1.0) {
    const morphPhase = state.morphProgress;
    let scaleVariation;

    if (morphPhase < 0.8) {
      scaleVariation = 0.015 + Math.sin(state.animationTime * 4) * 0.005;
    } else {
      const bouncePhase = (morphPhase - 0.8) / 0.2;
      scaleVariation = 0.015 + Math.sin(bouncePhase * Math.PI) * 0.025;
    }
    syncedScale = baseScale + scaleVariation;
  } else {
    syncedScale = baseScale + Math.sin(state.animationTime * 1.2) * 0.05;
  }
  ctx.scale(syncedScale, syncedScale);

  // Pulse effect
  if (state.currentMorph && state.morphProgress < 1.0) {
    state.pulseValue = 0.8 + state.morphProgress * 0.2;
  } else {
    state.pulseValue = 0.7 + Math.sin(state.animationTime * 3) * 0.2;
  }
};

/**
 * Generate a randomized shape order via Fisher-Yates shuffle.
 * @param {number} shapeCount
 * @returns {number[]}
 */
const generateRandomShapeOrder = (shapeCount) => {
  const indices = Array.from({ length: shapeCount }, (_, i) => i);
  // Fisher-Yates shuffle algorithm
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
};

/**
 * Start the requestAnimationFrame morph loop.
 * @param {Object} opts
 * @param {CanvasRenderingContext2D} opts.ctx
 * @param {Function} opts.Morph - Morph class constructor
 * @param {Object} opts.state - animationState.current
 * @param {Object} opts.animationRef - ref holding the rAF handle
 * @param {Function} opts.drawMorphedShape - (ctx) => void
 * @param {Function} opts.drawCurrentShape - (ctx) => void
 */
export const startAnimation = ({ ctx, Morph, state, animationRef, drawMorphedShape, drawCurrentShape }) => {
  if (state.isAnimating) return;

  state.isAnimating = true;

  // Initialize random shape order if not already set
  if (state.shapeOrder.length === 0) {
    state.shapeOrder = generateRandomShapeOrder(state.morphShapes.length);
    state.currentShapeIndex = 0;
    state.nextShapeIndex = 1;
  }

  const animate = () => {
    if (!state.isAnimating) return;

    // Handle morphing
    if (!state.currentMorph && state.morphShapes.length > 0) {
      const currentIndex = state.shapeOrder[state.currentShapeIndex];
      const nextIndex = state.shapeOrder[state.nextShapeIndex];
      const startShape = state.morphShapes[currentIndex];
      const endShape = state.morphShapes[nextIndex];
      state.currentMorph = new Morph(startShape, endShape);
    }

    if (state.currentMorph) {
      // Update morph progress with Material 3 timing
      let morphIncrement;
      if (state.morphProgress < 0.8) {
        morphIncrement = 0.03;
      } else {
        const easeOutFactor = 1 - (state.morphProgress - 0.8) / 0.2;
        morphIncrement = 0.03 * easeOutFactor;
        morphIncrement = Math.max(morphIncrement, 0.001);
      }
      state.morphProgress += morphIncrement;

      if (state.morphProgress >= 1.0) {
        // Move to next shape pair in random order
        state.morphProgress = 0;
        state.currentShapeIndex = state.nextShapeIndex;
        state.nextShapeIndex = (state.nextShapeIndex + 1) % state.shapeOrder.length;

        // If we've completed a full cycle, generate new random order
        if (state.nextShapeIndex === 0) {
          state.shapeOrder = generateRandomShapeOrder(state.morphShapes.length);
          state.currentShapeIndex = 0;
          state.nextShapeIndex = 1;
        }

        // Create new morph for the next transition
        const currentIndex = state.shapeOrder[state.currentShapeIndex];
        const nextIndex = state.shapeOrder[state.nextShapeIndex];
        const startShape = state.morphShapes[currentIndex];
        const endShape = state.morphShapes[nextIndex];
        state.currentMorph = new Morph(startShape, endShape);
      }

      drawMorphedShape(ctx);
    } else {
      drawCurrentShape(ctx);
    }

    animationRef.current = requestAnimationFrame(animate);
  };

  animate();
};

/**
 * Dynamically load the geometry modules, build the 38 shapes, and kick off animation.
 * @param {Object} opts
 * @param {CanvasRenderingContext2D} opts.ctx
 * @param {Object} opts.state - animationState.current
 * @param {Function} opts.setIsLoaded - React setter
 * @param {Function} opts.runAnimation - ({ ctx, Morph }) => void
 */
export const initializeAnimation = async ({ ctx, state, setIsLoaded, runAnimation }) => {
  try {
    // Load the REAL modules dynamically
    const [, , { RoundedPolygon }, { Morph }] = await Promise.all([
      import('./utils.js'),
      import('./cubic.js'),
      import('./roundedPolygon.js'),
      import('./morph-fixed.js')
    ]);

    // Create refined collection of 38 diverse shapes!
    const shapes = [];
    for (let i = 0; i < 38; i++) {
      shapes.push(createFallbackShape(i, RoundedPolygon));
    }
    state.morphShapes = shapes;
    setIsLoaded(true);
    runAnimation({ ctx, Morph });
  } catch (error) {
    console.error('❌ Failed to load REAL animation modules:', error);
    setIsLoaded(false);
  }
};
