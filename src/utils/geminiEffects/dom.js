/**
 * DOM wiring for the Gemini button effects: observer, button init, event listeners.
 */

import { createParticles } from './particles';

/**
 * Set up the MutationObserver to detect new buttons
 * @param {Function} initCallback - Callback to initialize buttons
 * @param {boolean} observerInitialized - Whether observer is already initialized
 * @returns {boolean} - Whether observer was initialized
 */
export const setupButtonObserver = (initCallback, observerInitialized) => {
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
export const initializeButton = (button, initializedButtons, particles) => {
  // Generate a unique ID for this button if it doesn't have one
  if (!button.dataset.geminiButtonId) {
    button.dataset.geminiButtonId = `gemini-button-${Math.random().toString(36).substring(2, 11)}`;
  }

  // Check if this button has already been initialized
  const isInitialized = initializedButtons.has(button);

  // Check if the button already has a gemini-icon-container
  let iconContainer = button.querySelector('.gemini-icon-container');
  if (isInitialized && iconContainer && particles.some(particle => iconContainer.contains(particle.element))) {
    return particles;
  }

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
  initializedButtons.add(button);

  return [...particles, ...buttonParticles];
};

/**
 * Set up event listeners for a button
 * @param {HTMLElement} button - The button element
 * @param {Array} particles - Array of particles
 * @param {Object} cursorPosition - Cursor position object
 * @param {Object} isHovering - Hovering state object
 */
const buttonBindings = new WeakMap();

export const setupButtonEventListeners = (button, getParticles, cursorPosition, isHovering, wake) => {
  const previous = buttonBindings.get(button);
  if (previous) { previous.getParticles = getParticles; return; }
  const binding = { getParticles };
  buttonBindings.set(button, binding);
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
      const currentParticles = binding.getParticles().filter(p => {
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
      wake();
    }
  });

  button.addEventListener('mouseleave', () => {
    // Find all particles belonging to this button
    const iconContainer = button.querySelector('.gemini-icon-container');
    const currentParticles = binding.getParticles().filter(p => {
      return p.element.parentNode === iconContainer ||
             (p.element.parentNode && p.element.parentNode.parentNode === iconContainer);
    });

    // Return particles to their original positions when mouse leaves
    currentParticles.forEach(particle => {
      particle.isActive = false;
      // Gradually return to origin
      particle.returnToOrigin = true;
    });
    wake();
  });
};
