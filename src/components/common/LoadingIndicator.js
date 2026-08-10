import { useEffect, useRef, useState, useCallback } from 'react';
import './LoadingIndicator.css';
import {
  getShapeColor as resolveShapeColor,
  drawMaterial3Container as drawContainer,
  applyMaterial3ExpressiveEffects as applyEffects,
  startAnimation as runMorphLoop,
  initializeAnimation as loadAndStart
} from './LoadingIndicator/animationState.js';

// Colors from the frozen Figma design - all 4 variants
const COLORS = {
  containerDark: '#2E4578',
  containerLight: '#ADC3FE',
  shapeDarkWithContainer: '#D9E2FF',
  shapeDarkNoContainer: '#485E92',
  shapeLightWithContainer: '#324574',
  shapeLightNoContainer: '#B0C6FF'
};

/**
 * Material Design 3 Expressive Loading Indicator
 * A sophisticated loading animation with REAL morphing shapes from Figma design
 *
 * @param {Object} props
 * @param {string} props.theme - 'light' or 'dark' (default: 'dark')
 * @param {boolean} props.showContainer - Whether to show the background container (default: true)
 * @param {number} props.size - Size in pixels (default: 48)
 * @param {string} props.className - Additional CSS classes
 * @param {Object} props.style - Additional inline styles
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
  const getShapeColor = useCallback(
    () => resolveShapeColor({ theme, showContainer, color, COLORS }),
    [theme, showContainer, color]
  );

  const drawMaterial3Container = useCallback(
    (ctx) => drawContainer(ctx, { showContainer, size, containerColor, theme, COLORS }),
    [showContainer, theme, size, containerColor]
  );

  const applyMaterial3ExpressiveEffects = useCallback(
    (ctx) => applyEffects(ctx, animationState.current, size),
    [size]
  );

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

  const drawPolygon = useCallback((polygon, color, ctx) => {
    if (polygon && polygon.cubics) {
      drawCubics(polygon.cubics, color, ctx);
    }
  }, [drawCubics]);

  const drawPolygonWithEffects = useCallback((polygon, ctx) => {
    const color = getShapeColor();
    drawPolygon(polygon, color, ctx);
  }, [getShapeColor, drawPolygon]);

  const drawCubicsWithEffects = useCallback((cubics, ctx) => {
    const color = getShapeColor();
    drawCubics(cubics, color, ctx);
  }, [getShapeColor, drawCubics]);

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

  const startAnimation = useCallback((ctx, Morph) => {
    runMorphLoop({
      ctx,
      Morph,
      state: animationState.current,
      animationRef,
      drawMorphedShape,
      drawCurrentShape
    });
  }, [drawMorphedShape, drawCurrentShape]);

  const initializeAnimation = useCallback((ctx) => {
    return loadAndStart({
      ctx,
      state: animationState.current,
      setIsLoaded,
      runAnimation: ({ ctx: animCtx, Morph }) => startAnimation(animCtx, Morph)
    });
  }, [startAnimation]);

  const stopAnimation = useCallback(() => {
    animationState.current.isAnimating = false;
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }
  }, []);

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

    return stopAnimation;
  }, [size, initializeAnimation, stopAnimation]);

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
    return stopAnimation;
  }, [stopAnimation]);

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
