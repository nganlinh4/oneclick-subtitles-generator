import { useState, useEffect } from 'react';
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

  const [isVercelMode, setIsVercelMode] = useState(false); // Track if running via npm start (Vercel)
  const [startupModeDetected, setStartupModeDetected] = useState(false); // Track if startup mode detection is complete

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
        className="settings-button"
        data-app-action="open-settings"
        onClick={onSettingsClick}
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
