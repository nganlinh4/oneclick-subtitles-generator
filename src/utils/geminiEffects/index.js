/**
 * Gemini Button Effects - Main entry point
 * Advanced physics-based animations for Gemini buttons
 * --- PERFORMANCE OPTIMIZED VERSION ---
 */

// --- Constants ---

// Physics constants
const PHYSICS = {
  friction: 0.97,       // Higher friction for slower movement (was 0.95)
  bounce: 0.4,          // Lower bounce for more elegant collisions (was 0.7)
  gravity: 0.02,        // Reduced gravity for gentler center pull (was 0.05)
  maxVelocity: 1.5,     // Lower max velocity for more controlled movement (was 3)
  collisionDistance: 15,
  cursorForce: 0.15,     // Balanced cursor force for subtle but noticeable interactions (average of 0.05 and 0.15)
  cursorRadius: 60,     // Medium radius for balanced interaction area (average of 30 and 60)
  damping: 0.92         // Additional damping to slow down movements
};

// Color schemes for particles
const COLOR_SCHEMES = [
  // Default Gemini gradient
  {
    stops: [
      { offset: '0%', color: 'rgba(145, 104, 192, 1.0)' },
      { offset: '50%', color: 'rgba(86, 132, 209, 1.0)' },
      { offset: '100%', color: 'rgba(27, 161, 227, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(145, 104, 192, 0.9)' // Star-like glow with higher opacity
  },
  // Purple-pink scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(171, 71, 188, 1.0)' },
      { offset: '100%', color: 'rgba(236, 64, 122, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(236, 64, 122, 0.9)' // Star-like glow with higher opacity
  },
  // Blue-green scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(3, 169, 244, 1.0)' },
      { offset: '100%', color: 'rgba(0, 150, 136, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(3, 169, 244, 0.9)' // Star-like glow with higher opacity
  },
  // Gold-orange scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(255, 215, 0, 1.0)' },
      { offset: '100%', color: 'rgba(255, 152, 0, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(255, 215, 0, 0.9)' // Star-like glow with higher opacity
  },
  // Teal-blue scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(0, 188, 212, 1.0)' },
      { offset: '100%', color: 'rgba(33, 150, 243, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(0, 188, 212, 0.9)' // Star-like glow with higher opacity
  },
  // Silver-white scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(224, 224, 224, 1.0)' },
      { offset: '100%', color: 'rgba(255, 255, 255, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(255, 255, 255, 0.9)' // Star-like glow with higher opacity
  },
  // Pink-purple scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(233, 30, 99, 1.0)' },
      { offset: '100%', color: 'rgba(156, 39, 176, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(233, 30, 99, 0.9)' // Star-like glow with higher opacity
  },
  // Green-blue scheme
  {
    stops: [
      { offset: '0%', color: 'rgba(46, 204, 113, 1.0)' },
      { offset: '100%', color: 'rgba(52, 152, 219, 1.0)' }
    ],
    stroke: 'none',
    glow: 'rgba(46, 204, 113, 0.9)' // Star-like glow with higher opacity
  }
];

// --- Rendering Utilities ---

/**
 * Ensures that shared SVG definitions for gradients and filters are present in the DOM.
 * This prevents creating duplicate definitions for every particle.
 */
const ensureSVGDefs = () => {
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
const createSpecialStarSVG = (isFilled, colorSchemeIndex = 0) => {
  // Use the original specialStar.svg file directly as an image
  // This ensures we get the exact same appearance as the floating settings button
  return `<img src="/static/media/specialStar.b6c33e5e0da02ba2436528574cc26cff.svg" alt="Special Star" style="width: 100%; height: 100%; object-fit: contain;" />`;
};

/**
 * Create the Gemini SVG markup with option for filled version
 * @param {boolean} isFilled - Whether to use filled version
 * @param {number} colorSchemeIndex - Index of color scheme to use
 * @returns {string} - SVG markup
 */
const createGeminiSVG = (isFilled, colorSchemeIndex = 0) => {
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
const getSizeInPixels = (sizeClass) => {
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
const updateParticleElements = (particles) => {
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

// --- Particle Utilities ---

/**
 * Check if a point is within a pill-shaped boundary
 * @param {number} x - X position (in percentage 0-100)
 * @param {number} y - Y position (in percentage 0-100)
 * @param {number} particleSize - Size of the particle in percentage
 * @returns {boolean} - True if point is within pill boundary
 */
const isWithinPillBoundary = (x, y, particleSize = 5) => {
  // Button dimensions in percentage (pill-shaped button)
  const buttonWidth = 100;
  const buttonHeight = 100;
  const radius = buttonHeight / 2; // Radius of the circular ends

  // IMPORTANT: x, y is the TOP-LEFT corner of the particle, not center!
  // So we need to check if the entire particle box fits within boundaries

  // Special stars need extra padding because they're images, not vectors
  const isSpecialStar = particleSize > 15; // Special stars are typically larger
  const extraPadding = isSpecialStar ? 8 : 5; // More padding for special stars

  // Check if the particle's bounding box is within button bounds
  // Left edge check
  if (x < extraPadding) return false;
  // Right edge check - account for particle width
  if ((x + particleSize) > (100 - extraPadding)) return false;
  // Top edge check
  if (y < extraPadding) return false;
  // Bottom edge check - account for particle height
  if ((y + particleSize) > (100 - extraPadding)) return false;

  // Now check pill-shaped boundaries for the curved ends
  // We need to check all four corners of the particle's bounding box
  const particleCorners = [
    { px: x, py: y },                              // Top-left
    { px: x + particleSize, py: y },               // Top-right
    { px: x, py: y + particleSize },               // Bottom-left
    { px: x + particleSize, py: y + particleSize }  // Bottom-right
  ];

  // Check if any corner is outside the pill shape
  for (const corner of particleCorners) {
    // Check if in left circular cap
    if (corner.px < radius) {
      const centerY = 50;
      const distFromCenter = Math.sqrt(
        Math.pow(corner.px - radius, 2) +
        Math.pow(corner.py - centerY, 2)
      );
      // Must be inside the circle minus extra padding
      if (distFromCenter > (radius - extraPadding)) {
        return false;
      }
    }

    // Check if in right circular cap
    if (corner.px > (buttonWidth - radius)) {
      const centerY = 50;
      const distFromCenter = Math.sqrt(
        Math.pow(corner.px - (buttonWidth - radius), 2) +
        Math.pow(corner.py - centerY, 2)
      );
      // Must be inside the circle minus extra padding
      if (distFromCenter > (radius - extraPadding)) {
        return false;
      }
    }
  }

  // All corners are within bounds
  return true;
};

/**
 * Poisson disk sampling for evenly distributed points with guaranteed minimum distance
 * @param {number} width - Width of the area (in percentage, e.g., 80 for 80%)
 * @param {number} height - Height of the area (in percentage, e.g., 80 for 80%)
 * @param {number} minDistance - Minimum distance between points (in percentage)
 * @param {number} maxSamples - Maximum number of samples to generate
 * @param {number} maxAttempts - Maximum attempts per sample
 * @param {Array} particleSizes - Array of particle sizes to check boundaries
 * @returns {Array} - Array of {x, y} positions
 */
const poissonDiskSampling = (width, height, minDistance, maxSamples, maxAttempts = 30, particleSizes = []) => {
  const points = [];
  const activeList = [];
  const grid = [];

  // Grid cell size should be minDistance / sqrt(2)
  const cellSize = minDistance / Math.sqrt(2);
  const gridWidth = Math.ceil(width / cellSize);
  const gridHeight = Math.ceil(height / cellSize);

  // Initialize grid
  for (let i = 0; i < gridWidth * gridHeight; i++) {
    grid[i] = -1;
  }

  // Helper function to get grid index
  const getGridIndex = (x, y) => {
    const gridX = Math.floor(x / cellSize);
    const gridY = Math.floor(y / cellSize);
    return gridY * gridWidth + gridX;
  };

  // Helper function to check if point is valid (no neighbors within minDistance)
  const isValidPoint = (x, y, particleIndex = 0) => {
    // Get particle size for this index (convert to percentage)
    const particleSize = particleSizes[particleIndex] || 12; // Default 12px
    const particleSizePercent = (particleSize / 200) * 100; // Assume ~200px button width

    // First check pill boundary with particle size
    if (!isWithinPillBoundary(x + 10, y + 10, particleSizePercent)) return false; // Add 10% offset since we work in 80x80 area

    const gridX = Math.floor(x / cellSize);
    const gridY = Math.floor(y / cellSize);

    // Check neighboring grid cells
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = gridX + dx;
        const ny = gridY + dy;

        if (nx >= 0 && nx < gridWidth && ny >= 0 && ny < gridHeight) {
          const neighborIndex = ny * gridWidth + nx;
          const pointIndex = grid[neighborIndex];

          if (pointIndex >= 0) {
            const neighbor = points[pointIndex];
            const dist = Math.sqrt((x - neighbor.x) ** 2 + (y - neighbor.y) ** 2);
            if (dist < minDistance) {
              return false;
            }
          }
        }
      }
    }

    return true;
  };

  // Start with a random initial point that's within the pill boundary
  let initialX, initialY;
  let attempts = 0;
  const particleSize = particleSizes[0] || 12;
  const particleSizePercent = (particleSize / 200) * 100;

  do {
    initialX = Math.random() * width;
    initialY = Math.random() * height;
    attempts++;
  } while (!isWithinPillBoundary(initialX + 10, initialY + 10, particleSizePercent) && attempts < 100);

  const initialPoint = { x: initialX, y: initialY };

  points.push(initialPoint);
  activeList.push(0);
  grid[getGridIndex(initialX, initialY)] = 0;

  // Generate points using Poisson disk sampling
  while (activeList.length > 0 && points.length < maxSamples) {
    // Pick a random active point
    const randomIndex = Math.floor(Math.random() * activeList.length);
    const currentPointIndex = activeList[randomIndex];
    const currentPoint = points[currentPointIndex];

    let found = false;

    // Try to generate a new point around the current point
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Generate random point in annulus between minDistance and 2*minDistance
      const angle = Math.random() * Math.PI * 2;
      const radius = minDistance + Math.random() * minDistance;

      const newX = currentPoint.x + Math.cos(angle) * radius;
      const newY = currentPoint.y + Math.sin(angle) * radius;

      if (isValidPoint(newX, newY, points.length)) {
        const newPoint = { x: newX, y: newY };
        const pointIndex = points.length;

        points.push(newPoint);
        activeList.push(pointIndex);
        grid[getGridIndex(newX, newY)] = pointIndex;

        found = true;
        break;
      }
    }

    if (!found) {
      // Remove current point from active list if no new points can be generated
      activeList.splice(randomIndex, 1);
    }
  }

  return points;
};

/**
 * Generate well-distributed positions using Poisson disk sampling
 * @param {number} particleCount - Number of particles to place
 * @param {Array} particleSizes - Array of particle sizes for adaptive spacing
 * @returns {Array} - Array of {x, y} positions
 */
const generateWellDistributedPositions = (particleCount, particleSizes) => {
  // Calculate average particle size for minimum distance
  const avgSize = particleSizes.reduce((sum, size) => sum + size, 0) / particleSizes.length;

  // Convert size to percentage for spacing (larger particles need more space)
  const minDistancePercent = (avgSize / 8) + 15; // Increased base spacing for better separation

  // Use Poisson disk sampling to generate positions
  const positions = poissonDiskSampling(
    80, // 80% width (10% margin on each side)
    80, // 80% height (10% margin on each side)
    minDistancePercent,
    particleCount * 2, // Generate more than needed, we'll pick the best ones
    40, // More attempts for better distribution
    particleSizes // Pass particle sizes for boundary checking
  );

  // Offset positions to account for margins (add 10% offset)
  const offsetPositions = positions.map(pos => ({
    x: pos.x + 10,
    y: pos.y + 10
  }));

  // Return only the number of positions we need
  return offsetPositions.slice(0, particleCount);
};

// Counter to assign a unique ID to each particle for optimized collision checks
let particleIdCounter = 0;

/**
 * Create a new particle
 * @param {number} x - X position (0-100)
 * @param {number} y - Y position (0-100)
 * @param {string} sizeClass - Size class name
 * @param {boolean} isFilled - Whether to use filled version
 * @param {boolean} useSpecialStar - Whether to use special star instead of regular Gemini star
 * @returns {Object} - Particle object
 */
const createParticle = (x, y, sizeClass, isFilled = false, useSpecialStar = false) => {
  // Randomize the color scheme - now with more color schemes
  const colorSchemeIndex = Math.floor(Math.random() * 8);

  return {
    id: particleIdCounter++,
    x,
    y,
    vx: 0,
    vy: 0,
    size: getSizeInPixels(sizeClass),
    sizeClass,
    isFilled: isFilled || Math.random() > 0.5, // 50% chance of filled version
    colorSchemeIndex,
    svg: useSpecialStar ? createSpecialStarSVG(isFilled || Math.random() > 0.5, colorSchemeIndex) : createGeminiSVG(isFilled || Math.random() > 0.5, colorSchemeIndex),
    isActive: true,
    opacity: 1,
    rotation: Math.random() * 360,
    rotationSpeed: (Math.random() - 0.5) * 0.5, // Slower rotation
    returnToOrigin: false,
    useSpecialStar
  };
};

/**
 * Create a collection of Gemini icon particles
 * @param {HTMLElement} buttonElement - The button element
 * @param {HTMLElement} container - The container for particles
 * @param {number} [limit] - Optional limit for number of particles (used for hover state)
 * @returns {Array} - Array of particle objects
 */
const createParticles = (buttonElement, container, limit) => {
  const buttonParticles = [];

  // Determine button type to create different effects
  const isGenerateButton = buttonElement.classList.contains('generate-btn');
  const isAutoGenerateButton = buttonElement.classList.contains('auto-generate');
  const isForceStopButton = buttonElement.classList.contains('force-stop-btn');
  const isVideoAnalysisButton = buttonElement.classList.contains('video-analysis-button');

  // Set particle count based on button type and limit parameter
  let particleCount;
  if (limit !== undefined) {
    // Use the exact limit if provided (for hover state)
    particleCount = limit;
  } else {
    // Default counts for initial state - reduced for better spacing
    if (isAutoGenerateButton) {
      particleCount = 8 + Math.floor(Math.random() * 4); // 8-12 particles for auto-generate (special stars need more space)
    } else if (isGenerateButton) {
      particleCount = 15 + Math.floor(Math.random() * 5); // 15-20 particles for generate button
    } else if (isForceStopButton) {
      particleCount = 12 + Math.floor(Math.random() * 3); // 12-15 particles for force stop button
    } else {
      particleCount = 10 + Math.floor(Math.random() * 5); // 10-15 particles for other buttons
    }
  }

  // Clear any existing static icons
  const existingStaticIcons = container.querySelectorAll('.gemini-mini-icon:not(.dynamic)');
  existingStaticIcons.forEach(icon => {
    icon.remove();
  });

  // Create a unique set of particles for this button
  const particleTypes = [
    { type: 'normal', chance: 0.6 },
    { type: 'trail', chance: 0.2 },
    { type: 'pulse', chance: 0.2 }
  ];

  // Pre-calculate particle sizes for proper spacing
  const particleSizes = [];
  for (let i = 0; i < particleCount; i++) {
    // Determine size class using the same logic as below
    let sizeClasses;
    if (isAutoGenerateButton) {
      sizeClasses = [
        { class: 'size-sm', weight: 0.30 },
        { class: 'size-md', weight: 0.50 },
        { class: 'size-lg', weight: 0.20 },
      ];
    } else {
      sizeClasses = [
        { class: 'size-xs', weight: 0.70 },
        { class: 'size-sm', weight: 0.30 },
      ];
    }

    // Weighted random selection for size
    let randomWeight = Math.random();
    let cumulativeWeight = 0;
    let sizeClass = 'size-sm'; // Default

    for (const size of sizeClasses) {
      cumulativeWeight += size.weight;
      if (randomWeight <= cumulativeWeight) {
        sizeClass = size.class;
        break;
      }
    }

    particleSizes.push(getSizeInPixels(sizeClass));
  }

  // Generate well-distributed positions using size information
  const positions = generateWellDistributedPositions(particleCount, particleSizes);

  // Use a DocumentFragment to batch DOM appends for performance
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < particleCount; i++) {
    // Create particle element
    const particle = document.createElement('div');

    // Randomly decide if this will be a filled or outlined icon
    const isFilled = Math.random() > 0.5; // 50% chance of filled icons

    // Use pre-calculated size (convert back to class for compatibility)
    const particleSize = particleSizes[i];
    let sizeClass;
    switch (particleSize) {
      case 8: sizeClass = 'size-xs'; break;
      case 12: sizeClass = 'size-sm'; break;
      case 16: sizeClass = 'size-md'; break;
      case 20: sizeClass = 'size-lg'; break;
      default: sizeClass = 'size-sm'; break;
    }

    // Determine particle type
    let particleTypeRandomWeight = Math.random();
    let particleTypeCumulativeWeight = 0;
    let particleType = 'normal';

    for (const type of particleTypes) {
      particleTypeCumulativeWeight += type.chance;
      if (particleTypeRandomWeight <= particleTypeCumulativeWeight) {
        particleType = type.type;
        break;
      }
    }

    // Use pre-generated well-distributed position
    let x, y;
    if (i < positions.length) {
      x = positions[i].x;
      y = positions[i].y;
    } else {
      // Fallback to random position if we somehow have more particles than positions
      x = 10 + Math.random() * 80;
      y = 10 + Math.random() * 80;
    }

    // Create the particle object using our utility function
    // Use special star for auto-generate buttons
    const particleObj = createParticle(x, y, sizeClass, isFilled, isAutoGenerateButton);

    // Add DOM element reference
    particleObj.element = particle;

    // Add to button particles collection
    buttonParticles.push(particleObj);

    // Set up the particle element
    particle.className = `gemini-mini-icon dynamic ${sizeClass} ${particleType}`;
    particle.innerHTML = particleObj.svg;
    particle.style.position = 'absolute';
    particle.style.left = `${x}%`;
    particle.style.top = `${y}%`;
    particle.style.transform = `rotate(${particleObj.rotation}deg)`;
    particle.style.opacity = '0'; // Start invisible
    particle.style.transition = 'opacity 0.3s ease-out';

    // Add the particle to the fragment
    fragment.appendChild(particle);

    // Create trail particles if this is a trail type
    if (particleType === 'trail') {
      particleObj.trailParticles = [];
      const trailCount = 3 + Math.floor(Math.random() * 3); // 3-5 trail particles

      for (let t = 0; t < trailCount; t++) {
        const trailElement = document.createElement('div');
        trailElement.className = `gemini-mini-icon trail ${sizeClass}`;
        trailElement.innerHTML = particleObj.svg;
        trailElement.style.position = 'absolute';
        trailElement.style.left = `${x}%`;
        trailElement.style.top = `${y}%`;
        trailElement.style.transform = `rotate(${particleObj.rotation}deg) scale(${0.8 - (t * 0.15)})`;
        trailElement.style.opacity = '0';
        trailElement.style.transition = 'opacity 0.3s ease-out';
        trailElement.style.zIndex = '-1';

        fragment.appendChild(trailElement);

        particleObj.trailParticles.push({
          element: trailElement,
          offsetX: 0,
          offsetY: 0,
          opacity: 0.7 - (t * 0.2)
        });
      }
    }
  }

  // Append all particles to the container in a single operation
  container.appendChild(fragment);

  return buttonParticles;
};

/**
 * Clean up particles that are no longer in the DOM by modifying the array in-place.
 * @param {Array} particles - Array of particles
 * @returns {Array} - The same, but mutated, array of particles
 */
const cleanupParticles = (particles) => {
  for (let i = particles.length - 1; i >= 0; i--) {
    const particle = particles[i];
    if (!particle.element.isConnected) {
      // Remove any trail particles
      if (particle.trailParticles) {
        particle.trailParticles.forEach(trail => {
          if (trail.element && trail.element.parentNode) {
            trail.element.remove();
          }
        });
      }
      // Remove the particle from the array
      particles.splice(i, 1);
    }
  }
  return particles; // Return the mutated array for chaining, though it's modified in place
};

// --- Physics Engine ---

// Constants for the spatial grid optimization
const GRID_SIZE = 10; // 10x10 grid over the 100x100% area
const NUM_GRID_CELLS = GRID_SIZE * GRID_SIZE;

/**
 * Apply physics to a particle
 * @param {Object} particle - The particle to update
 */
const applyPhysics = (particle) => {
  if (!particle.isActive) return;

  // Apply friction
  particle.vx *= PHYSICS.friction;
  particle.vy *= PHYSICS.friction;

  // Apply additional damping for more elegant movement
  particle.vx *= PHYSICS.damping;
  particle.vy *= PHYSICS.damping;

  // Add very subtle random movement to create a floating effect
  particle.vx += (Math.random() - 0.5) * 0.01;
  particle.vy += (Math.random() - 0.5) * 0.01;

  // Apply the velocity
  particle.x += particle.vx;
  particle.y += particle.vy;

  // Boundary checking - bounce off edges with reduced velocity
  if (particle.x < 5) {
    particle.x = 5;
    particle.vx = Math.abs(particle.vx) * 0.5; // Bounce with reduced energy
  } else if (particle.x > 95) {
    particle.x = 95;
    particle.vx = -Math.abs(particle.vx) * 0.5; // Bounce with reduced energy
  }

  if (particle.y < 5) {
    particle.y = 5;
    particle.vy = Math.abs(particle.vy) * 0.5; // Bounce with reduced energy
  } else if (particle.y > 95) {
    particle.y = 95;
    particle.vy = -Math.abs(particle.vy) * 0.5; // Bounce with reduced energy
  }

  // Limit velocity
  const speed = Math.sqrt(particle.vx * particle.vx + particle.vy * particle.vy);
  if (speed > PHYSICS.maxVelocity) {
    particle.vx = (particle.vx / speed) * PHYSICS.maxVelocity;
    particle.vy = (particle.vy / speed) * PHYSICS.maxVelocity;
  }

  // Update rotation
  particle.rotation += particle.rotationSpeed;
};

/**
 * Apply return to origin behavior for a particle
 * @param {Object} particle - The particle to update
 */
const applyReturnToOrigin = (particle) => {
  if (!particle.returnToOrigin) return;

  // Apply stronger damping to gradually stop movement
  particle.vx *= 0.9;
  particle.vy *= 0.9;

  // Apply the velocity
  particle.x += particle.vx;
  particle.y += particle.vy;

  // If almost stopped, mark as not returning to origin
  if (Math.abs(particle.vx) < 0.01 && Math.abs(particle.vy) < 0.01) {
    particle.returnToOrigin = false;
  }
};

/**
 * Apply cursor interaction to a particle
 * @param {Object} particle - The particle to update
 * @param {Object} cursorPosition - Current cursor position
 */
const applyCursorInteraction = (particle, cursorPosition) => {
  // Calculate distance from cursor to particle
  const dx = (cursorPosition.x - particle.x);
  const dy = (cursorPosition.y - particle.y);
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Apply force if within cursor radius
  if (distance < PHYSICS.cursorRadius) {
    // Calculate force based on distance (stronger when closer)
    const force = (1 - distance / PHYSICS.cursorRadius) * PHYSICS.cursorForce;

    // Apply force away from cursor
    particle.vx -= (dx / distance) * force;
    particle.vy -= (dy / distance) * force;
  }
};

/**
 * Handle collisions between particles using a spatial grid for optimization.
 * This changes the complexity from O(n^2) to roughly O(n), greatly improving performance.
 * @param {Array} particles - Array of particles
 */
const handleCollisions = (particles) => {
  // 1. Initialize the grid.
  const grid = [];
  for (let i = 0; i < NUM_GRID_CELLS; i++) {
    grid.push([]);
  }

  // 2. Place each active particle into a cell in the grid.
  for (const p of particles) {
    if (p.isActive) {
      const cellX = Math.floor(p.x / GRID_SIZE);
      const cellY = Math.floor(p.y / GRID_SIZE);
      if (cellX >= 0 && cellX < GRID_SIZE && cellY >= 0 && cellY < GRID_SIZE) {
        grid[cellY * GRID_SIZE + cellX].push(p);
      }
    }
  }

  // 3. For each particle, check for collisions only with particles in neighboring cells.
  for (const p1 of particles) {
    if (!p1.isActive) continue;

    const cellX = Math.floor(p1.x / GRID_SIZE);
    const cellY = Math.floor(p1.y / GRID_SIZE);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const checkCellX = cellX + dx;
        const checkCellY = cellY + dy;

        if (checkCellX >= 0 && checkCellX < GRID_SIZE && checkCellY >= 0 && checkCellY < GRID_SIZE) {
          const cellParticles = grid[checkCellY * GRID_SIZE + checkCellX];

          for (const p2 of cellParticles) {
            // Ensure we don't check a particle against itself and check each pair only once.
            if (p1.id >= p2.id) continue;

            const dx_coll = p2.x - p1.x;
            const dy_coll = p2.y - p1.y;
            const distanceSq = dx_coll * dx_coll + dy_coll * dy_coll;
            const minDistance = (p1.size + p2.size) / 2 / 10;
            const minDistanceSq = minDistance * minDistance;

            if (distanceSq < minDistanceSq) {
              const distance = Math.sqrt(distanceSq);
              const angle = Math.atan2(dy_coll, dx_coll);
              const sin = Math.sin(angle);
              const cos = Math.cos(angle);
              const vx1 = p1.vx * cos + p1.vy * sin;
              const vy1 = p1.vy * cos - p1.vx * sin;
              const vx2 = p2.vx * cos + p2.vy * sin;
              const vy2 = p2.vy * cos - p2.vx * sin;
              const newVx1 = ((vx1 * (p1.size - p2.size) + 2 * p2.size * vx2) / (p1.size + p2.size)) * PHYSICS.bounce;
              const newVx2 = ((vx2 * (p2.size - p1.size) + 2 * p1.size * vx1) / (p1.size + p2.size)) * PHYSICS.bounce;
              p1.vx = newVx1 * cos - vy1 * sin;
              p1.vy = vy1 * cos + newVx1 * sin;
              p2.vx = newVx2 * cos - vy2 * sin;
              p2.vy = vy2 * cos + newVx2 * sin;
              const overlap = minDistance - distance;
              const moveX = (overlap / 2) * cos;
              const moveY = (overlap / 2) * sin;
              p1.x -= moveX;
              p1.y -= moveY;
              p2.x += moveX;
              p2.y += moveY;
            }
          }
        }
      }
    }
  }
};


/**
 * Update particles based on physics and interactions
 * @param {Array} particles - Array of particles
 * @param {Object} cursorPosition - Current cursor position
 * @param {boolean} isHovering - Whether cursor is hovering
 */
const updateParticles = (particles, cursorPosition, isHovering) => {
  // Update each particle
  particles.forEach(particle => {
    // Apply physics
    applyPhysics(particle);

    // Apply return to origin behavior
    applyReturnToOrigin(particle);

    // Apply cursor interaction if hovering
    if (isHovering && cursorPosition) {
      applyCursorInteraction(particle, cursorPosition);
    }
  });

  // Handle collisions between particles
  handleCollisions(particles);
};

// --- DOM Utilities ---

/**
 * Set up the MutationObserver to detect new buttons
 * @param {Function} initCallback - Callback to initialize buttons
 * @param {boolean} observerInitialized - Whether observer is already initialized
 * @returns {boolean} - Whether observer was initialized
 */
const setupButtonObserver = (initCallback, observerInitialized) => {
  if (observerInitialized) return true;

  const observer = new MutationObserver((mutations) => {
    let shouldReinitialize = false;

    mutations.forEach(mutation => {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        // Check if any of the added nodes are buttons or contain buttons
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the node itself is a button with the relevant classes
            if (
              (node.classList &&
                (node.classList.contains('generate-btn') ||
                 node.classList.contains('retry-gemini-btn') ||
                 node.classList.contains('force-stop-btn') ||
                 node.classList.contains('cancel-download-btn') ||
                 node.classList.contains('add-subtitles-button') ||
                 node.classList.contains('srt-upload-button') ||
                 node.classList.contains('video-analysis-button') ||
                 node.classList.contains('lets-go-btn')) &&
                !(node.classList.contains('translate-button') || node.classList.contains('download-btn')))
            ) {
              shouldReinitialize = true;
            }

            // Check if the node contains buttons with the relevant classes (excluding translate and download buttons)
            const buttons = node.querySelectorAll('.generate-btn:not(.translate-button):not(.download-btn), .retry-gemini-btn, .force-stop-btn, .cancel-download-btn, .add-subtitles-button, .srt-upload-button, .video-analysis-button, .lets-go-btn');
            if (buttons.length > 0) {
              shouldReinitialize = true;
            }
          }
        });
      }
    });

    if (shouldReinitialize) {
      initCallback();
    }
  });

  // Start observing the document with the configured parameters
  observer.observe(document.body, { childList: true, subtree: true });

  return true;
};

/**
 * Initialize a button with Gemini effects
 * @param {HTMLElement} button - The button element
 * @param {Set} initializedButtons - Set of initialized button IDs
 * @param {Array} particles - Array of particles
 * @returns {Array} - Updated array of particles
 */
const initializeButton = (button, initializedButtons, particles) => {
  // Generate a unique ID for this button if it doesn't have one
  if (!button.dataset.geminiButtonId) {
    button.dataset.geminiButtonId = `gemini-button-${Math.random().toString(36).substring(2, 11)}`;
  }

  // Check if this button has already been initialized
  const isInitialized = initializedButtons.has(button.dataset.geminiButtonId);

  // Check if the button already has a gemini-icon-container
  let iconContainer = button.querySelector('.gemini-icon-container');

  // If not, create a new one
  if (!iconContainer) {
    iconContainer = document.createElement('div');
    iconContainer.className = 'gemini-icon-container';
    button.appendChild(iconContainer);
  }

  // If the button is already initialized, remove all existing particles for this button
  if (isInitialized) {
    // Find all particles belonging to this button
    const buttonParticles = particles.filter(p => {
      return p.element.parentNode === iconContainer ||
             (p.element.parentNode && p.element.parentNode.parentNode === iconContainer);
    });

    // Remove these particles from the global collection
    particles = particles.filter(p => !buttonParticles.includes(p));

    // Remove the particles from the DOM
    buttonParticles.forEach(particle => {
      if (particle.element && particle.element.parentNode) {
        particle.element.remove();
      }

      // Also remove any trail particles
      if (particle.trailParticles) {
        particle.trailParticles.forEach(trail => {
          if (trail.element && trail.element.parentNode) {
            trail.element.remove();
          }
        });
      }
    });

    // Clear the container
    iconContainer.innerHTML = '';
  }

  // Create a collection of particles for this button - use a few particles for initial state
  const isAutoGenerate = button.classList.contains('auto-generate');
  const initialCount = isAutoGenerate ? 6 : // Fewer particles for auto-generate to prevent overlap
                      button.classList.contains('generate-btn') ? 10 :
                      button.classList.contains('cancel-download-btn') ? 8 :
                      button.classList.contains('add-subtitles-button') ? 6 :
                      button.classList.contains('video-analysis-button') ? 8 : 4;
  const buttonParticles = createParticles(button, iconContainer, initialCount);

  // Make sure they're initially inactive/invisible
  // All buttons start with invisible particles, including auto-generate
  buttonParticles.forEach(particle => {
    particle.isActive = false;
  });

  // Mark this button as initialized
  initializedButtons.add(button.dataset.geminiButtonId);

  return [...particles, ...buttonParticles];
};

/**
 * Set up event listeners for a button
 * @param {HTMLElement} button - The button element
 * @param {Array} particles - Array of particles
 * @param {Object} cursorPosition - Cursor position object
 * @param {Object} isHovering - Hovering state object
 */
const setupButtonEventListeners = (button, particles, cursorPosition, isHovering) => {
  // Add mouse move event listener for cursor tracking
  button.addEventListener('mousemove', (e) => {
    const rect = e.currentTarget.getBoundingClientRect();

    // Calculate cursor position as percentage of button dimensions
    cursorPosition.x = ((e.clientX - rect.left) / rect.width) * 100;
    cursorPosition.y = ((e.clientY - rect.top) / rect.height) * 100;

    isHovering.value = true;

    // Reset hovering state after mouse stops moving
    clearTimeout(window.cursorTimeout);
    window.cursorTimeout = setTimeout(() => {
      isHovering.value = false;
    }, 100);
  });

  // Add processing class when button is clicked (for animation state)
  button.addEventListener('click', () => {
    if (!button.disabled) {
      button.classList.add('processing');
    }
  });

  // Add mouse enter/leave events for special effects
  button.addEventListener('mouseenter', () => {
    if (!button.disabled) {
      // Find all particles belonging to this button
      const iconContainer = button.querySelector('.gemini-icon-container');
      const currentParticles = particles.filter(p => {
        return p.element.parentNode === iconContainer ||
               (p.element.parentNode && p.element.parentNode.parentNode === iconContainer);
      });

      // Activate the existing particles with scattered velocities
      currentParticles.forEach(particle => {
        particle.isActive = true;

        // Give each particle a unique direction to create a scattered effect
        const angle = Math.random() * Math.PI * 2; // Random angle in radians
        const speed = 0.2 + Math.random() * 0.4; // Random speed between 0.2 and 0.6

        // Convert angle and speed to x,y velocity components
        particle.vx = Math.cos(angle) * speed;
        particle.vy = Math.sin(angle) * speed;
      });
    }
  });

  button.addEventListener('mouseleave', () => {
    // Find all particles belonging to this button
    const iconContainer = button.querySelector('.gemini-icon-container');
    const currentParticles = particles.filter(p => {
      return p.element.parentNode === iconContainer ||
             (p.element.parentNode && p.element.parentNode.parentNode === iconContainer);
    });

    // Return particles to their original positions when mouse leaves
    currentParticles.forEach(particle => {
      particle.isActive = false;
      // Gradually return to origin
      particle.returnToOrigin = true;
    });
  });
};

// --- Button State ---

// --- Main Entry Point ---

// Collection of all active particles
let particles = [];

// Set to track initialized buttons to prevent duplicate initialization
const initializedButtons = new Set();

// Flag to track if the observer is already set up
let observerInitialized = false;

// Track cursor position for interactions
const cursorPosition = { x: 0, y: 0 };
const isHovering = { value: false };

/**
 * Initialize Gemini button effects
 */
export function initGeminiButtonEffects() {
  // Respect user setting to disable Gemini effects entirely
  const effectsEnabled = localStorage.getItem('enable_gemini_effects') !== 'false';
  if (!effectsEnabled) {
    // If disabled, make sure any previous animation loop is stopped
    if (window.geminiAnimationFrameId) {
      cancelAnimationFrame(window.geminiAnimationFrameId);
      window.geminiAnimationFrameId = null;
    }
    return;
  }

  // Ensure the shared SVG definitions are in the DOM
  ensureSVGDefs();

  // Set up the MutationObserver to detect new buttons
  observerInitialized = setupButtonObserver(initGeminiButtonEffects, observerInitialized);

  // Find all Gemini buttons (excluding translate and download buttons to reduce lag)
  const generateButtons = document.querySelectorAll('.generate-btn:not(.translate-button):not(.download-btn)');
  const retryButtons = document.querySelectorAll('.retry-gemini-btn');
  const forceStopButtons = document.querySelectorAll('.force-stop-btn');
  const srtUploadButtons = document.querySelectorAll('.srt-upload-button');
  const addSubtitlesButtons = document.querySelectorAll('.add-subtitles-button');
  const videoAnalysisButtons = document.querySelectorAll('.video-analysis-button');
  const letsGoButtons = document.querySelectorAll('.lets-go-btn');
  // Translate and download buttons excluded to reduce lag
  const translateButtons = [];
  const downloadButtons = [];

  // First, clean up any particles that are no longer in the DOM
  particles = cleanupParticles(particles);

  // Apply effects to all buttons
  [...generateButtons, ...retryButtons, ...forceStopButtons, ...srtUploadButtons, ...addSubtitlesButtons, ...videoAnalysisButtons, ...letsGoButtons, ...translateButtons, ...downloadButtons].forEach(button => {
    // Initialize the button and get updated particles array
    particles = initializeButton(button, initializedButtons, particles);

    // Set up event listeners for the button
    setupButtonEventListeners(button, particles, cursorPosition, isHovering);
  });

  // Start the animation loop if it's not already running
  if (!window.geminiAnimationFrameId) {
    window.geminiAnimationFrameId = requestAnimationFrame(animateParticles);
  }
};

/**
 * Reset processing state when generation is complete
 */
export const resetGeminiButtonState = () => {
  const buttons = document.querySelectorAll('.generate-btn, .retry-gemini-btn, .srt-upload-button');
  buttons.forEach(button => {
    button.classList.remove('processing');
  });
};

/**
 * Completely reset all Gemini button effects
 * This will remove all particles and reinitialize the effects
 */
export const resetAllGeminiButtonEffects = () => {
  // Remove all particles from the DOM
  if (particles && particles.length > 0) {
    particles.forEach(particle => {
      if (particle.element && particle.element.parentNode) {
        particle.element.remove();
      }

      // Also remove any trail particles
      if (particle.trailParticles) {
        particle.trailParticles.forEach(trail => {
          if (trail.element && trail.element.parentNode) {
            trail.element.remove();
          }
        });
      }
    });

    // Clear the particles array
    particles.length = 0;
  }

  // Clear the initialized buttons set
  initializedButtons.clear();

  // Re-initialize the effects
  initGeminiButtonEffects();
};

/**
 * Animate all particles
 */
const animateParticles = () => {
  // Update all particles
  updateParticles(particles, cursorPosition, isHovering.value);

  // Update DOM elements to match particle states
  updateParticleElements(particles);

  // Continue animation loop
  window.geminiAnimationFrameId = requestAnimationFrame(animateParticles);
};

// Export the initialization function
export default initGeminiButtonEffects;

/**
 * Disable all Gemini button effects immediately and clean up
 */
export const disableGeminiButtonEffects = () => {
  // Stop animation frame
  if (window.geminiAnimationFrameId) {
    cancelAnimationFrame(window.geminiAnimationFrameId);
    window.geminiAnimationFrameId = null;
  }
  // Remove all particle elements
  const particleEls = document.querySelectorAll('.gemini-mini-icon');
  particleEls.forEach(el => el.remove());
  // Remove icon containers
  const containers = document.querySelectorAll('.gemini-icon-container');
  containers.forEach(c => c.remove());
};