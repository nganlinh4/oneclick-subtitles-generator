import { useState, useEffect } from 'react';
import '../styles/OnboardingBanner.css';
// Import the animation component from src/assets
import OnboardingAnimation from '../assets/onboarding-banner';
import OnboardingCursorInteraction from './OnboardingCursorInteraction';

/**
 * Onboarding Banner component that shows for first-time visitors
 * Displays the onboarding banner immediately and allows dismissal after 4 seconds
 */
const OnboardingBanner = () => {
  // State for tracking if user can dismiss the banner
  const [canDismiss, setCanDismiss] = useState(false);

  // State for tracking if user has visited before
  const [hasVisited, setHasVisited] = useState(true);

  // State for countdown timer
  const [countdown, setCountdown] = useState(4);

  // State for dismissing animation
  const [isDismissing, setIsDismissing] = useState(false);

  useEffect(() => {
    // Check if user has visited before
    const hasVisitedBefore = localStorage.getItem('has_visited_site') === 'true';
    setHasVisited(hasVisitedBefore);

    // If this is the first visit, start the countdown
    if (!hasVisitedBefore) {
      // Set up countdown timer that updates every second
      const countdownInterval = setInterval(() => {
        setCountdown(prevCount => {
          // When countdown reaches 1, clear the interval and allow dismissal
          if (prevCount <= 1) {
            clearInterval(countdownInterval);
            setCanDismiss(true);
            return 0;
          }
          return prevCount - 1;
        });
      }, 1000);

      // Clean up interval on component unmount
      return () => clearInterval(countdownInterval);
    }
  }, []);

  // Function to assign random fly-out directions to SVG paths
  const assignRandomFlyDirections = () => {
    // Get all SVG paths
    const paths = document.querySelectorAll('.svg-container svg path');

    // Convert NodeList to Array for easier manipulation
    const pathsArray = Array.from(paths);

    // Shuffle the array to randomize the order of animations
    const shuffledPaths = pathsArray.sort(() => Math.random() - 0.5);

    // Assign random fly-out directions to each path
    shuffledPaths.forEach((path, index) => {
      // Random direction (positive or negative) - much larger values for more dramatic effect
      const randomX = (Math.random() - 0.5) * 1500; // -750px to 750px
      const randomY = (Math.random() - 0.5) * 1500; // -750px to 750px

      // Random rotation (-360deg to 360deg)
      const randomRotation = (Math.random() - 0.5) * 720;

      // Random transform origin for more natural movement
      const randomOriginX = Math.random() * 100 + '%';
      const randomOriginY = Math.random() * 100 + '%';

      // Random duration (0.8s to 1.5s) for varied speed
      const randomDuration = 0.8 + Math.random() * 0.7;

      // Random easing function for varied movement
      const easings = [
        'cubic-bezier(0.25, 0.1, 0.25, 1)',
        'cubic-bezier(0.42, 0, 0.58, 1)',
        'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
        'cubic-bezier(0.55, 0.085, 0.68, 0.53)'
      ];
      const randomEasing = easings[Math.floor(Math.random() * easings.length)];

      // Staggered delay based on shuffled index (0ms to 400ms)
      // More paths at the beginning, fewer at the end for natural effect
      const baseDelay = Math.pow(index / shuffledPaths.length, 1.5) * 400;
      const randomVariation = Math.random() * 100; // Add some randomness
      const finalDelay = baseDelay + randomVariation;

      // Set custom properties for the animation
      path.style.setProperty('--fly-x', `${randomX}px`);
      path.style.setProperty('--fly-y', `${randomY}px`);
      path.style.setProperty('--fly-rotate', `${randomRotation}deg`);
      path.style.setProperty('--fly-delay', `${finalDelay}ms`);
      path.style.setProperty('--origin-x', randomOriginX);
      path.style.setProperty('--origin-y', randomOriginY);
      path.style.setProperty('--duration', `${randomDuration}s`);
      path.style.setProperty('--easing', randomEasing);
    });
  };

  const handleDismiss = () => {
    // Only allow dismissal if the timer has elapsed
    if (canDismiss) {
      // Start dismissing animation
      setIsDismissing(true);

      // Assign random fly-out directions
      assignRandomFlyDirections();

      // After animation completes, mark as visited and hide
      setTimeout(() => {
        // Mark that the user has visited the site
        localStorage.setItem('has_visited_site', 'true');
        // Update state to hide the banner
        setHasVisited(true);
      }, 2200); // Wait for animations to complete (up to 1.5s + 0.4s delay + 0.3s buffer)
    }
  };

  // Don't render anything if user has visited before
  if (hasVisited) {
    return null;
  }

  // Render the banner for first-time visitors
  return (
    <div
      className={`onboarding-overlay ${canDismiss ? 'can-dismiss' : 'wait-to-dismiss'} ${isDismissing ? 'dismissing' : ''}`}
      onClick={handleDismiss}
    >
      <div className="onboarding-banner-container">
        {/* Animation component with cursor interaction */}
        <div className="svg-container">
          <OnboardingCursorInteraction
            isDismissing={isDismissing}
            canDismiss={canDismiss}
          >
            <OnboardingAnimation
              width="800px"
              height="800px"
              className="onboarding-banner"
            />
          </OnboardingCursorInteraction>
        </div>

        {/* Message that changes based on countdown state */}
        <div className="onboarding-message">
          {canDismiss ? (
            "Click anywhere to continue"
          ) : (
            <span>
              Please wait <span className="countdown">{countdown}</span>
              second{countdown !== 1 ? 's' : ''}...
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export default OnboardingBanner;
