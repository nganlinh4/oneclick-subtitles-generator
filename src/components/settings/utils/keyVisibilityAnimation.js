// Helper function for animating input visibility toggle with subtle fade
export const animateToggle = (elementId, currentState, setState) => {
  const element = document.getElementById(elementId);
  if (!element) {
    setState(!currentState);
    return;
  }

  // Apply fade-out animation
  element.style.animation = 'fade-out 0.15s ease-in-out forwards';

  // After animation completes, toggle state
  setTimeout(() => {
    setState(!currentState);

    // Apply fade-in animation after state change
    setTimeout(() => {
      element.style.animation = 'fade-in 0.15s ease-in-out forwards';
    }, 50);
  }, 150);
};
