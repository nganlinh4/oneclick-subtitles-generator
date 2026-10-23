/**
 * The 38 rounded polygons the PromptDJ loading indicator morphs between.
 * `RoundedPolygon` is passed in because the component loads it lazily.
 */
export const createFallbackShape = (index, RoundedPolygon) => {
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
