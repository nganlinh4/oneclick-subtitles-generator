import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/Header.css';
import GeminiHeaderAnimation from './GeminiHeaderAnimation';
import specialStarIcon from '../assets/specialStar.svg';
import { detectStartupMode } from '../platform/startupService';

import {
  refreshDesktopUpdateCheck,
  startStartupUpdateCheck,
  subscribeDesktopUpdateStatus,
} from '../platform/startupUpdateCoordinator';
const Header = ({ onSettingsClick }) => {
  const { t } = useTranslation();
  const [showFloatingActions, setShowFloatingActions] = useState(true); // Start as visible
  const hideTimeoutRef = useRef(null);
  const initialShowTimeoutRef = useRef(null);
  const [isInitialShow, setIsInitialShow] = useState(true); // Track if we're in initial show period
  const [settingsOpenCount, setSettingsOpenCount] = useState(0); // Track how many times settings have been opened
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const [isVercelMode, setIsVercelMode] = useState(false); // Track if running via npm start (Vercel)
  const [startupModeDetected, setStartupModeDetected] = useState(false); // Track if startup mode detection is complete

  // Define the position update function outside useEffect so it can be reused
  const updateFloatingActionsPosition = () => {
    const floatingSettings = document.querySelector('.floating-settings');
    const appHeader = document.querySelector('.app-header');

    if (floatingSettings && appHeader) {
      const scrollY = window.scrollY;

      // Position the floating settings button to move with the page scroll
      // Use the header's height and padding for alignment, but position relative to scroll
      const headerHeight = 60; // min-height from CSS
      const buttonHeight = 48; // Height of the larger settings button
      const verticalOffset = (headerHeight - buttonHeight) / 2; // Center within header height

      floatingSettings.style.top = `${scrollY + verticalOffset}px`;

      // Align horizontally with the header's right padding
      const headerStyles = window.getComputedStyle(appHeader);
      const headerPadding = headerStyles.paddingRight;
      floatingSettings.style.right = headerPadding;
    }
  };


  useEffect(() => {
    // Check how many times user has opened settings
    const count = parseInt(localStorage.getItem('settings_open_count') || '0');
    setSettingsOpenCount(count);

    // If user has opened settings less than 5 times, keep button always visible
    if (count < 5) {
      setShowFloatingActions(true);
      setIsInitialShow(false); // Skip initial show period, just stay visible
      updateFloatingActionsPosition();
      return;
    }

    // Check if user has visited before (onboarding banner logic)
    const hasVisitedBefore = localStorage.getItem('has_visited_site') === 'true';

    if (hasVisitedBefore) {
      // User has visited before, start the 5-second auto-show immediately
      updateFloatingActionsPosition();

      initialShowTimeoutRef.current = setTimeout(() => {
        setIsInitialShow(false);
        setShowFloatingActions(false);
      }, 5000);
    } else {
      // First-time user, wait for onboarding banner to be dismissed
      // Hide the floating settings initially
      setShowFloatingActions(false);

      // Poll localStorage to detect when onboarding is dismissed
      const checkOnboardingDismissed = setInterval(() => {
        const hasVisitedNow = localStorage.getItem('has_visited_site') === 'true';
        if (hasVisitedNow) {
          clearInterval(checkOnboardingDismissed);

          // Onboarding dismissed, now show floating settings for 5 seconds
          setShowFloatingActions(true);
          updateFloatingActionsPosition();

          initialShowTimeoutRef.current = setTimeout(() => {
            setIsInitialShow(false);
            setShowFloatingActions(false);
          }, 5000);
        }
      }, 100); // Check every 100ms

      // Cleanup interval on unmount
      return () => {
        clearInterval(checkOnboardingDismissed);
      };
    }

    // Cleanup initial timeout on unmount
    return () => {
      if (initialShowTimeoutRef.current) {
        clearTimeout(initialShowTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {

    const handleMouseMove = (e) => {
      // Don't handle mouse events during initial show period
      if (isInitialShow) return;

      // If user has opened settings less than 5 times, keep button always visible
      if (settingsOpenCount < 5) return;

      // Show floating actions when cursor is near the top-right area of the current viewport
      const viewportWidth = window.innerWidth;
      const isMobile = viewportWidth <= 768;

      // Define detection zone in the top-right area of the viewport
      const topZone = isMobile ? 100 : 120;
      const rightZone = isMobile ? 100 : 150;

      const isInTopRightZone =
        e.clientY <= topZone &&
        e.clientX >= (viewportWidth - rightZone);

      if (isInTopRightZone) {
        // Clear any pending hide timeout
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
          hideTimeoutRef.current = null;
        }
        setShowFloatingActions(true);
        // Update position when showing
        updateFloatingActionsPosition();
      } else {
        // Add a small delay before hiding to prevent flickering
        if (hideTimeoutRef.current) {
          clearTimeout(hideTimeoutRef.current);
        }
        hideTimeoutRef.current = setTimeout(() => {
          setShowFloatingActions(false);
        }, 300);
      }

    };

    const handleMouseLeave = () => {
      // Don't handle mouse leave during initial show period
      if (isInitialShow) return;

      // If user has opened settings less than 5 times, keep button always visible
      if (settingsOpenCount < 5) return;

      // Hide when mouse leaves the window with a slight delay
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      hideTimeoutRef.current = setTimeout(() => {
        setShowFloatingActions(false);
      }, 500);

    };

    const handleScroll = () => {
      // Update position on scroll if floating actions are visible
      if (showFloatingActions) {
        updateFloatingActionsPosition();
      }
    };

    // Add event listeners
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('scroll', handleScroll);

    // Cleanup
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('scroll', handleScroll);
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
    };
  }, [showFloatingActions, isInitialShow, settingsOpenCount]);

  // Detect startup mode (lite vs full version)
  useEffect(() => {
    const detectAndApplyStartupMode = async () => {
      try {
        const startupMode = await detectStartupMode();

        if (startupMode.backendAvailable) {
          setIsVercelMode(startupMode.isVercelMode);
          try {
            localStorage.setItem('backend_available', 'true');
            localStorage.setItem('is_vercel_mode', startupMode.isVercelMode ? 'true' : 'false');
          } catch {
            // Compatibility metadata is optional; native state remains authoritative.
          }
        } else {
          // Server responded but not OK (e.g., 404) => treat as missing backend
          setIsVercelMode(true);
          try {
            localStorage.setItem('backend_available', 'false');
            localStorage.setItem('is_vercel_mode', 'true');
          } catch {
            // Compatibility metadata is optional; native state remains authoritative.
          }
        }
      } catch (error) {
        // If we can't contact the server at all, assume Vercel (npm start) mode
        setIsVercelMode(true);
        try {
          localStorage.setItem('backend_available', 'false');
          localStorage.setItem('is_vercel_mode', 'true');
        } catch {
          // Compatibility metadata is optional; native state remains authoritative.
        }
      } finally {
        // Mark startup mode detection as complete regardless of success/failure
        setStartupModeDetected(true);
      }
    };

    detectAndApplyStartupMode();
  }, []);

  // Handle settings click - increment count and call original handler
  const handleSettingsClick = () => {
    // Increment the settings open count
    const newCount = settingsOpenCount + 1;
    localStorage.setItem('settings_open_count', newCount.toString());
    setSettingsOpenCount(newCount);

    // Call the original settings click handler
    onSettingsClick();
  };



  // Check for updates to show badge on floating settings button
  useEffect(() => {
    let mounted = true;
    const applyStatus = (status) => {
      if (mounted) setUpdateAvailable(Boolean(status?.configured && status.update));
    };
    const unsubscribe = subscribeDesktopUpdateStatus(applyStatus);
    startStartupUpdateCheck().then(applyStatus);
    const id = setInterval(() => {
      refreshDesktopUpdateCheck().then(applyStatus);
    }, 30 * 60 * 1000);
    return () => { mounted = false; clearInterval(id); unsubscribe(); };
  }, []);
  return (
    <header className="app-header">
      {/* Gemini constellation animation */}
      {localStorage.getItem('enable_gemini_effects') !== 'false' && (
        <GeminiHeaderAnimation />
      )}



      <div className="header-title-container">
        <h1 className="header-title">
          <span className="osg-main">OSG</span>
          {startupModeDetected && isVercelMode && (
            <span className="osg-version">
              {` (${t('header.versionVercel')})`}
            </span>
          )}
        </h1>
      </div>


      <button
        className={`settings-button floating-settings ${showFloatingActions ? 'floating-visible' : 'floating-hidden'}`}
        data-app-action="open-settings"
        onClick={handleSettingsClick}
        aria-label={t('header.settingsAria')}
      >
        <img
          src={specialStarIcon}
          alt="Settings"
          width="24"
          height="24"
          style={{ marginRight: '10px' }}
        />
        <span>{t('header.settings')}</span>
        {updateAvailable && <span className="tab-badge" aria-hidden="true" />}
      </button>

    </header>
  );
};

export default Header;
