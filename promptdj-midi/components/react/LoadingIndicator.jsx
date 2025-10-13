import React, { useEffect, useRef, useState, useCallback } from 'react';
import './LoadingIndicator.css';

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
        import('./LoadingIndicator/utils.js'),
        import('./LoadingIndicator/cubic.js'),
        import('./LoadingIndicator/roundedPolygon.js'),
        import('./LoadingIndicator/morph-fixed.js')
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







  // Refined collection of creative shapes - WITH PROPER ROUNDING!
  const createFallbackShape = (index, RoundedPolygon) => {
    switch (index) {
      case 0: return new RoundedPolygon(new Float32Array([0, -20, 17, 10, -17, 10]), 6); // Triangle
      case 1: return new RoundedPolygon(new Float32Array([-15, -15, 15, -15, 15, 15, -15, 15]), 8); // Square
      case 2: return new RoundedPolygon(new Float32Array([0, -17, 16, -5, 10, 14, -10, 14, -16, -5]), 5); // Pentagon
      case 3: return createStarPolygon(15, 5, RoundedPolygon); // 5-pointed Star
      case 4: return new RoundedPolygon(new Float32Array([20, 0, 10, 17, -10, 17, -20, 0, -10, -17, 10, -17]), 4); // Hexagon
      case 5: return createCirclePolygon(15, 8, RoundedPolygon); // Octagon
      case 6: return createStarPolygon(18, 6, RoundedPolygon); // 6-pointed Star
      case 7: return createDiamondShape(18, RoundedPolygon); // Diamond
      case 8: return createCrossShape(16, RoundedPolygon); // Cross/Plus
      case 9: return createArrowShape(18, RoundedPolygon); // Arrow
      case 10: return createStarPolygon(14, 4, RoundedPolygon); // 4-pointed Star
      case 11: return createOvalShape(18, 12, RoundedPolygon); // Oval (improved)
      case 12: return createTearDropShape(16, RoundedPolygon); // Teardrop (improved)
      case 13: return createMoonShape(16, RoundedPolygon); // Crescent Moon
      case 14: return createFlowerShape(15, RoundedPolygon); // Flower
      case 15: return createHouseShape(16, RoundedPolygon); // House
      case 16: return createSpadeShape(16, RoundedPolygon); // Spade (improved)
      case 17: return createInfinityShape(18, RoundedPolygon); // Infinity (improved)
      case 18: return createGearShape(16, RoundedPolygon); // Gear/Cog
      case 19: return createSunShape(17, RoundedPolygon); // Sun
      case 20: return createBoltShape(18, RoundedPolygon); // Bolt/Screw
      case 21: return createWaveShape(20, RoundedPolygon); // Wave
      case 22: return createRingShape(16, RoundedPolygon); // Ring/Donut (fixed)
      case 23: return createPillShape(18, RoundedPolygon); // Pill/Capsule
      case 24: return createBoneShape(18, RoundedPolygon); // Bone
      case 25: return createMountainShape(14, RoundedPolygon); // Mountain
      case 26: return createFishShape(18, RoundedPolygon); // Fish
      case 27: return createTreeShape(17, RoundedPolygon); // Tree
      case 28: return createCactusShape(15, RoundedPolygon); // Cactus
      case 29: return createCupShape(15, RoundedPolygon); // Cup (wider bottom)
      case 30: return createBottleShape(14, RoundedPolygon); // Bottle
      case 31: return createBookShape(16, RoundedPolygon); // Book
      case 32: return createPhoneShape(14, RoundedPolygon); // Phone
      case 33: return createCameraShape(16, RoundedPolygon); // Camera
      case 34: return createPuzzlePieceShape(16, RoundedPolygon); // Puzzle Piece (simplified)
      case 35: return createAnchorShape(16, RoundedPolygon); // Anchor
      case 36: return createCrownShape(17, RoundedPolygon); // Crown
      case 37: return createStarPolygon(12, 8, RoundedPolygon); // 8-pointed Star
      default: return createCirclePolygon(15, 8, RoundedPolygon);
    }
  };

  const createCirclePolygon = (radius, sides, RoundedPolygon) => {
    const vertices = new Float32Array(sides * 2);
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * 2 * Math.PI;
      vertices[i * 2] = Math.cos(angle) * radius;
      vertices[i * 2 + 1] = Math.sin(angle) * radius;
    }
    return new RoundedPolygon(vertices, 3); // 3px rounding for smooth circle
  };

  const createStarPolygon = (radius, points, RoundedPolygon) => {
    const vertices = new Float32Array(points * 4);
    const innerRadius = radius * 0.4;
    let vertexIndex = 0;

    for (let i = 0; i < points; i++) {
      const outerAngle = (i / points) * 2 * Math.PI - Math.PI / 2;
      vertices[vertexIndex++] = Math.cos(outerAngle) * radius;
      vertices[vertexIndex++] = Math.sin(outerAngle) * radius;

      const innerAngle = ((i + 0.5) / points) * 2 * Math.PI - Math.PI / 2;
      vertices[vertexIndex++] = Math.cos(innerAngle) * innerRadius;
      vertices[vertexIndex++] = Math.sin(innerAngle) * innerRadius;
    }
    return new RoundedPolygon(vertices, 2); // 2px rounding for smooth star points
  };

  const createDiamondShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([0, -size, size, 0, 0, size, -size, 0]);
    return new RoundedPolygon(vertices, 4);
  };

  const createCrossShape = (size, RoundedPolygon) => {
    const thickness = size * 0.3;
    const vertices = new Float32Array([
      -thickness, -size, thickness, -size, thickness, -thickness,
      size, -thickness, size, thickness, thickness, thickness,
      thickness, size, -thickness, size, -thickness, thickness,
      -size, thickness, -size, -thickness, -thickness, -thickness
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createArrowShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      0, -size, size * 0.5, -size * 0.3, size * 0.2, -size * 0.3,
      size * 0.2, size, -size * 0.2, size, -size * 0.2, -size * 0.3,
      -size * 0.5, -size * 0.3
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createOvalShape = (width, height, RoundedPolygon) => {
    const sides = 24; // More sides for smoother oval
    const vertices = new Float32Array(sides * 2);
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * 2 * Math.PI;
      vertices[i * 2] = Math.cos(angle) * width;
      vertices[i * 2 + 1] = Math.sin(angle) * height;
    }
    return new RoundedPolygon(vertices, 1); // Less rounding for smoother curves
  };

  const createTearDropShape = (size, RoundedPolygon) => {
    // Realistic teardrop shape with smooth curves
    const vertices = new Float32Array([
      0, -size, // Sharp point at top
      size * 0.5, -size * 0.6, // Right side curve
      size * 0.8, -size * 0.1, // Right bulge
      size * 0.9, size * 0.3, // Right bottom
      size * 0.6, size * 0.7, // Right bottom curve
      size * 0.2, size * 0.9, // Bottom right
      0, size, // Bottom center
      -size * 0.2, size * 0.9, // Bottom left
      -size * 0.6, size * 0.7, // Left bottom curve
      -size * 0.9, size * 0.3, // Left bottom
      -size * 0.8, -size * 0.1, // Left bulge
      -size * 0.5, -size * 0.6 // Left side curve
    ]);
    return new RoundedPolygon(vertices, 6); // Higher rounding for smooth teardrop
  };

  const createMoonShape = (size, RoundedPolygon) => {
    // Crescent moon approximation
    const vertices = new Float32Array([
      size * 0.5, -size * 0.8, size * 0.8, -size * 0.3, size * 0.6, 0,
      size * 0.8, size * 0.3, size * 0.5, size * 0.8, 0, size * 0.5,
      -size * 0.3, size * 0.2, -size * 0.5, 0, -size * 0.3, -size * 0.2,
      0, -size * 0.5
    ]);
    return new RoundedPolygon(vertices, 5);
  };

  const createFlowerShape = (size, RoundedPolygon) => {
    // 8-petal flower
    const petals = 8;
    const vertices = new Float32Array(petals * 4);
    let vertexIndex = 0;

    for (let i = 0; i < petals; i++) {
      const angle = (i / petals) * 2 * Math.PI;
      const petalTipX = Math.cos(angle) * size;
      const petalTipY = Math.sin(angle) * size;
      const petalBaseX = Math.cos(angle) * size * 0.3;
      const petalBaseY = Math.sin(angle) * size * 0.3;

      vertices[vertexIndex++] = petalTipX;
      vertices[vertexIndex++] = petalTipY;
      vertices[vertexIndex++] = petalBaseX;
      vertices[vertexIndex++] = petalBaseY;
    }
    return new RoundedPolygon(vertices, 6);
  };

  const createHouseShape = (size, RoundedPolygon) => {
    // Simple house silhouette
    const vertices = new Float32Array([
      0, -size, size * 0.7, -size * 0.3, size * 0.7, size * 0.2,
      size * 0.7, size * 0.8, -size * 0.7, size * 0.8, -size * 0.7, size * 0.2,
      -size * 0.7, -size * 0.3
    ]);
    return new RoundedPolygon(vertices, 5);
  };

  const createSpadeShape = (size, RoundedPolygon) => {
    // Smooth spade card suit
    const vertices = new Float32Array([
      0, -size, // Top point
      size * 0.4, -size * 0.6, // Right top curve
      size * 0.7, -size * 0.2, // Right side
      size * 0.8, size * 0.1, // Right bulge
      size * 0.6, size * 0.4, // Right bottom curve
      size * 0.3, size * 0.5, // Right stem connection
      size * 0.25, size * 0.7, // Right stem
      size * 0.15, size * 0.9, // Right stem bottom
      0, size, // Bottom center
      -size * 0.15, size * 0.9, // Left stem bottom
      -size * 0.25, size * 0.7, // Left stem
      -size * 0.3, size * 0.5, // Left stem connection
      -size * 0.6, size * 0.4, // Left bottom curve
      -size * 0.8, size * 0.1, // Left bulge
      -size * 0.7, -size * 0.2, // Left side
      -size * 0.4, -size * 0.6 // Left top curve
    ]);
    return new RoundedPolygon(vertices, 5); // Higher rounding for smooth curves
  };



  const createInfinityShape = (size, RoundedPolygon) => {
    // Smooth infinity symbol (figure-8) with more natural curves
    const vertices = new Float32Array([
      -size * 0.9, 0, // Left outer point
      -size * 0.7, -size * 0.3, // Left top curve
      -size * 0.4, -size * 0.4, // Left top inner
      -size * 0.1, -size * 0.3, // Center top left
      0, 0, // Center crossing
      size * 0.1, -size * 0.3, // Center top right
      size * 0.4, -size * 0.4, // Right top inner
      size * 0.7, -size * 0.3, // Right top curve
      size * 0.9, 0, // Right outer point
      size * 0.7, size * 0.3, // Right bottom curve
      size * 0.4, size * 0.4, // Right bottom inner
      size * 0.1, size * 0.3, // Center bottom right
      0, 0, // Center crossing (duplicate for smooth path)
      -size * 0.1, size * 0.3, // Center bottom left
      -size * 0.4, size * 0.4, // Left bottom inner
      -size * 0.7, size * 0.3 // Left bottom curve
    ]);
    return new RoundedPolygon(vertices, 8); // High rounding for smooth infinity curves
  };

  const createGearShape = (size, RoundedPolygon) => {
    // Gear with 8 teeth
    const teeth = 8;
    const innerRadius = size * 0.6;
    const outerRadius = size;
    const vertices = new Float32Array(teeth * 4);
    let vertexIndex = 0;

    for (let i = 0; i < teeth; i++) {
      const baseAngle = (i / teeth) * 2 * Math.PI;
      const toothAngle = ((i + 0.5) / teeth) * 2 * Math.PI;

      // Inner point
      vertices[vertexIndex++] = Math.cos(baseAngle) * innerRadius;
      vertices[vertexIndex++] = Math.sin(baseAngle) * innerRadius;

      // Outer tooth point
      vertices[vertexIndex++] = Math.cos(toothAngle) * outerRadius;
      vertices[vertexIndex++] = Math.sin(toothAngle) * outerRadius;
    }
    return new RoundedPolygon(vertices, 2);
  };

  const createSunShape = (size, RoundedPolygon) => {
    const rays = 12;
    const innerRadius = size * 0.5;
    const outerRadius = size;
    const vertices = new Float32Array(rays * 4);
    let vertexIndex = 0;

    for (let i = 0; i < rays; i++) {
      const baseAngle = (i / rays) * 2 * Math.PI;
      const rayAngle = ((i + 0.5) / rays) * 2 * Math.PI;

      vertices[vertexIndex++] = Math.cos(baseAngle) * innerRadius;
      vertices[vertexIndex++] = Math.sin(baseAngle) * innerRadius;

      vertices[vertexIndex++] = Math.cos(rayAngle) * outerRadius;
      vertices[vertexIndex++] = Math.sin(rayAngle) * outerRadius;
    }
    return new RoundedPolygon(vertices, 4);
  };



  const createBoltShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      0, -size, // Top
      size * 0.3, -size * 0.7, // Top right
      size * 0.2, -size * 0.3, // Upper body
      size * 0.4, -size * 0.1, // Thread start
      size * 0.2, size * 0.1, // Thread
      size * 0.4, size * 0.3, // Thread
      size * 0.2, size * 0.5, // Thread
      size * 0.4, size * 0.7, // Thread end
      size * 0.2, size, // Bottom right
      -size * 0.2, size, // Bottom left
      -size * 0.4, size * 0.7, // Thread end
      -size * 0.2, size * 0.5, // Thread
      -size * 0.4, size * 0.3, // Thread
      -size * 0.2, size * 0.1, // Thread
      -size * 0.4, -size * 0.1, // Thread start
      -size * 0.2, -size * 0.3, // Upper body
      -size * 0.3, -size * 0.7 // Top left
    ]);
    return new RoundedPolygon(vertices, 2);
  };

  const createLeafShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      0, -size, // Tip
      size * 0.3, -size * 0.7, // Right upper
      size * 0.6, -size * 0.3, // Right side
      size * 0.8, size * 0.1, // Right bulge
      size * 0.6, size * 0.5, // Right lower
      size * 0.2, size * 0.8, // Right bottom
      0, size, // Bottom point
      -size * 0.2, size * 0.8, // Left bottom
      -size * 0.6, size * 0.5, // Left lower
      -size * 0.8, size * 0.1, // Left bulge
      -size * 0.6, -size * 0.3, // Left side
      -size * 0.3, -size * 0.7 // Left upper
    ]);
    return new RoundedPolygon(vertices, 5);
  };

  const createEyeShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.9, 0, // Left corner
      -size * 0.6, -size * 0.4, // Left top
      -size * 0.2, -size * 0.6, // Upper left
      size * 0.2, -size * 0.6, // Upper right
      size * 0.6, -size * 0.4, // Right top
      size * 0.9, 0, // Right corner
      size * 0.6, size * 0.4, // Right bottom
      size * 0.2, size * 0.6, // Lower right
      -size * 0.2, size * 0.6, // Lower left
      -size * 0.6, size * 0.4 // Left bottom
    ]);
    return new RoundedPolygon(vertices, 6);
  };

  const createWaveShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size, 0, // Start
      -size * 0.7, -size * 0.5, // First peak
      -size * 0.3, -size * 0.3, // First valley
      0, -size * 0.6, // Middle peak
      size * 0.3, -size * 0.3, // Second valley
      size * 0.7, -size * 0.5, // Second peak
      size, 0, // End
      size * 0.7, size * 0.5, // Return peak
      size * 0.3, size * 0.3, // Return valley
      0, size * 0.6, // Return middle
      -size * 0.3, size * 0.3, // Return valley
      -size * 0.7, size * 0.5 // Return peak
    ]);
    return new RoundedPolygon(vertices, 7);
  };

  const createRingShape = (size, RoundedPolygon) => {
    const outerSides = 20;
    const innerSides = 16;
    const outerRadius = size;
    const innerRadius = size * 0.4;
    const vertices = new Float32Array((outerSides + innerSides) * 2);
    let vertexIndex = 0;

    // Outer ring - smooth circle
    for (let i = 0; i < outerSides; i++) {
      const angle = (i / outerSides) * 2 * Math.PI;
      vertices[vertexIndex++] = Math.cos(angle) * outerRadius;
      vertices[vertexIndex++] = Math.sin(angle) * outerRadius;
    }

    // Inner ring - smooth circle (reverse direction for proper hole)
    for (let i = innerSides - 1; i >= 0; i--) {
      const angle = (i / innerSides) * 2 * Math.PI;
      vertices[vertexIndex++] = Math.cos(angle) * innerRadius;
      vertices[vertexIndex++] = Math.sin(angle) * innerRadius;
    }

    return new RoundedPolygon(vertices, 2);
  };

  const createCrescentShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      size * 0.6, -size * 0.8, // Top outer
      size * 0.9, -size * 0.3, // Right outer
      size * 0.8, 0, // Right middle
      size * 0.9, size * 0.3, // Right outer bottom
      size * 0.6, size * 0.8, // Bottom outer
      size * 0.2, size * 0.6, // Inner bottom
      0, size * 0.3, // Inner right
      -size * 0.2, 0, // Inner middle
      0, -size * 0.3, // Inner left
      size * 0.2, -size * 0.6 // Inner top
    ]);
    return new RoundedPolygon(vertices, 6);
  };

  const createPillShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.5, -size, // Top left
      size * 0.5, -size, // Top right
      size, -size * 0.5, // Right top curve
      size, size * 0.5, // Right bottom curve
      size * 0.5, size, // Bottom right
      -size * 0.5, size, // Bottom left
      -size, size * 0.5, // Left bottom curve
      -size, -size * 0.5 // Left top curve
    ]);
    return new RoundedPolygon(vertices, 8);
  };

  const createBoneShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, -size * 0.3, // Left top
      -size * 0.6, -size * 0.6, // Left top bulge
      -size * 0.3, -size * 0.4, // Left neck
      -size * 0.1, -size * 0.2, // Center left
      size * 0.1, -size * 0.2, // Center right
      size * 0.3, -size * 0.4, // Right neck
      size * 0.6, -size * 0.6, // Right top bulge
      size * 0.8, -size * 0.3, // Right top
      size * 0.8, size * 0.3, // Right bottom
      size * 0.6, size * 0.6, // Right bottom bulge
      size * 0.3, size * 0.4, // Right neck
      size * 0.1, size * 0.2, // Center right
      -size * 0.1, size * 0.2, // Center left
      -size * 0.3, size * 0.4, // Left neck
      -size * 0.6, size * 0.6, // Left bottom bulge
      -size * 0.8, size * 0.3 // Left bottom
    ]);
    return new RoundedPolygon(vertices, 4);
  };

  const createKeyShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, -size * 0.2, // Handle left
      -size * 0.8, size * 0.2, // Handle left bottom
      -size * 0.2, size * 0.2, // Handle right bottom
      -size * 0.2, size * 0.1, // Shaft start
      size * 0.6, size * 0.1, // Shaft end
      size * 0.8, size * 0.3, // Tooth 1
      size * 0.9, size * 0.1, // Tooth 1 end
      size * 0.9, -size * 0.1, // Tooth 2 start
      size * 0.8, -size * 0.3, // Tooth 2
      size * 0.6, -size * 0.1, // Shaft end top
      -size * 0.2, -size * 0.1, // Shaft start top
      -size * 0.2, -size * 0.2 // Handle right top
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createLockShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.6, -size * 0.2, // Body left
      -size * 0.6, size * 0.8, // Body left bottom
      size * 0.6, size * 0.8, // Body right bottom
      size * 0.6, -size * 0.2, // Body right
      size * 0.4, -size * 0.2, // Shackle right bottom
      size * 0.4, -size * 0.6, // Shackle right
      size * 0.2, -size * 0.8, // Shackle right top
      -size * 0.2, -size * 0.8, // Shackle left top
      -size * 0.4, -size * 0.6, // Shackle left
      -size * 0.4, -size * 0.2 // Shackle left bottom
    ]);
    return new RoundedPolygon(vertices, 4);
  };



  const createMountainShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size, size, // Left base
      -size * 0.6, size * 0.2, // Left slope
      -size * 0.3, -size * 0.8, // Left peak
      0, -size * 0.4, // Center valley
      size * 0.3, -size, // Right peak
      size * 0.6, size * 0.2, // Right slope
      size, size // Right base
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createFishShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size, 0, // Tail center
      -size * 0.7, -size * 0.3, // Tail top
      -size * 0.4, -size * 0.2, // Body start top
      size * 0.2, -size * 0.4, // Body top
      size * 0.8, -size * 0.2, // Head top
      size, 0, // Nose
      size * 0.8, size * 0.2, // Head bottom
      size * 0.2, size * 0.4, // Body bottom
      -size * 0.4, size * 0.2, // Body start bottom
      -size * 0.7, size * 0.3 // Tail bottom
    ]);
    return new RoundedPolygon(vertices, 4);
  };

  const createBirdShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, size * 0.2, // Tail
      -size * 0.4, 0, // Body back
      -size * 0.2, -size * 0.3, // Body top
      size * 0.2, -size * 0.4, // Neck
      size * 0.6, -size * 0.2, // Head back
      size * 0.9, -size * 0.1, // Beak top
      size, 0, // Beak tip
      size * 0.9, size * 0.1, // Beak bottom
      size * 0.6, size * 0.2, // Head bottom
      size * 0.2, size * 0.4, // Neck bottom
      -size * 0.2, size * 0.5, // Body bottom
      -size * 0.6, size * 0.4 // Wing
    ]);
    return new RoundedPolygon(vertices, 4);
  };

  const createTreeShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.1, size, // Trunk left bottom
      -size * 0.1, size * 0.3, // Trunk left top
      -size * 0.6, size * 0.2, // Leaves left
      -size * 0.7, -size * 0.2, // Leaves left top
      -size * 0.3, -size * 0.8, // Leaves top left
      0, -size, // Leaves top center
      size * 0.3, -size * 0.8, // Leaves top right
      size * 0.7, -size * 0.2, // Leaves right top
      size * 0.6, size * 0.2, // Leaves right
      size * 0.1, size * 0.3, // Trunk right top
      size * 0.1, size // Trunk right bottom
    ]);
    return new RoundedPolygon(vertices, 5);
  };

  // Create remaining shapes (simplified versions for performance)
  const createCactusShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.2, size, -size * 0.2, -size * 0.2, -size * 0.6, -size * 0.4,
      -size * 0.6, -size * 0.8, -size * 0.4, -size * 0.8, -size * 0.4, -size * 0.4,
      -size * 0.1, -size * 0.4, -size * 0.1, -size, size * 0.1, -size,
      size * 0.1, -size * 0.4, size * 0.4, -size * 0.4, size * 0.4, -size * 0.8,
      size * 0.6, -size * 0.8, size * 0.6, -size * 0.4, size * 0.2, -size * 0.2,
      size * 0.2, size
    ]);
    return new RoundedPolygon(vertices, 4);
  };



  const createCupShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.4, -size, // Top left (narrower)
      size * 0.4, -size, // Top right (narrower)
      size * 0.8, size * 0.8, // Bottom right (much wider)
      -size * 0.8, size * 0.8 // Bottom left (much wider)
    ]);
    return new RoundedPolygon(vertices, 6);
  };

  const createBottleShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.2, -size, size * 0.2, -size, size * 0.2, -size * 0.7,
      size * 0.4, -size * 0.7, size * 0.4, size * 0.8, -size * 0.4, size * 0.8,
      -size * 0.4, -size * 0.7, -size * 0.2, -size * 0.7
    ]);
    return new RoundedPolygon(vertices, 4);
  };

  const createBookShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, -size * 0.6, size * 0.8, -size * 0.6, size * 0.8, size * 0.6,
      -size * 0.8, size * 0.6
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createPhoneShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.4, -size, size * 0.4, -size, size * 0.4, size,
      -size * 0.4, size
    ]);
    return new RoundedPolygon(vertices, 8);
  };



  const createCameraShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, -size * 0.2, size * 0.8, -size * 0.2, size * 0.8, size * 0.6,
      -size * 0.8, size * 0.6
    ]);
    return new RoundedPolygon(vertices, 3);
  };



  const createPuzzlePieceShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      // Main square outline with one corner cut out
      -size * 0.8, -size * 0.8, // Top left
      size * 0.8, -size * 0.8, // Top right
      size * 0.8, 0, // Right middle
      0, 0, // Center (cut corner start)
      0, size * 0.8, // Bottom middle
      -size * 0.8, size * 0.8, // Bottom left
      -size * 0.8, -size * 0.8 // Back to start
    ]);
    return new RoundedPolygon(vertices, 4);
  };



  const createRocketShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      0, -size, size * 0.3, -size * 0.6, size * 0.3, size * 0.4,
      size * 0.6, size * 0.8, -size * 0.6, size * 0.8, -size * 0.3, size * 0.4,
      -size * 0.3, -size * 0.6
    ]);
    return new RoundedPolygon(vertices, 4);
  };

  const createAnchorShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      0, -size, size * 0.2, -size * 0.6, size * 0.2, 0,
      size * 0.6, size * 0.4, size * 0.8, size * 0.8, size * 0.4, size * 0.6,
      size * 0.2, size * 0.2, -size * 0.2, size * 0.2, -size * 0.4, size * 0.6,
      -size * 0.8, size * 0.8, -size * 0.6, size * 0.4, -size * 0.2, 0,
      -size * 0.2, -size * 0.6
    ]);
    return new RoundedPolygon(vertices, 3);
  };

  const createCrownShape = (size, RoundedPolygon) => {
    const vertices = new Float32Array([
      -size * 0.8, size * 0.2, -size * 0.6, -size * 0.4, -size * 0.3, size * 0.2,
      0, -size * 0.8, size * 0.3, size * 0.2, size * 0.6, -size * 0.4,
      size * 0.8, size * 0.2, size * 0.8, size * 0.6, -size * 0.8, size * 0.6
    ]);
    return new RoundedPolygon(vertices, 4);
  };

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