/**
 * Rendering utilities for the Gemini button effects:
 * SVG defs/markup and DOM updates for particles.
 */

import specialStarIcon from '../../assets/specialStar.svg';
import { COLOR_SCHEMES } from './constants';

/**
 * Ensures that shared SVG definitions for gradients and filters are present in the DOM.
 * This prevents creating duplicate definitions for every particle.
 */
export const ensureSVGDefs = () => {
  const defsId = 'gemini-button-svg-defs';
  if (document.getElementById(defsId)) return;

  const svgDefsContainer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgDefsContainer.id = defsId;
  svgDefsContainer.style.position = 'absolute';
  svgDefsContainer.style.width = '0';
  svgDefsContainer.style.height = '0';
  svgDefsContainer.style.overflow = 'hidden';

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

  COLOR_SCHEMES.forEach((scheme, index) => {
    // Create gradient
    const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
    gradient.id = `gemini-gradient-${index}`;
    gradient.setAttribute('x1', '0%');
    gradient.setAttribute('y1', '0%');
    gradient.setAttribute('x2', '100%');
    gradient.setAttribute('y2', '100%');
    scheme.stops.forEach(stop => {
      const stopEl = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
      stopEl.setAttribute('offset', stop.offset);
      stopEl.setAttribute('stop-color', stop.color);
      gradient.appendChild(stopEl);
    });
    defs.appendChild(gradient);

    // Create glow filter if specified
    if (scheme.glow) {
      const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
      filter.id = `gemini-glow-filter-${index}`;
      filter.setAttribute('x', '-50%');
      filter.setAttribute('y', '-50%');
      filter.setAttribute('width', '200%');
      filter.setAttribute('height', '200%');

      const feGaussianBlur = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
      feGaussianBlur.setAttribute('stdDeviation', '1');
      feGaussianBlur.setAttribute('result', 'blur');
      filter.appendChild(feGaussianBlur);

      const feComposite = document.createElementNS('http://www.w3.org/2000/svg', 'feComposite');
      feComposite.setAttribute('in', 'SourceGraphic');
      feComposite.setAttribute('in2', 'blur');
      feComposite.setAttribute('operator', 'over');
      filter.appendChild(feComposite);

      defs.appendChild(filter);
    }
  });

  svgDefsContainer.appendChild(defs);
  document.body.appendChild(svgDefsContainer);
};

/**
 * Create the special star HTML using the original SVG file
 * @param {boolean} isFilled - Whether to use filled version (ignored)
 * @param {number} colorSchemeIndex - Index of color scheme to use (ignored)
 * @returns {string} - HTML markup using img tag
 */
export const createSpecialStarSVG = (_isFilled, _colorSchemeIndex = 0) => {
  // Use imported specialStarIcon so bundler rewrites to correct hashed path
  return `<img src="${specialStarIcon}" alt="Special Star" style="width: 100%; height: 100%; object-fit: contain;" />`;
};

/**
 * Create the Gemini SVG markup with option for filled version
 * @param {boolean} isFilled - Whether to use filled version
 * @param {number} colorSchemeIndex - Index of color scheme to use
 * @returns {string} - SVG markup
 */
export const createGeminiSVG = (isFilled, colorSchemeIndex = 0) => {
  const scheme = COLOR_SCHEMES[colorSchemeIndex] || COLOR_SCHEMES[0];
  const gradientId = `gemini-gradient-${colorSchemeIndex}`;
  const fillValue = isFilled ? `url(#${gradientId})` : 'none';
  const strokeWidth = isFilled ? '1' : '1.5';
  const pathD = 'M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z';
  const filterId = `gemini-glow-filter-${colorSchemeIndex}`;
  const filterAttr = scheme.glow ? `filter="url(#${filterId})"` : '';

  // The <defs> block is no longer needed here as it's loaded from the shared definitions
  return `<svg width="100%" height="100%" viewBox="0 0 28 28" fill="${fillValue}" xmlns="http://www.w3.org/2000/svg">
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
