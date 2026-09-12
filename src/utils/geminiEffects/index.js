/**
 * Gemini Button Effects - Main entry point
 * Advanced physics-based animations for Gemini buttons.
 * --- PERFORMANCE OPTIMIZED VERSION ---
 *
 * Implementation is split across sibling modules: constants, rendering, particles, physics, dom.
 */

import { ensureSVGDefs, updateParticleElements } from './rendering';
import { cleanupParticles } from './particles';
import { updateParticles } from './physics';
import { setupButtonObserver, initializeButton, setupButtonEventListeners } from './dom';

// Collection of all active particles
let particles = [];

// Set to track initialized buttons to prevent duplicate initialization
let initializedButtons = new WeakSet();

// Flag to track if the observer is already set up
let observerInitialized = false;

// Track cursor position for interactions
const cursorPosition = { x: 0, y: 0 };
const isHovering = { value: false };

const wakeParticles = () => {
  if (!window.geminiAnimationFrameId && localStorage.getItem('enable_gemini_effects') !== 'false') {
    window.geminiAnimationFrameId = requestAnimationFrame(animateParticles);
  }
};

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
    setupButtonEventListeners(button, () => particles, cursorPosition, isHovering, wakeParticles);
  });

  // Start the animation loop if it's not already running
  wakeParticles();
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
  initializedButtons = new WeakSet();

  // Re-initialize the effects
  initGeminiButtonEffects();
};

/**
 * Animate all particles
 */
const animateParticles = () => {
  window.geminiAnimationFrameId = null;
  particles = cleanupParticles(particles);
  const moving = particles.some(particle => particle.isActive || particle.returnToOrigin);
  // Update all particles
  if (moving) updateParticles(particles, cursorPosition, isHovering.value);

  // Update DOM elements to match particle states
  updateParticleElements(particles);

  // Hover events wake the loop again. Invisible, settled particles need no frames or grid work.
  if (particles.some(particle => particle.isActive || particle.returnToOrigin)) wakeParticles();
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
  particles = [];
  initializedButtons = new WeakSet();
  clearTimeout(window.cursorTimeout);
  isHovering.value = false;
};
