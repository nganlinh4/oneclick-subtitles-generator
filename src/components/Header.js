import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/Header.css';
import GeminiHeaderAnimation from './GeminiHeaderAnimation';
import specialStarIcon from '../assets/specialStar.svg';
import LoadingIndicator from './common/LoadingIndicator';

import { getGitVersion, getLatestVersion, compareVersions } from '../utils/gitVersion';
const Header = ({ onSettingsClick }) => {
  const { t } = useTranslation();
  const [showFloatingActions, setShowFloatingActions] = useState(true); // Start as visible
  const hideTimeoutRef = useRef(null);
  const initialShowTimeoutRef = useRef(null);
  const [isInitialShow, setIsInitialShow] = useState(true); // Track if we're in initial show period
  const [settingsOpenCount, setSettingsOpenCount] = useState(0); // Track how many times settings have been opened
  const [updateAvailable, setUpdateAvailable] = useState(false);

  const [isFullVersion, setIsFullVersion] = useState(false); // Track if running in full mode
  const [isVercelMode, setIsVercelMode] = useState(false); // Track if running via npm start (Vercel)
  const [currentBranch, setCurrentBranch] = useState('main'); // Track current branch
  const [startupModeDetected, setStartupModeDetected] = useState(false); // Track if startup mode detection is complete
  const [gitBranchDetected, setGitBranchDetected] = useState(false); // Track if git branch detection is complete

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
    const detectStartupMode = async () => {
      try {
        const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3031';
        const response = await fetch(`${API_BASE_URL}/api/startup-mode`, {
          mode: 'cors',
          credentials: 'include',
          headers: {
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          const startupData = await response.json();
          const isFull = !!startupData.isDevCuda;
          setIsFullVersion(isFull);
          const isStart = !!(startupData.isStart || (typeof startupData.command === 'string' && startupData.command.toLowerCase().includes('npm start')));
          setIsVercelMode(isStart);
          try {
            localStorage.setItem('backend_available', 'true');
            localStorage.setItem('is_full_version', isFull ? 'true' : 'false');
            localStorage.setItem('is_vercel_mode', isStart ? 'true' : 'false');
          } catch {}
        } else {
          // Server responded but not OK (e.g., 404) => treat as missing backend
          setIsFullVersion(false);
          setIsVercelMode(true);
          try {
            localStorage.setItem('backend_available', 'false');
            localStorage.setItem('is_full_version', 'false');
            localStorage.setItem('is_vercel_mode', 'true');
          } catch {}
        }
      } catch (error) {
        // If we can't contact the server at all, assume Vercel (npm start) mode
        setIsFullVersion(false);
        setIsVercelMode(true);
        try {
          localStorage.setItem('backend_available', 'false');
          localStorage.setItem('is_full_version', 'false');
          localStorage.setItem('is_vercel_mode', 'true');
        } catch {}
      } finally {
        // Mark startup mode detection as complete regardless of success/failure
        setStartupModeDetected(true);
      }
    };

    detectStartupMode();
  }, []);

  // Detect current Git branch
  useEffect(() => {
    const detectGitBranch = async () => {
      try {
        const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3031';
        const response = await fetch(`${API_BASE_URL}/api/git-branch`, {
          mode: 'cors',
          credentials: 'include',
          headers: {
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          const data = await response.json();
          // Detect if we're on old_version or main branch
          const branchName = data.branch || 'old_version';
          if (branchName === 'main') {
            setCurrentBranch('main'); // New version
          } else {
            setCurrentBranch('old_version'); // Old version
          }
        }
      } catch (error) {
        console.error('Failed to detect git branch:', error);
        // Default to old_version if we can't detect
        setCurrentBranch('old_version');
      } finally {
        // Mark git branch detection as complete regardless of success/failure
        setGitBranchDetected(true);
      }
    };

    detectGitBranch();
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
    const check = async () => {
      try {
        const current = await getGitVersion();
        const latest = await getLatestVersion();
        if (!mounted) return;
        if (current && latest) {
          setUpdateAvailable(compareVersions(latest.version, current.version) > 0);
        }
      } catch (e) {
        // ignore
      }
    };
    check();
    const id = setInterval(check, 30 * 60 * 1000);
    return () => { mounted = false; clearInterval(id); };
  }, []);
  // Handle branch switching
  const handleBranchSwitch = async () => {
    const targetBranch = currentBranch === 'old_version' ? 'main' : 'old_version';
    
    // Show loading state
    const button = document.querySelector('.branch-switch-button');
    if (button) {
      button.disabled = true;
      button.textContent = t('header.switching');
    }
    
    // Create loading overlay with LoadingIndicator
    const overlay = document.createElement('div');
    overlay.className = 'branch-switch-loading-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    `;
    
    // Create container for React component
    const loadingContainer = document.createElement('div');
    loadingContainer.id = 'branch-switch-loading';
    overlay.appendChild(loadingContainer);
    document.body.appendChild(overlay);
    
    // Render LoadingIndicator into the container
    const React = require('react');
    const ReactDOM = require('react-dom');
    ReactDOM.render(
      React.createElement('div', { 
        style: { 
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '20px'
        } 
      },
        React.createElement('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '15px'
          }
        },
          React.createElement(LoadingIndicator, { 
            size: 48, 
            theme: document.documentElement.getAttribute('data-theme') || 'light',
            showContainer: true 
          }),
          React.createElement('div', { 
            style: { 
              color: 'white', 
              fontSize: '1.2rem',
              fontWeight: '500'
            } 
          }, t('header.switchingVersions'))
        )
      ),
      loadingContainer
    );
    
    try {
      const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3031';
      const response = await fetch(`${API_BASE_URL}/api/switch-branch`, {
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ branch: targetBranch }),
        // Increase timeout since branch switching takes time
        signal: AbortSignal.timeout(30000) // 30 second timeout
      });

      const data = await response.json().catch(() => null);
      
      if (response.ok && data && data.success) {
        // Update loading message
        const messageDiv = loadingContainer.querySelector('div > div:last-child');
        if (messageDiv) {
          messageDiv.textContent = t('header.reloadingPage');
        }
        
        // Wait a bit for the cache clearing to complete
        setTimeout(() => {
          // Clear localStorage cache related to modules
          try {
            Object.keys(localStorage).forEach(key => {
              if (key.includes('webpack') || key.includes('module') || key.includes('babel')) {
                localStorage.removeItem(key);
              }
            });
          } catch (e) {
            console.log('Could not clear module cache from localStorage');
          }
          
          // Force hard reload to clear all caches
          window.location.reload(true);
        }, 1500);
      } else {
        // Only show error if we actually failed
        const errorMessage = data?.error || (response.ok ? null : t('header.switchError'));
        
        if (errorMessage) {
          ReactDOM.unmountComponentAtNode(loadingContainer);
          document.body.removeChild(overlay);
          alert(errorMessage);
          
          // Re-enable button
          if (button) {
            button.disabled = false;
            button.textContent = currentBranch === 'old_version' ? t('header.tryNewVersion') : t('header.oldVersion');
          }
        } else {
          // Success but no success flag? Reload anyway
          setTimeout(() => {
            window.location.reload(true);
          }, 1500);
        }
      }
    } catch (error) {
      // Check if it's a timeout error
      if (error.name === 'AbortError') {
        // Timeout might mean it succeeded but took too long to respond
        console.log('Request timed out, reloading anyway...');
        setTimeout(() => {
          window.location.reload(true);
        }, 1500);
      } else {
        ReactDOM.unmountComponentAtNode(loadingContainer);
        document.body.removeChild(overlay);
        console.error('Failed to switch branch:', error);
        alert(t('header.switchError'));
        // Re-enable button
        if (button) {
          button.disabled = false;
          button.textContent = currentBranch === 'old_version' ? t('header.tryNewVersion') : t('header.oldVersion');
        }
      }
    }
  };

  return (
    <header className="app-header">
      {/* Gemini constellation animation */}
      {localStorage.getItem('enable_gemini_effects') !== 'false' && (
        <GeminiHeaderAnimation />
      )}



      <div className="header-title-container">
        <h1 className="header-title">
          <span className="osg-main">OSG</span>
          {startupModeDetected && (
            <span className="osg-version">
              {isVercelMode
                ? ` (${t('header.versionVercel')})`
                : (isFullVersion ? ` (${t('header.versionFull')})` : ` (${t('header.versionLite')})`)
              }
            </span>
          )}
        </h1>
        {startupModeDetected && gitBranchDetected && (
          <button
            className={`branch-switch-button ${isVercelMode ? 'vercel-mode' : ''}`}
            onClick={handleBranchSwitch}
            disabled={isVercelMode}
            aria-label={isVercelMode ? t('header.vercelLimited') : (currentBranch === 'old_version' ? t('header.tryNewVersion') : t('header.oldVersion'))}
            title={isVercelMode ? t('header.vercelLimited') : (currentBranch === 'old_version' ? t('header.tryNewVersionTooltip') : t('header.oldVersionTooltip'))}
          >
            {isVercelMode ? t('header.vercelLimited') : (currentBranch === 'old_version' ? t('header.tryNewVersion') : t('header.oldVersion'))}
          </button>
        )}
      </div>


      <button
        className={`settings-button floating-settings ${showFloatingActions ? 'floating-visible' : 'floating-hidden'}`}
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