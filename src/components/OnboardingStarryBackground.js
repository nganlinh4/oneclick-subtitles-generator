import { useEffect, useRef } from 'react';
import { draw5PointStar, getThemeColors } from './starry/starCanvasHelpers';
import {
  applyCometGravity,
  applyWindEffects,
  createParticles as buildParticles,
  drawConnections,
  drawParticle,
  updateConnections as computeConnections
} from './starry/particleAnimations';

/**
 * OnboardingStarryBackground - Creates an animated starry sky for the onboarding overlay
 * Full implementation with TSP connections, cursor interactions, and constant movement
 */
const OnboardingStarryBackground = () => {
  const canvasRef = useRef(null);
  const particlesRef = useRef([]);
  const connectionsRef = useRef([]);
  const cometsRef = useRef([]);
  const windCurrentsRef = useRef([]);
  const mouseRef = useRef({ x: null, y: null, isClicked: false });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    let animationFrameId;

    // Create a new comet
    const createComet = (cssWidth, cssHeight) => {
      const side = Math.floor(Math.random() * 4);
      let startX, startY, endX, endY;

      switch (side) {
        case 0: startX = Math.random() * cssWidth; startY = -50; endX = Math.random() * cssWidth; endY = cssHeight + 50; break;
        case 1: startX = cssWidth + 50; startY = Math.random() * cssHeight; endX = -50; endY = Math.random() * cssHeight; break;
        case 2: startX = Math.random() * cssWidth; startY = cssHeight + 50; endX = Math.random() * cssWidth; endY = -50; break;
        case 3: default: startX = -50; startY = Math.random() * cssHeight; endX = cssWidth + 50; endY = Math.random() * cssHeight; break;
      }

      const dx = endX - startX; const dy = endY - startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const speed = 1.5 + Math.random() * 2.5;

      return {
        x: startX, y: startY, velocityX: (dx / distance) * speed, velocityY: (dy / distance) * speed,
        size: 8 + Math.random() * 4, opacity: 0.95 + Math.random() * 0.05,
        gravityRadius: 120 + Math.random() * 60, gravityStrength: 15 + Math.random() * 10,
        life: 0, maxLife: distance / speed, brightness: 0.9 + Math.random() * 0.3,
        rotation: Math.random() * Math.PI * 2, rotationSpeed: 0.05 + Math.random() * 0.1,
        glowIntensity: 0.8 + Math.random() * 0.4, sparkles: [],
        maxSparkles: 8 + Math.floor(Math.random() * 12)
      };
    };

    const manageComets = (cssWidth, cssHeight) => {
      const comets = cometsRef.current;
      if (Math.random() < 0.001) comets.push(createComet(cssWidth, cssHeight));

      for (let i = comets.length - 1; i >= 0; i--) {
        const comet = comets[i];
        comet.x += comet.velocityX; comet.y += comet.velocityY; comet.life++;

        if (comet.sparkles.length < comet.maxSparkles && Math.random() < 0.3) {
          const angle = Math.random() * Math.PI * 2;
          const distance = 5 + Math.random() * 15;
          comet.sparkles.push({
            x: comet.x + Math.cos(angle) * distance, y: comet.y + Math.sin(angle) * distance,
            velocityX: (Math.random() - 0.5) * 2, velocityY: (Math.random() - 0.5) * 2,
            size: 0.5 + Math.random() * 1, opacity: 0.6 + Math.random() * 0.4,
            life: 0, maxLife: 20 + Math.random() * 30
          });
        }

        for (let j = comet.sparkles.length - 1; j >= 0; j--) {
          const sparkle = comet.sparkles[j];
          sparkle.x += sparkle.velocityX; sparkle.y += sparkle.velocityY;
          sparkle.velocityX *= 0.98; sparkle.velocityY *= 0.98;
          sparkle.life++; sparkle.opacity *= 0.96;
          if (sparkle.life > sparkle.maxLife || sparkle.opacity < 0.01) comet.sparkles.splice(j, 1);
        }

        if (comet.life > comet.maxLife) comets.splice(i, 1);
      }
    };

    const createWindCurrent = (cssWidth, cssHeight) => {
      const side = Math.floor(Math.random() * 2);
      let startX, endX;
      const startY = Math.random() * cssHeight;
      const endY = startY + (Math.random() - 0.5) * cssHeight * 0.3;

      if (side === 0) { startX = -100; endX = cssWidth + 100; }
      else { startX = cssWidth + 100; endX = -100; }

      const dx = endX - startX; const dy = endY - startY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const speed = 1 + Math.random() * 2;

      return {
        x: startX, y: startY, velocityX: (dx / distance) * speed, velocityY: (dy / distance) * speed,
        width: 150 + Math.random() * 200, height: 80 + Math.random() * 120,
        opacity: 0.1 + Math.random() * 0.15, strength: 5 + Math.random() * 10,
        life: 0, maxLife: distance / speed, swayPhase: Math.random() * Math.PI * 2,
        swaySpeed: 0.02 + Math.random() * 0.03
      };
    };

    const manageWindCurrents = (cssWidth, cssHeight) => {
      const winds = windCurrentsRef.current;
      if (Math.random() < 0.0015) winds.push(createWindCurrent(cssWidth, cssHeight));
      for (let i = winds.length - 1; i >= 0; i--) {
        const wind = winds[i];
        wind.x += wind.velocityX; wind.y += wind.velocityY;
        wind.life++; wind.swayPhase += wind.swaySpeed;
        if (wind.life > wind.maxLife) winds.splice(i, 1);
      }
    };

    const drawWindCurrents = () => {
      windCurrentsRef.current.forEach(wind => {
        ctx.save();
        const waveCount = 3;
        for (let i = 0; i < waveCount; i++) {
          const offsetY = (i - 1) * wind.height / 4;
          const waveOpacity = wind.opacity * (0.4 + i * 0.2);
          ctx.strokeStyle = `rgba(200, 220, 180, ${waveOpacity})`;
          ctx.lineWidth = 0.8 + i * 0.3;
          ctx.setLineDash([6, 12]);
          ctx.beginPath();
          ctx.moveTo(wind.x - wind.width/2, wind.y + offsetY);
          for (let x = -wind.width/2; x <= wind.width/2; x += 6) {
            const waveY = Math.sin((x / 25) + wind.swayPhase + i * 0.3) * 8;
            ctx.lineTo(wind.x + x, wind.y + offsetY + waveY);
          }
          ctx.stroke();
        }
        ctx.restore();
      });
    };

    const drawComets = () => {
      cometsRef.current.forEach(comet => {
        comet.rotation += comet.rotationSpeed;
        const glowLayers = [
          { radius: comet.size * 4, opacity: 0.15, color: [255, 215, 100] },
          { radius: comet.size * 2.5, opacity: 0.25, color: [255, 235, 150] },
          { radius: comet.size * 1.5, opacity: 0.4, color: [255, 245, 200] }
        ];
        glowLayers.forEach(layer => {
          const glowGradient = ctx.createRadialGradient(comet.x, comet.y, 0, comet.x, comet.y, layer.radius);
          glowGradient.addColorStop(0, `rgba(${layer.color.join(',')}, ${layer.opacity * comet.opacity * comet.glowIntensity})`);
          glowGradient.addColorStop(0.6, `rgba(${layer.color.join(',')}, ${layer.opacity * comet.opacity * comet.glowIntensity * 0.3})`);
          glowGradient.addColorStop(1, `rgba(${layer.color.join(',')}, 0)`);
          ctx.fillStyle = glowGradient;
          ctx.beginPath(); ctx.arc(comet.x, comet.y, layer.radius, 0, Math.PI * 2); ctx.fill();
        });

        draw5PointStar(ctx, comet.x, comet.y, comet.size, comet.rotation, comet.opacity, comet.brightness);

        comet.sparkles.forEach(sparkle => {
          ctx.save();
          const sparkleGlow = ctx.createRadialGradient(sparkle.x, sparkle.y, 0, sparkle.x, sparkle.y, sparkle.size * 3);
          sparkleGlow.addColorStop(0, `rgba(255, 255, 255, ${sparkle.opacity * 0.8})`);
          sparkleGlow.addColorStop(0.5, `rgba(200, 240, 255, ${sparkle.opacity * 0.4})`);
          sparkleGlow.addColorStop(1, `rgba(120, 200, 255, 0)`);
          ctx.fillStyle = sparkleGlow;
          ctx.beginPath(); ctx.arc(sparkle.x, sparkle.y, sparkle.size * 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = `rgba(255, 255, 255, ${sparkle.opacity})`;
          ctx.beginPath(); ctx.arc(sparkle.x, sparkle.y, sparkle.size, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        });
      });
    };

    let particles = [];

    const createParticles = () => {
      const next = buildParticles(canvas);
      if (next.length === 0) return;
      particles = next;
      particlesRef.current = particles;
    };

    const updateConnections = () => {
      connectionsRef.current = computeConnections(particles);
    };

    const animate = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const currentParticles = particlesRef.current;
      const mouse = mouseRef.current;
      const colors = getThemeColors();
      const rect = canvas.getBoundingClientRect();
      const { width: cssWidth, height: cssHeight } = rect;
      const centerX = cssWidth / 2;
      const centerY = cssHeight / 2;
      const maxRadius = Math.max(cssWidth, cssHeight) * 0.8;

      if (colors.isDark) manageComets(cssWidth, cssHeight);
      else manageWindCurrents(cssWidth, cssHeight);

      currentParticles.forEach(particle => {
        particle.pulsePhase += particle.pulseSpeed;
        particle.breathePhase += particle.breatheSpeed;
        particle.turbulencePhase += particle.turbulenceSpeed;
        if (particle.isTwinkler) particle.rotation = Math.sin(particle.twinklePhase += particle.twinkleSpeed) * particle.twinkleIntensity;

        particle.velocityX *= particle.dragCoefficient;
        particle.velocityY *= particle.dragCoefficient;

        particle.galaxyAngle += particle.galaxySpeed;
        particle.galaxyRadius += particle.spiralSpeed * particle.spiralDirection;
        const idealX = centerX + Math.cos(particle.galaxyAngle) * particle.galaxyRadius;
        const idealY = centerY + Math.sin(particle.galaxyAngle) * particle.galaxyRadius;

        if (colors.isDark) {
          const turbulenceX = Math.sin(particle.turbulencePhase) * particle.turbulence;
          const turbulenceY = Math.cos(particle.turbulencePhase * 1.3) * particle.turbulence;
          particle.velocityX += (idealX + turbulenceX - particle.x) * 0.005;
          particle.velocityY += (idealY + turbulenceY - particle.y) * 0.005;
        } else {
          particle.velocityY -= 0.02 * (0.8 + Math.sin(particle.turbulencePhase) * 0.4);
          particle.velocityX += Math.sin(particle.turbulencePhase * 0.7) * 0.01;
          particle.velocityX += (idealX - particle.x) * 0.001;
          particle.velocityY += (idealY - particle.y) * 0.001;
        }

        if (particle.galaxyRadius > maxRadius) {
          particle.spiralDirection = -1; particle.spiralSpeed = Math.abs(particle.spiralSpeed) * 1.5;
        } else if (particle.galaxyRadius < 50) {
          particle.spiralDirection = 1; particle.spiralSpeed = Math.abs(particle.spiralSpeed) * 1.5;
        }

        if (mouse.x !== null) {
          const dx = particle.x - mouse.x; const dy = particle.y - mouse.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const minDim = Math.max(1, Math.min(cssWidth, cssHeight));
          const effectiveRadius = minDim * (mouse.isClicked ? 0.18 : 0.12);
          if (distance < effectiveRadius && distance > 0) {
            const force = (effectiveRadius - distance) / effectiveRadius;
            const pushStrength = (mouse.isClicked ? 0.8 : 0.4) * (minDim / 1000);
            particle.velocityX += (dx / distance) * force * pushStrength;
            particle.velocityY += (dy / distance) * force * pushStrength;
          }
        }
        particle.x += particle.velocityX; particle.y += particle.velocityY;
      });

      if (colors.isDark) applyCometGravity(cometsRef.current, currentParticles);
      else applyWindEffects(windCurrentsRef.current, currentParticles);

      updateConnections();
      drawConnections(ctx, connectionsRef.current, particlesRef.current, colors);

      if (colors.isDark) drawComets();
      else drawWindCurrents();

      currentParticles.forEach(particle => {
        const pulseOpacity = particle.opacity * (0.7 + 0.3 * Math.sin(particle.pulsePhase));
        const breathingSize = particle.size * (1 + Math.sin(particle.breathePhase) * particle.breatheAmplitude);
        drawParticle(ctx, { ...particle, size: breathingSize, opacity: pulseOpacity }, colors);
      });

      animationFrameId = requestAnimationFrame(animate);
    };

    const resizeCanvas = () => {
      const overlayEl = canvas.parentElement || canvas;
      const rect = overlayEl.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const effectiveDpr = Math.max(1, dpr);
      const canvasWidth = Math.max(1, Math.round(rect.width));
      const canvasHeight = Math.max(1, Math.round(rect.height));

      canvas.width = canvasWidth * effectiveDpr;
      canvas.height = canvasHeight * effectiveDpr;
      canvas.style.width = canvasWidth + 'px';
      canvas.style.height = canvasHeight + 'px';

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(effectiveDpr, effectiveDpr);

      if (canvasWidth > 0 && canvasHeight > 0) {
        createParticles();
        updateConnections();
      }
    };

    const handleMouseMove = (e) => {
      const rect = canvas.parentElement.getBoundingClientRect();
      mouseRef.current.x = e.clientX - rect.left;
      mouseRef.current.y = e.clientY - rect.top;
    };
    const handleMouseLeave = () => { mouseRef.current.x = null; mouseRef.current.y = null; mouseRef.current.isClicked = false; };
    const handleMouseDown = () => { mouseRef.current.isClicked = true; };
    const handleMouseUp = () => { mouseRef.current.isClicked = false; };

    resizeCanvas();
    animate();

    const overlay = canvas.parentElement;
    window.addEventListener('resize', resizeCanvas);
    overlay.addEventListener('mousemove', handleMouseMove);
    overlay.addEventListener('mouseleave', handleMouseLeave);
    overlay.addEventListener('mousedown', handleMouseDown);
    overlay.addEventListener('mouseup', handleMouseUp);
    overlay.addEventListener('touchstart', handleMouseDown, { passive: true });
    overlay.addEventListener('touchend', handleMouseUp);
    overlay.addEventListener('touchcancel', handleMouseLeave);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resizeCanvas);
      if (overlay) {
        overlay.removeEventListener('mousemove', handleMouseMove);
        overlay.removeEventListener('mouseleave', handleMouseLeave);
        overlay.removeEventListener('mousedown', handleMouseDown);
        overlay.removeEventListener('mouseup', handleMouseUp);
        overlay.removeEventListener('touchstart', handleMouseDown);
        overlay.removeEventListener('touchend', handleMouseUp);
        overlay.removeEventListener('touchcancel', handleMouseLeave);
      }
    };
  }, []);

  return <canvas ref={canvasRef} className="onboarding-starry-canvas" />;
};

export default OnboardingStarryBackground;
