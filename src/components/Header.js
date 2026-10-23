import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/Header.css';
import GeminiHeaderAnimation from './GeminiHeaderAnimation';
import specialStarIcon from '../assets/specialStar.svg';

import {
  refreshDesktopUpdateCheck,
  startStartupUpdateCheck,
  subscribeDesktopUpdateStatus,
} from '../platform/startupUpdateCoordinator';
import { usePreference } from '../platform/preferences/store';
const Header = ({ onSettingsClick, settingsOpen = false }) => {
  const { t } = useTranslation();
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [settingsOpenCount, setSettingsOpenCount] = usePreference('settings_open_count');
  const [geminiEffectsEnabled] = usePreference('enable_gemini_effects');
  const [showFloatingSettings, setShowFloatingSettings] = useState(true);
  const hideTimerRef = useRef(null);

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
    setSettingsOpenCount(settingsOpenCount + 1);
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
  const settingsButtonVisible = showFloatingSettings && !settingsOpen;
  return (
    <header className="app-header">
      {/* Gemini constellation animation */}
      {geminiEffectsEnabled && (
        <GeminiHeaderAnimation />
      )}



      <div className="header-title-container">
        <h1 className="header-title">
          <span className="osg-main">OSG</span>
        </h1>
      </div>


      <button
        className={`settings-button floating-settings ${settingsButtonVisible ? 'floating-visible' : 'floating-hidden'}`}
        data-app-action="open-settings"
        onClick={handleSettingsClick}
        onPointerEnter={revealSettings}
        aria-label={t('header.settingsAria')}
        aria-hidden={!settingsButtonVisible}
        tabIndex={settingsButtonVisible ? 0 : -1}
        disabled={settingsOpen}
      >
        <img
          src={specialStarIcon}
          alt=""
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
