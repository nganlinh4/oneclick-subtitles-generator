/**
 * Physics engine for the Gemini button effects.
 */

import { PHYSICS } from './constants';

// Constants for the spatial grid optimization
const GRID_SIZE = 10; // 10x10 grid over the 100x100% area
const NUM_GRID_CELLS = GRID_SIZE * GRID_SIZE;

/**
 * Apply physics to a particle
 * @param {Object} particle - The particle to update
 */
export const applyPhysics = (particle) => {
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
export const applyReturnToOrigin = (particle) => {
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
export const applyCursorInteraction = (particle, cursorPosition) => {
  // Calculate distance from cursor to particle
  const dx = (cursorPosition.x - particle.x);
  const dy = (cursorPosition.y - particle.y);
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Apply force if within cursor radius
  if (distance > 0 && distance < PHYSICS.cursorRadius) {
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
export const handleCollisions = (particles) => {
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
export const updateParticles = (particles, cursorPosition, isHovering) => {
  // Update each particle
  particles.forEach(particle => {
    // Apply physics
    applyPhysics(particle);

    // Apply return to origin behavior
    applyReturnToOrigin(particle);

    // Apply cursor interaction if hovering
    if (particle.isActive && isHovering && cursorPosition) {
      applyCursorInteraction(particle, cursorPosition);
    }
  });

  // Handle collisions between particles
  handleCollisions(particles);
};
