import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [settingsOpenCount, setSettingsOpenCount] = useState(() => (
    Number.parseInt(localStorage.getItem('settings_open_count') || '0', 10) || 0
  ));
  const [showFloatingSettings, setShowFloatingSettings] = useState(true);
  const hideTimerRef = useRef(null);

  const [isVercelMode, setIsVercelMode] = useState(false); // Track if running via npm start (Vercel)
  const [startupModeDetected, setStartupModeDetected] = useState(false); // Track if startup mode detection is complete

  const revealSettings = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setShowFloatingSettings(true);
  }, []);

  useEffect(() => {
    if (settingsOpenCount < 5) {
      setShowFloatingSettings(true);
      return undefined;
    }
    const scheduleHide = (delay = 350) => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => setShowFloatingSettings(false), delay);
    };
    const handlePointerMove = ({ clientX, clientY }) => {
      if (clientY <= 120 && clientX >= window.innerWidth - 160) revealSettings();
      else scheduleHide();
    };
    const handlePointerLeave = () => scheduleHide(500);
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerleave', handlePointerLeave);
    scheduleHide(5_000);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerleave', handlePointerLeave);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [revealSettings, settingsOpenCount]);

  const handleSettingsClick = () => {
    const nextCount = settingsOpenCount + 1;
    setSettingsOpenCount(nextCount);
    localStorage.setItem('settings_open_count', String(nextCount));
    onSettingsClick();
  };

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
        className={`settings-button floating-settings ${showFloatingSettings ? 'floating-visible' : 'floating-hidden'}`}
        data-app-action="open-settings"
        onClick={handleSettingsClick}
        onPointerEnter={revealSettings}
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
