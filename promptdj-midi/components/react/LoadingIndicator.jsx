import React, { useEffect, useRef, useState, useCallback } from 'react';
import './LoadingIndicator.css';
// The shape-morph geometry is shared with the main app; PromptDJ keeps only this component.
import { createFallbackShape } from '../../../src/components/common/LoadingIndicator/shapeFactory.js';

/**
 * Material Design 3 Expressive Loading Indicator
 * A sophisticated loading animation with REAL morphing shapes from Figma design
 * 
 * @param {Object} props
 * @param {string} props.theme - 'light' or 'dark' (default: 'dark')
 * @param {boolean} props.showContainer - Whether to show the background container (default: true)
 * @param {number} props.size - Size in pixels (default: 48)
 * @param {string} props.className - Additional CSS classes
 * @param {Object} [props.style] - Additional inline styles
 * @param {string} [props.color] - Optional override for the shape color (fills). If provided, supersedes theme-based color.
 * @param {string} [props.containerColor] - Optional override for the container color when showContainer is true.
 */
const LoadingIndicator = ({
  theme = 'dark',
  showContainer = true,
  size = 48,
  className = '',
  style = {},
  color,
  containerColor
}) => {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const [isLoaded, setIsLoaded] = useState(false);

  // Colors from Figma design - all 4 variants
  const COLORS = {
    // Container colors
    containerDark: '#2E4578',
    containerLight: '#ADC3FE',

    // Shape colors
    shapeDarkWithContainer: '#D9E2FF',
    shapeDarkNoContainer: '#485E92', // Dark color for dark theme
    shapeLightWithContainer: '#324574',
    shapeLightNoContainer: '#B0C6FF' // Light color for light theme
  };

  // Animation state
  const animationState = useRef({
    currentStep: 1,
    morphShapes: [],
    currentMorph: null,
    morphProgress: 0,
    rotationAngle: 0,
    pulseValue: 1,
    animationTime: 0,
    discreteSpinSpeed: 0,
    isAnimating: false,
    currentShapeIndex: 0,
    nextShapeIndex: 1,
    shapeOrder: []
  });

  // Get the appropriate shape color based on theme and container (with override)
  const getShapeColor = useCallback(() => {
    if (color) return color;
    const isDarkMode = theme === 'dark';
    if (isDarkMode) {
      return showContainer ? COLORS.shapeDarkWithContainer : COLORS.shapeDarkNoContainer;
    } else {
      return showContainer ? COLORS.shapeLightWithContainer : COLORS.shapeLightNoContainer;
    }
  }, [theme, showContainer, COLORS, color]);



  const drawMaterial3Container = useCallback((ctx) => {
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
  }, [showContainer, theme, COLORS, size]);



  const applyMaterial3ExpressiveEffects = useCallback((ctx) => {
    const state = animationState.current;
    
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
  }, [size]); // Add size to dependency array

  const drawPolygonWithEffects = useCallback((polygon, ctx) => {
    const color = getShapeColor();
    drawPolygon(polygon, color, ctx);
  }, [getShapeColor]);

  const drawCubicsWithEffects = useCallback((cubics, ctx) => {
    const color = getShapeColor();
    drawCubics(cubics, color, ctx);
  }, [getShapeColor]);

  const drawCurrentShape = useCallback((ctx) => {
    const state = animationState.current;

    // Use dynamic canvas size based on component size with larger scaling to prevent clipping
    const scaleFactor = size <= 24 ? 3.0 : size <= 48 ? 2.5 : 2.2;
    const canvasSize = Math.round(size * scaleFactor);
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // Only draw container if showContainer is true
    if (showContainer) {
      drawMaterial3Container(ctx);
    }

    ctx.save();
    ctx.translate(canvasSize / 2, canvasSize / 2);
    applyMaterial3ExpressiveEffects(ctx);

    // Use random shape order if available, otherwise fall back to sequential
    const shapeIndex = state.shapeOrder.length > 0
      ? state.shapeOrder[state.currentShapeIndex]
      : state.currentStep - 1;
    const shape = state.morphShapes[shapeIndex];
    if (shape) {
      drawPolygonWithEffects(shape, ctx);
    }

    ctx.restore();
  }, [drawMaterial3Container, applyMaterial3ExpressiveEffects, drawPolygonWithEffects, size, showContainer]);

  const drawMorphedShape = useCallback((ctx) => {
    const state = animationState.current;

    // Use dynamic canvas size based on component size with larger scaling to prevent clipping
    const scaleFactor = size <= 24 ? 3.0 : size <= 48 ? 2.5 : 2.2;
    const canvasSize = Math.round(size * scaleFactor);
    ctx.clearRect(0, 0, canvasSize, canvasSize);

    // Only draw container if showContainer is true
    if (showContainer) {
      drawMaterial3Container(ctx);
    }

    ctx.save();
    ctx.translate(canvasSize / 2, canvasSize / 2);
    applyMaterial3ExpressiveEffects(ctx);

    if (state.currentMorph) {
      try {
        const morphedCubics = state.currentMorph.asCubics(state.morphProgress);
        drawCubicsWithEffects(morphedCubics, ctx);
      } catch (error) {
        // Fallback to current shape if morphing fails
        const shape = state.morphShapes[state.currentStep - 1];
        if (shape) {
          drawPolygonWithEffects(shape, ctx);
        }
      }
    }

    ctx.restore();
  }, [drawMaterial3Container, applyMaterial3ExpressiveEffects, drawCubicsWithEffects, drawPolygonWithEffects, size, showContainer]);

  const drawPolygon = useCallback((polygon, color, ctx) => {
    if (polygon && polygon.cubics) {
      drawCubics(polygon.cubics, color, ctx);
    }
  }, []);

  const drawCubics = useCallback((cubics, color, ctx) => {
    if (!cubics || cubics.length === 0) return;

    ctx.fillStyle = color;
    ctx.beginPath();

    const firstCubic = cubics[0];
    ctx.moveTo(firstCubic.anchor0X, firstCubic.anchor0Y);

    for (const cubic of cubics) {
      ctx.bezierCurveTo(
        cubic.control0X, cubic.control0Y,
        cubic.control1X, cubic.control1Y,
        cubic.anchor1X, cubic.anchor1Y
      );
    }

    ctx.closePath();
    ctx.fill();
  }, []);

  // Generate random shape order
  const generateRandomShapeOrder = useCallback((shapeCount) => {
    const indices = Array.from({ length: shapeCount }, (_, i) => i);
    // Fisher-Yates shuffle algorithm
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  }, []);

  const startAnimation = useCallback((ctx, Morph) => {
    const state = animationState.current;
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
  }, [drawMorphedShape, drawCurrentShape, generateRandomShapeOrder]);

  const initializeAnimation = useCallback(async (ctx) => {
    try {
      // Load the REAL modules dynamically
      const [, , { RoundedPolygon }, { Morph }] = await Promise.all([
        import('../../../src/components/common/LoadingIndicator/utils.js'),
        import('../../../src/components/common/LoadingIndicator/cubic.js'),
        import('../../../src/components/common/LoadingIndicator/roundedPolygon.js'),
        import('../../../src/components/common/LoadingIndicator/morph-fixed.js')
      ]);

      // Create refined collection of 38 diverse shapes!
      const shapes = [];
      for (let i = 0; i < 38; i++) {
        shapes.push(createFallbackShape(i, RoundedPolygon));
      }
      animationState.current.morphShapes = shapes;
      setIsLoaded(true);
      startAnimation(ctx, Morph);
    } catch (error) {
      console.error('❌ Failed to load REAL animation modules:', error);
      setIsLoaded(false);
    }
  }, [startAnimation, size]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;

    // Set canvas internal size based on the display size for proper scaling
    // Use larger scaling for small sizes to prevent clipping
    const scaleFactor = size <= 24 ? 3.0 : size <= 48 ? 2.5 : 2.2;
    const canvasSize = Math.round(size * scaleFactor);
    canvas.width = canvasSize * dpr;
    canvas.height = canvasSize * dpr;
    // Scale for device pixel ratio and fit to display size
    ctx.scale(dpr, dpr);

    // Initialize the REAL animation
    initializeAnimation(ctx);

    return () => {
      const state = animationState.current;
      state.isAnimating = false;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [size, initializeAnimation]);

  // Re-render when theme or container changes
  useEffect(() => {
    if (isLoaded && canvasRef.current) {
      // Trigger a redraw with current state
      const ctx = canvasRef.current.getContext('2d');
      const state = animationState.current;
      if (state.currentMorph) {
        drawMorphedShape(ctx);
      } else {
        drawCurrentShape(ctx);
      }
    }
  }, [theme, showContainer, isLoaded, drawMorphedShape, drawCurrentShape]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const state = animationState.current;
      state.isAnimating = false;
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  return (
    <div
      className={`loading-indicator ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        ...style
      }}
    >
      <canvas
        ref={canvasRef}
        className="loading-indicator-canvas"
        style={{
          width: `${size}px`,  // Display at intended size
          height: `${size}px`,
          borderRadius: '12px'
        }}
      />
    </div>
  );
};

export default LoadingIndicator;
