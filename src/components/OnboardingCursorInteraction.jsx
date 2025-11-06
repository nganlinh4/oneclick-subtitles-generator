import { useEffect, useRef } from 'react';

// --- Helper Functions (moved outside component for performance) ---

/**
 * Injects CSS into the SVG to enable cursor avoidance via custom properties.
 * This runs only once.
 */
const injectCursorAvoidanceCSS = (svg) => {
  const existingStyle = svg.querySelector('style');
  if (existingStyle && !existingStyle.textContent.includes('--cursor-offset-x')) {
    const cursorCSS = `
      path {
        --cursor-offset-x: 0px;
        --cursor-offset-y: 0px;
      }
      @keyframes fadeInScaleUp {
        from { opacity: 0; transform: scale(0.8) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        to   { opacity: 1; transform: scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
      }
      @keyframes fadeInScaleRotate {
        from { opacity: 0; transform: scale(0.7) rotate(-15deg) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        to   { opacity: 1; transform: scale(1) rotate(0deg) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
      }
      @keyframes gentlePulse {
        0%, 100% { transform: scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        50%      { transform: scale(1.03) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
      }
      @keyframes subtleFloat {
        0%, 100% { transform: translateY(0px) rotate(0deg) scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        25%      { transform: translateY(-1.5px) rotate(-0.7deg) scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        75%      { transform: translateY(1px) rotate(0.5deg) scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
      }
      @keyframes shimmer {
        0%, 100% { opacity: 0.6; transform: scale(1) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
        50%      { opacity: 1; transform: scale(1.08) translate(var(--cursor-offset-x), var(--cursor-offset-y)); }
      }`;
    existingStyle.textContent += cursorCSS;
  }
};

/**
 * Initializes path data, calculating and storing their anchor points.
 * This runs only once.
 */
const initializePaths = (paths, pathDataRef) => {
  paths.forEach(path => {
    const dataIndex = path.getAttribute('data-index');
    if (!dataIndex) return;
    
    // getBBox is a DOM read, so we do it only once at initialization.
    const bbox = path.getBBox();
    const centerX = bbox.x + bbox.width / 2;
    const centerY = bbox.y + bbox.height / 2;

    pathDataRef.current.set(dataIndex, {
      element: path,
      anchorX: centerX,
      anchorY: centerY,
      currentX: centerX,
      currentY: centerY,
      hasEnteredIdle: false, // Track if entrance animation is complete
    });
  });
};


/**
 * OnboardingCursorInteraction - Adds cursor avoidance behavior to SVG paths
 */
const OnboardingCursorInteraction = ({ children, isDismissing }) => {
  const containerRef = useRef(null);
  const pathDataRef = useRef(new Map());
  const mouseRef = useRef({ x: null, y: null, isClicked: false });
  
  // Use a ref to track the latest 'isDismissing' state inside the animation loop
  // without re-triggering the main useEffect.
  const isDismissingRef = useRef(isDismissing);
  useEffect(() => {
    isDismissingRef.current = isDismissing;
  }, [isDismissing]);
  
  // This main effect runs ONLY ONCE on mount for setup and cleanup.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const svg = container.querySelector('svg');
    if (!svg) return;

    const paths = svg.querySelectorAll('path[data-index]');
    if (!paths.length) return;

    let animationFrameId;
    
    // --- One-time Initializations ---
    injectCursorAvoidanceCSS(svg);
    initializePaths(paths, pathDataRef);
    
    // Cache the viewBox to avoid repeated DOM reads in the animation loop
    const viewBox = svg.viewBox.baseVal;
    if (!viewBox || viewBox.width === 0 || viewBox.height === 0) return;

    const applyCursorAvoidance = (containerRect, scaleX, scaleY) => {
      const { x: mouseX, y: mouseY, isClicked } = mouseRef.current;
      if (mouseX === null) return;
      
      const svgMouseX = mouseX * scaleX;
      const svgMouseY = mouseY * scaleY;

      pathDataRef.current.forEach((pathData) => {
        let opacity = 1; // Assume visible unless we need to check
        
        // CRITICAL OPTIMIZATION: Only call getComputedStyle if we haven't confirmed
        // the element is in its idle state yet. This avoids expensive style recalculations.
        if (!pathData.hasEnteredIdle) {
          const computedStyle = window.getComputedStyle(pathData.element);
          opacity = parseFloat(computedStyle.opacity);
          if (opacity >= 0.99) {
            pathData.hasEnteredIdle = true;
          }
        }

        if (opacity > 0.1) {
          const dx = pathData.anchorX - svgMouseX;
          const dy = pathData.anchorY - svgMouseY;
          const distance = Math.sqrt(dx * dx + dy * dy);

          const baseRadius = pathData.hasEnteredIdle ? 100 : 80;
          const interactionRadius = isClicked ? baseRadius * 1.5 : baseRadius;

          if (distance < interactionRadius) {
            const forceFactor = isClicked ? 2.5 : 1.8;
            const force = Math.pow((interactionRadius - distance) / interactionRadius, forceFactor);
            const angle = Math.atan2(dy, dx);
            const maxOffset = isClicked ? 40 : 25;
            const offsetX = Math.cos(angle) * force * maxOffset;
            const offsetY = Math.sin(angle) * force * maxOffset;
            pathData.currentX = pathData.anchorX + offsetX;
            pathData.currentY = pathData.anchorY + offsetY;
          } else {
            const returnSpeed = 0.1;
            pathData.currentX += (pathData.anchorX - pathData.currentX) * returnSpeed;
            pathData.currentY += (pathData.anchorY - pathData.currentY) * returnSpeed;
          }

          const translateX = pathData.currentX - pathData.anchorX;
          const translateY = pathData.currentY - pathData.anchorY;
          
          pathData.element.style.setProperty('--cursor-offset-x', `${translateX}px`);
          pathData.element.style.setProperty('--cursor-offset-y', `${translateY}px`);
        }
      });
    };

    const applyDismissalPositions = () => {
      pathDataRef.current.forEach((pathData) => {
        const currentOffsetX = pathData.currentX - pathData.anchorX;
        const currentOffsetY = pathData.currentY - pathData.anchorY;
        pathData.element.style.setProperty('--dismissal-start-x', `${currentOffsetX}px`);
        pathData.element.style.setProperty('--dismissal-start-y', `${currentOffsetY}px`);
      });
    };

    const animate = () => {
      // Read from ref to get the latest prop value
      if (!isDismissingRef.current) {
        // PERF: Read bounding client rect only once per frame
        const containerRect = container.getBoundingClientRect();
        if (containerRect.width > 0 && containerRect.height > 0) {
            const scaleX = viewBox.width / containerRect.width;
            const scaleY = viewBox.height / containerRect.height;
            applyCursorAvoidance(containerRect, scaleX, scaleY);
        }
      } else {
        applyDismissalPositions();
      }
      animationFrameId = requestAnimationFrame(animate);
    };

    // --- Event Handlers ---
    const handleMouseMove = (e) => {
      if (isDismissingRef.current) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
    };
    const handleMouseLeave = () => {
      mouseRef.current.x = null;
      mouseRef.current.y = null;
      mouseRef.current.isClicked = false;
    };
    const handleMouseDown = () => { if (!isDismissingRef.current) mouseRef.current.isClicked = true; };
    const handleMouseUp = () => { mouseRef.current.isClicked = false; };
    const handleTouchStart = (e) => {
      if (isDismissingRef.current || e.touches.length === 0) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = e.touches[0].clientX - rect.left;
      mouseRef.current.y = e.touches[0].clientY - rect.top;
      mouseRef.current.isClicked = true;
    };
    const handleTouchMove = (e) => {
      if (isDismissingRef.current || e.touches.length === 0) return;
      const rect = container.getBoundingClientRect();
      mouseRef.current.x = e.touches[0].clientX - rect.left;
      mouseRef.current.y = e.touches[0].clientY - rect.top;
    };
    const handleTouchEnd = () => {
      mouseRef.current.isClicked = false;
      setTimeout(() => {
        mouseRef.current.x = null;
        mouseRef.current.y = null;
      }, 100);
    };
    
    // Start animation and attach listeners
    animate();
    container.addEventListener('mousemove', handleMouseMove);
    container.addEventListener('mouseleave', handleMouseLeave);
    container.addEventListener('mousedown', handleMouseDown);
    container.addEventListener('mouseup', handleMouseUp);
    container.addEventListener('touchstart', handleTouchStart, { passive: true });
    container.addEventListener('touchmove', handleTouchMove, { passive: true });
    container.addEventListener('touchend', handleTouchEnd);

    // Cleanup function
    return () => {
      cancelAnimationFrame(animationFrameId);
      container.removeEventListener('mousemove', handleMouseMove);
      container.removeEventListener('mouseleave', handleMouseLeave);
      container.removeEventListener('mousedown', handleMouseDown);
      container.removeEventListener('mouseup', handleMouseUp);
      container.removeEventListener('touchstart', handleTouchStart);
      container.removeEventListener('touchmove', handleTouchMove);
      container.removeEventListener('touchend', handleTouchEnd);
    };
  }, []); // Empty array ensures this effect runs only once.

  return (
    <div 
      ref={containerRef} 
      style={{ 
        width: '100%', 
        height: '100%',
        position: 'relative',
        overflow: 'visible'
      }}
    >
      {children}
    </div>
  );
};

export default OnboardingCursorInteraction;