import { useEffect, useRef } from 'react';
import '../styles/GeminiHeaderAnimation.css';

// --- Optimized Helper Functions & Constants (moved outside component) ---

/**
 * Pre-compiled Path2D object for the Gemini star shape.
 * This avoids parsing the SVG string on every frame for every star, a major performance win.
 */
const GEMINI_STAR_PATH_STRING = "M14 28 C14 26.0633 13.6267 24.2433 12.88 22.54 C12.1567 20.8367 11.165 19.355 9.905 18.095 C8.645 16.835 7.16333 15.8433 5.46 15.12 C3.75667 14.3733 1.93667 14 0 14 C1.93667 14 3.75667 13.6383 5.46 12.915 C7.16333 12.1683 8.645 11.165 9.905 9.905 C11.165 8.645 12.1567 7.16333 12.88 5.46 C13.6267 3.75667 14 1.93667 14 0 C14 1.93667 14.3617 3.75667 15.085 5.46 C15.8317 7.16333 16.835 8.645 18.095 9.905 C19.355 11.165 20.8367 12.1683 22.54 12.915 C24.2433 13.6383 26.0633 14 28 14 C26.0633 14 24.2433 14.3733 22.54 15.12 C20.8367 15.8433 19.355 16.835 18.095 18.095 C16.835 19.355 15.8317 20.8367 15.085 22.54 C14.3617 24.2433 14 26.0633 14 28 Z";
const GEMINI_STAR_PATH_2D = new Path2D(GEMINI_STAR_PATH_STRING);

/**
 * Generates realistic star colors based on temperature.
 */
const getStarColor = (temperature, intensity, isDark) => {
  let r, g, b;
  if (temperature < 0.3) {
    r = isDark ? 100 + temperature * 60 : 80 + temperature * 40;
    g = isDark ? 150 + temperature * 70 : 120 + temperature * 50;
    b = isDark ? 255 : 240;
  } else if (temperature < 0.7) {
    r = isDark ? 160 + temperature * 50 : 130 + temperature * 40;
    g = isDark ? 190 + temperature * 40 : 160 + temperature * 30;
    b = isDark ? 255 : 250;
  } else {
    r = isDark ? 200 + temperature * 30 : 170 + temperature * 25;
    g = isDark ? 220 + temperature * 25 : 190 + temperature * 20;
    b = isDark ? 255 : 255;
  }
  return {
    r: Math.min(255, Math.round(r)),
    g: Math.min(255, Math.round(g)),
    b: Math.min(255, Math.round(b)),
    intensity,
  };
};

/**
 * Gets theme-aware colors. This is called once per frame.
 */
const getThemeColors = () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    isDark,
    connectionColor: isDark ? 'rgba(200, 200, 220, 0.15)' : 'rgba(100, 100, 120, 0.2)',
  };
};

/**
 * Simple TSP solver using nearest neighbor heuristic.
 */
const solveTSP = (particles) => {
  if (particles.length < 2) return [];
  const visited = new Set();
  const path = [];
  let current = 0;
  visited.add(current);
  path.push(current);
  while (visited.size < particles.length) {
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (let i = 0; i < particles.length; i++) {
      if (visited.has(i)) continue;
      const dx = particles[current].anchorX - particles[i].anchorX;
      const dy = particles[current].anchorY - particles[i].anchorY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }
    if (nearestIndex !== -1) {
      visited.add(nearestIndex);
      path.push(nearestIndex);
      current = nearestIndex;
    } else {
      break;
    }
  }
  return path;
};

/**
 * GeminiHeaderAnimation - Creates an animated constellation of Gemini icons in the header
 */
const GeminiHeaderAnimation = () => {
  const canvasRef = useRef(null);
  const mouseRef = useRef({ x: null, y: null, isClicked: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let particles = [];
    let connections = [];

    const createParticles = (cssWidth, cssHeight) => {
      const particleCount = Math.max(5, Math.floor(cssWidth / 100));
      const newParticles = [];
      for (let i = 0; i < particleCount; i++) {
        const size = 8 + Math.random() * 8;
        const margin = size;
        const anchorX = margin + Math.random() * (cssWidth - 2 * margin);
        const anchorY = margin + Math.random() * (cssHeight - 2 * margin);
        newParticles.push({
          x: anchorX, y: anchorY, anchorX, anchorY, size,
          isFilled: Math.random() > 0.3, rotation: 0,
          opacity: 0.3 + Math.random() * 0.3,
          pulsePhase: Math.random() * Math.PI * 2,
          pulseSpeed: 0.008 + Math.random() * 0.006,
          driftPhaseX: Math.random() * Math.PI * 2,
          driftPhaseY: Math.random() * Math.PI * 2,
          driftSpeedX: 0.001 + Math.random() * 0.002,
          driftSpeedY: 0.001 + Math.random() * 0.002,
          driftAmplitudeX: 3 + Math.random() * 6,
          driftAmplitudeY: 3 + Math.random() * 6,
          orbitPhase: Math.random() * Math.PI * 2,
          orbitSpeed: 0.0006 + Math.random() * 0.0012,
          orbitRadius: 2 + Math.random() * 5,
          breathePhase: Math.random() * Math.PI * 2,
          breatheSpeed: 0.002 + Math.random() * 0.002,
          breatheAmplitude: 0.06 + Math.random() * 0.10,
          isTwinkler: Math.random() < 0.15,
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.002 + Math.random() * 0.003,
          twinkleIntensity: 0.03 + Math.random() * 0.06,
          starTemp: Math.random(),
          colorIntensity: 0.8 + Math.random() * 0.2,
        });
      }
      particles = newParticles;
    };

    const updateConnections = () => {
      if (particles.length < 2) {
        connections = [];
        return;
      }
      const tspPath = solveTSP(particles);
      const newConnections = [];
      for (let i = 0; i < tspPath.length - 1; i++) {
        const p1 = particles[tspPath[i]];
        const p2 = particles[tspPath[i+1]];
        const distance = Math.sqrt((p1.anchorX - p2.anchorX) ** 2 + (p1.anchorY - p2.anchorY) ** 2);
        if (distance < 200) {
          const opacity = Math.max(0.1, 1 - (distance / 200));
          newConnections.push({ from: tspPath[i], to: tspPath[i + 1], opacity: opacity * 0.25 });
        }
      }
      connections = newConnections;
    };

    const drawGeminiIcon = (particle, colors) => {
      const { x, y, size, rotation, isFilled, opacity } = particle;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);

      const starColor = getStarColor(particle.starTemp, particle.colorIntensity, colors.isDark);

      if (isFilled && opacity > 0.4) {
        const glowPulse = 0.7 + 0.3 * Math.sin(particle.pulsePhase * 0.8);
        const subtleGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.5);
        subtleGlow.addColorStop(0, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * 0.18 * glowPulse})`);
        subtleGlow.addColorStop(1, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, 0)`);
        ctx.fillStyle = subtleGlow;
        ctx.beginPath();
        ctx.arc(0, 0, size * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.scale(size / 28, size / 28);
      ctx.translate(-14, -14);
      
      if (isFilled) {
        const gradient = ctx.createLinearGradient(-14, -14, 14, 14);
        const baseOpacity = opacity * starColor.intensity;
        gradient.addColorStop(0, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${baseOpacity * 1.2})`);
        gradient.addColorStop(1, `rgba(${Math.max(0, starColor.r - 30)}, ${Math.max(0, starColor.g - 20)}, ${Math.max(0, starColor.b - 5)}, ${baseOpacity * 0.8})`);
        ctx.fillStyle = gradient;
        ctx.fill(GEMINI_STAR_PATH_2D);
        ctx.strokeStyle = `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * 0.6})`;
        ctx.lineWidth = 0.5;
        ctx.stroke(GEMINI_STAR_PATH_2D);
      } else {
        ctx.strokeStyle = `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * starColor.intensity})`;
        ctx.lineWidth = 1.2;
        ctx.stroke(GEMINI_STAR_PATH_2D);
      }
      ctx.restore();
    };

    const drawConnections = (colors) => {
      ctx.lineWidth = 0.5;
      connections.forEach(connection => {
        const p1 = particles[connection.from];
        const p2 = particles[connection.to];
        if (!p1 || !p2) return;

        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < 1) return;

        const unitX = dx / distance;
        const unitY = dy / distance;
        const gap = (p1.size + p2.size) / 2 * 0.7;
        if (distance < gap * 2) return;

        const startX = p1.x + unitX * gap;
        const startY = p1.y + unitY * gap;
        const endX = p2.x - unitX * gap;
        const endY = p2.y - unitY * gap;
        
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = colors.connectionColor.replace(/[\d.]+\)$/, `${connection.opacity})`);
        ctx.stroke();
      });
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const colors = getThemeColors();

      particles.forEach(particle => {
        const driftX = Math.sin(particle.driftPhaseX) * particle.driftAmplitudeX;
        const driftY = Math.sin(particle.driftPhaseY) * particle.driftAmplitudeY;
        const orbitX = Math.cos(particle.orbitPhase) * particle.orbitRadius;
        const orbitY = Math.sin(particle.orbitPhase) * particle.orbitRadius;
        particle.x = particle.anchorX + driftX + orbitX;
        particle.y = particle.anchorY + driftY + orbitY;

        if (mouseRef.current.x !== null) {
          const dx = particle.x - mouseRef.current.x;
          const dy = particle.y - mouseRef.current.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const isClicked = mouseRef.current.isClicked;
          const interactionRadius = isClicked ? 200 : 150;

          if (distance < interactionRadius) {
            const force = Math.pow((interactionRadius - distance) / interactionRadius, isClicked ? 3 : 2);
            const angle = Math.atan2(dy, dx);
            const maxOffset = isClicked ? 50 : 30;
            particle.x += Math.cos(angle) * force * maxOffset;
            particle.y += Math.sin(angle) * force * maxOffset;
            particle.pulsePhase += particle.pulseSpeed * (1 + force * (isClicked ? 1.0 : 0.5));
          }
        }

        particle.driftPhaseX += particle.driftSpeedX;
        particle.driftPhaseY += particle.driftSpeedY;
        particle.orbitPhase += particle.orbitSpeed;
        particle.breathePhase += particle.breatheSpeed;
        particle.pulsePhase += particle.pulseSpeed;
        if (particle.isTwinkler) {
          particle.twinklePhase += particle.twinkleSpeed;
          particle.rotation = Math.sin(particle.twinklePhase) * particle.twinkleIntensity;
        }
      });
      
      drawConnections(colors);

      particles.forEach(particle => {
        const pulseOpacity = particle.opacity * (0.7 + 0.3 * Math.sin(particle.pulsePhase));
        const breathingSize = particle.size * (1 + Math.sin(particle.breathePhase) * particle.breatheAmplitude);
        drawGeminiIcon({ ...particle, size: breathingSize, opacity: pulseOpacity }, colors);
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    const resizeCanvas = () => {
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const effectiveDpr = Math.max(1, dpr);
      const canvasWidth = Math.max(1, Math.round(rect.width));
      const canvasHeight = Math.max(1, Math.round(rect.height));

      canvas.width = canvasWidth * effectiveDpr;
      canvas.height = canvasHeight * effectiveDpr;
      canvas.style.width = `${canvasWidth}px`;
      canvas.style.height = `${canvasHeight}px`;
      
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(effectiveDpr, effectiveDpr);

      if (canvasWidth > 0 && canvasHeight > 0) {
        createParticles(canvasWidth, canvasHeight);
        updateConnections();
      }
    };
    
    const handleMouseMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
    };
    const handleMouseLeave = () => { mouseRef.current.x = null; mouseRef.current.y = null; mouseRef.current.isClicked = false; };
    const handleMouseDown = () => { mouseRef.current.isClicked = true; };
    const handleMouseUp = () => { mouseRef.current.isClicked = false; };
    const handleThemeChange = () => {}; // Automatically handled in animate loop
    
    // Initial setup
    resizeCanvas();
    animate();

    // Event listeners
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('storage', handleThemeChange);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('touchstart', handleMouseDown, { passive: true });
    canvas.addEventListener('touchend', handleMouseUp);
    canvas.addEventListener('touchcancel', handleMouseLeave);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('storage', handleThemeChange);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('touchstart', handleMouseDown);
      canvas.removeEventListener('touchend', handleMouseUp);
      canvas.removeEventListener('touchcancel', handleMouseLeave);
    };
  }, []);

  return <canvas ref={canvasRef} className="gemini-header-canvas" />;
};

export default GeminiHeaderAnimation;