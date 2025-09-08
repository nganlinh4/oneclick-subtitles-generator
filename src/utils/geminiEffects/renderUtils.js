/**
 * Rendering utilities for Gemini button effects
 */

import { COLOR_SCHEMES } from './constants';
import specialStarIcon from '../../assets/specialStar.svg';

/**
 * Create the special star HTML using the original SVG file
 * @param {boolean} isFilled - Whether to use filled version (ignored)
 * @param {number} colorSchemeIndex - Index of color scheme to use (ignored)
 * @returns {string} - HTML markup using img tag
 */
export const createSpecialStarSVG = (isFilled, colorSchemeIndex = 0) => {
  // Use the original specialStar.svg via bundler import so hashed path works across environments
  return `<img src="${specialStarIcon}" alt="Special Star" style="width: 100%; height: 100%; object-fit: contain;" />`;
};

/**
 * Create the Gemini SVG markup with option for filled version
 * @param {boolean} isFilled - Whether to use filled version
 * @param {number} colorSchemeIndex - Index of color scheme to use
 * @returns {string} - SVG markup
 */
export const createGeminiSVG = (isFilled, colorSchemeIndex = 0) => {
  // Get color scheme (default to first scheme if invalid index)
  const scheme = COLOR_SCHEMES[colorSchemeIndex] || COLOR_SCHEMES[0];

  // Create gradient ID with random number to avoid conflicts
  const gradientId = `gemini-gradient-${Math.floor(Math.random() * 10000)}`;
  const fillValue = isFilled ? `url(#${gradientId})` : 'none';
  const strokeWidth = isFilled ? '1' : '1.5';

  // Generate gradient stops
  const gradientStops = scheme.stops.map(stop =>
    `<stop offset="${stop.offset}" stop-color="${stop.color}" />`
  ).join('');

  // Only use the standard Gemini icon path (no plus icons)
  const pathD = 'M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z';

  // Add filter for glow effect if specified
  const filterId = `glow-${Math.floor(Math.random() * 10000)}`;
  const filterDef = scheme.glow ?
    `<filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="1" result="blur"/>
      <feComposite in="SourceGraphic" in2="blur" operator="over"/>
    </filter>` : '';

  const filterAttr = scheme.glow ? `filter="url(#${filterId})"` : '';

  return `<svg width="100%" height="100%" viewBox="0 0 28 28" fill="${fillValue}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
        ${gradientStops}
      </linearGradient>
      ${filterDef}
    </defs>
    <path d="${pathD}" stroke="${scheme.stroke}" stroke-width="${strokeWidth}" ${filterAttr}/>
  </svg>`;
};

/**
 * Get size in pixels based on size class
 * @param {string} sizeClass - Size class name
 * @returns {number} - Size in pixels
 */
export const getSizeInPixels = (sizeClass) => {
  switch (sizeClass) {
    case 'size-xs': return 8;
    case 'size-sm': return 12;
    case 'size-md': return 16;
    case 'size-lg': return 20;
    default: return 14;
  }
};

/**
 * Update DOM elements to match particle states
 * @param {Array} particles - Array of particles
 */
export const updateParticleElements = (particles) => {
  particles.forEach(particle => {
    if (!particle.element) return;

    // Update position and rotation
    particle.element.style.left = `${particle.x}%`;
    particle.element.style.top = `${particle.y}%`;
    particle.element.style.transform = `rotate(${particle.rotation}deg)`;

    // Update opacity based on active state - higher default opacity
    particle.element.style.opacity = particle.isActive ? '1' : '0';

    // Update trail particles if they exist
    if (particle.trailParticles && particle.isActive) {
      particle.trailParticles.forEach((trail, index) => {
        // Calculate trail position with delay
        const delay = (index + 1) * 2;
        const trailX = particle.x - (particle.vx * delay);
        const trailY = particle.y - (particle.vy * delay);

        trail.element.style.left = `${trailX}%`;
        trail.element.style.top = `${trailY}%`;
        trail.element.style.opacity = particle.isActive ? trail.opacity.toString() : '0';
      });
    }
  });
};
