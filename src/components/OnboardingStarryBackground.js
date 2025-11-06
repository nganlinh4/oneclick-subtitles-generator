import { useEffect, useRef } from 'react';

// --- Optimized Helper Functions (moved outside component) ---

/**
 * Pre-compiled Path2D object for the star shape.
 * This avoids parsing the SVG string on every frame for every star, a major performance win.
 */
const GEMINI_STAR_PATH_STRING = "M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z";
const GEMINI_STAR_PATH_2D = new Path2D(GEMINI_STAR_PATH_STRING);


/**
 * Generates vibrant star colors based on temperature and theme.
 */
const getStarColor = (temperature, intensity, isDark) => {
  let r, g, b;

  if (isDark) {
    if (temperature < 0.3) {
      r = Math.floor(100 + temperature * 50); g = Math.floor(150 + temperature * 80); b = 255;
    } else if (temperature < 0.7) {
      r = Math.floor(120 + temperature * 60); g = Math.floor(180 + temperature * 60); b = 255;
    } else {
      r = Math.floor(150 + temperature * 80); g = Math.floor(200 + temperature * 50); b = 255;
    }
  } else {
    if (temperature < 0.3) {
      r = 255; g = Math.floor(140 + temperature * 60); b = Math.floor(50 + temperature * 30);
    } else if (temperature < 0.7) {
      r = 255; g = Math.floor(200 + temperature * 40); b = Math.floor(80 + temperature * 50);
    } else {
      r = 255; g = Math.floor(220 + temperature * 30); b = Math.floor(100 + temperature * 80);
    }
  }

  return {
    r: Math.min(255, Math.max(0, r)),
    g: Math.min(255, Math.max(0, g)),
    b: Math.min(255, Math.max(0, b)),
    intensity: intensity * 1.5
  };
};

/**
 * Gets theme colors from the document.
 */
const getThemeColors = () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  return { isDark };
};

/**
 * Draws a 5-point star on the given canvas context.
 */
const draw5PointStar = (ctx, x, y, size, rotation, opacity, brightness) => {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);

  const outerRadius = size;
  const innerRadius = size * 0.4;

  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const pointX = Math.cos(angle) * radius;
    const pointY = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(pointX, pointY);
    else ctx.lineTo(pointX, pointY);
  }
  ctx.closePath();

  const starGradient = ctx.createRadialGradient(0, 0, 0, 0, 0, outerRadius);
  starGradient.addColorStop(0, `rgba(255, 255, 200, ${opacity * brightness})`);
  starGradient.addColorStop(0.3, `rgba(255, 215, 100, ${opacity * brightness * 0.9})`);
  starGradient.addColorStop(0.7, `rgba(255, 180, 50, ${opacity * brightness * 0.8})`);
  starGradient.addColorStop(1, `rgba(200, 140, 30, ${opacity * brightness * 0.6})`);

  ctx.fillStyle = starGradient;
  ctx.fill();

  ctx.strokeStyle = `rgba(255, 215, 100, ${opacity * brightness})`;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
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
      const dx = particles[current].x - particles[i].x;
      const dy = particles[current].y - particles[i].y;
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

    const applyWindEffects = (particles) => {
      windCurrentsRef.current.forEach(wind => {
        particles.forEach(particle => {
          const dx = particle.x - wind.x; const dy = particle.y - wind.y;
          if (Math.abs(dx) < wind.width/2 && Math.abs(dy) < wind.height/2) {
            const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
            const maxDistance = Math.sqrt((wind.width/2) ** 2 + (wind.height/2) ** 2);
            if (distanceFromCenter < maxDistance) {
              const force = (maxDistance - distanceFromCenter) / maxDistance;
              const windStrength = force * wind.strength * 0.05;
              particle.velocityX += wind.velocityX * windStrength + (Math.random() - 0.5) * windStrength * 0.5;
              particle.velocityY += wind.velocityY * windStrength + (Math.random() - 0.5) * windStrength * 0.5;
            }
          }
        });
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

    const applyCometGravity = (particles) => {
      cometsRef.current.forEach(comet => {
        particles.forEach(particle => {
          const dx = comet.x - particle.x;
          const dy = comet.y - particle.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < comet.gravityRadius && distance > 0) {
            const force = (comet.gravityRadius - distance) / comet.gravityRadius;
            const pullStrength = force * comet.gravityStrength * 0.02;
            particle.velocityX += (dx / distance) * pullStrength;
            particle.velocityY += (dy / distance) * pullStrength;
            const perpX = -dy / distance; const perpY = dx / distance;
            particle.velocityX += perpX * pullStrength * 0.5;
            particle.velocityY += perpY * pullStrength * 0.5;
          }
        });
      });
    };

    let particles = [];
    const createParticles = () => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      
      const particleCount = Math.max(6, Math.floor((rect.width * rect.height) / 25000));
      particles = [];
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      for (let i = 0; i < particleCount; i++) {
        const size = 8 + Math.random() * 8;
        const margin = size;
        const x = margin + Math.random() * (rect.width - 2 * margin);
        const y = margin + Math.random() * (rect.height - 2 * margin);
        const distanceFromCenter = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        const angleFromCenter = Math.atan2(y - centerY, x - centerX);

        particles.push({
          x, y, size, isFilled: Math.random() > 0.15, rotation: 0,
          opacity: 0.3 + Math.random() * 0.7, pulsePhase: Math.random() * Math.PI * 2,
          pulseSpeed: 0.015 + Math.random() * 0.012, breathePhase: Math.random() * Math.PI * 2,
          breatheSpeed: 0.006 + Math.random() * 0.008, breatheAmplitude: 0.12 + Math.random() * 0.20,
          isTwinkler: Math.random() < 0.25, twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.005 + Math.random() * 0.008, twinkleIntensity: 0.08 + Math.random() * 0.15,
          starTemp: Math.random(), colorIntensity: 1.0 + Math.random() * 0.5,
          galaxyAngle: angleFromCenter, galaxyRadius: distanceFromCenter,
          galaxySpeed: 0.001 + Math.random() * 0.002,
          spiralSpeed: 0.0005 + Math.random() * 0.001,
          spiralDirection: Math.random() > 0.5 ? 1 : -1,
          velocityX: 0, velocityY: 0, dragCoefficient: 0.98,
          turbulence: Math.random() * 0.5 + 0.2, turbulencePhase: Math.random() * Math.PI * 2,
          turbulenceSpeed: 0.002 + Math.random() * 0.003
        });
      }
      particlesRef.current = particles;
    };
    
    const updateConnections = () => {
      if (particles.length < 2) {
        connectionsRef.current = [];
        return;
      }
      const tspPath = solveTSP(particles);
      const newConnections = [];
      for (let i = 0; i < tspPath.length - 1; i++) {
        const p1 = particles[tspPath[i]];
        const p2 = particles[tspPath[i + 1]];
        const distance = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
        if (distance < 280) {
          const opacity = Math.max(0.15, 1 - (distance / 280));
          newConnections.push({ from: tspPath[i], to: tspPath[i + 1], opacity: opacity * 0.45 });
        }
      }
      connectionsRef.current = newConnections;
    };

    const drawConnections = (colors) => {
      connectionsRef.current.forEach(connection => {
        const p1 = particlesRef.current[connection.from];
        const p2 = particlesRef.current[connection.to];
        if (!p1 || !p2) return;

        const dx = p2.x - p1.x; const dy = p2.y - p1.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance === 0) return;
        
        const unitX = dx / distance; const unitY = dy / distance;
        const gap = (p1.size + p2.size) / 2 * 0.7;
        const startX = p1.x + unitX * gap; const startY = p1.y + unitY * gap;
        const endX = p2.x - unitX * gap; const endY = p2.y - unitY * gap;
        if (Math.sqrt((endX - startX) ** 2 + (endY - startY) ** 2) < gap) return;

        ctx.save();
        if (colors.isDark) {
          ctx.strokeStyle = `rgba(100, 150, 255, ${connection.opacity})`;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 6]);
        } else {
          ctx.strokeStyle = `rgba(180, 200, 160, ${connection.opacity * 0.4})`;
          ctx.lineWidth = 0.8;
          ctx.setLineDash([]);
        }
        ctx.beginPath(); ctx.moveTo(startX, startY); ctx.lineTo(endX, endY); ctx.stroke();
        ctx.restore();
      });
    };

    const drawParticle = (particle, colors) => {
      const { x, y, size, rotation, isFilled, opacity } = particle;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rotation);

      if (colors.isDark) {
        const starColor = getStarColor(particle.starTemp, particle.colorIntensity, true);
        if (isFilled && opacity > 0.4) {
          const glowPulse = 0.6 + 0.2 * Math.sin(particle.pulsePhase * 0.6);
          const subtleGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.5);
          subtleGlow.addColorStop(0, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * 0.2 * glowPulse})`);
          subtleGlow.addColorStop(1, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, 0)`);
          ctx.fillStyle = subtleGlow;
          ctx.beginPath(); ctx.arc(0, 0, size * 1.5, 0, Math.PI * 2); ctx.fill();
        }

        const scale = size / 28;
        ctx.scale(scale, scale);
        ctx.translate(-14, -14);

        if (isFilled) {
          const gradient = ctx.createLinearGradient(-14, -14, 14, 14);
          const baseOpacity = opacity * starColor.intensity;
          gradient.addColorStop(0, `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${baseOpacity * 1.3})`);
          gradient.addColorStop(1, `rgba(${Math.max(0, starColor.r - 15)}, ${Math.max(0, starColor.g - 10)}, ${Math.max(0, starColor.b - 5)}, ${baseOpacity * 0.9})`);
          ctx.fillStyle = gradient;
          ctx.fill(GEMINI_STAR_PATH_2D);
          ctx.strokeStyle = `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * 0.8})`;
          ctx.lineWidth = 1.2;
          ctx.stroke(GEMINI_STAR_PATH_2D);
        } else {
          ctx.strokeStyle = `rgba(${starColor.r}, ${starColor.g}, ${starColor.b}, ${opacity * starColor.intensity})`;
          ctx.lineWidth = 1.5;
          ctx.stroke(GEMINI_STAR_PATH_2D);
        }
      } else {
        const seedOpacity = Math.min(1.0, opacity * 1.1);
        ctx.fillStyle = `rgba(255, 220, 80, ${seedOpacity})`;
        ctx.beginPath(); ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2); ctx.fill();
        const fiberCount = 8 + Math.floor(Math.random() * 4);
        for (let i = 0; i < fiberCount; i++) {
          const angle = (i / fiberCount) * Math.PI * 2 + rotation;
          const fiberLength = size * (0.7 + Math.random() * 0.3);
          const fiberOpacity = seedOpacity * (0.7 + Math.random() * 0.3);
          ctx.strokeStyle = `rgba(255, 255, 255, ${fiberOpacity})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(angle) * fiberLength, Math.sin(angle) * fiberLength); ctx.stroke();
          ctx.fillStyle = `rgba(255, 255, 255, ${fiberOpacity})`;
          ctx.beginPath(); ctx.arc(Math.cos(angle) * fiberLength, Math.sin(angle) * fiberLength, 1, 0, Math.PI * 2); ctx.fill();
        }
        const seedGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.2);
        seedGlow.addColorStop(0, `rgba(255, 255, 255, ${seedOpacity * 0.1})`);
        seedGlow.addColorStop(1, 'rgba(250, 250, 250, 0)');
        ctx.fillStyle = seedGlow;
        ctx.beginPath(); ctx.arc(0, 0, size * 1.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
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

      if (colors.isDark) applyCometGravity(currentParticles);
      else applyWindEffects(currentParticles);
      
      updateConnections();
      drawConnections(colors);
      
      if (colors.isDark) drawComets();
      else drawWindCurrents();

      currentParticles.forEach(particle => {
        const pulseOpacity = particle.opacity * (0.7 + 0.3 * Math.sin(particle.pulsePhase));
        const breathingSize = particle.size * (1 + Math.sin(particle.breathePhase) * particle.breatheAmplitude);
        drawParticle({ ...particle, size: breathingSize, opacity: pulseOpacity }, colors);
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
    const handleThemeChange = () => {}; // Colors are checked on each frame, so no action needed here.

    resizeCanvas();
    animate();

    const overlay = canvas.parentElement;
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('storage', handleThemeChange);
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
      window.removeEventListener('storage', handleThemeChange);
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