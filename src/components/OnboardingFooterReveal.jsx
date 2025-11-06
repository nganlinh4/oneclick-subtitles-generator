import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsFooterControls from './settings/SettingsFooterControls';
import OnboardingStarryBackground from './OnboardingStarryBackground';
import initGeminiButtonEffects from '../utils/geminiEffects';
import '../styles/OnboardingFooterReveal.css';

/**
 * OnboardingFooterReveal
 * Renders the settings footer controls in a large, glassy card above the app.
 * It is mounted at all times (beneath the onboarding overlay), so when the
 * SVG dismissal animation plays, this card is revealed.
 */
const OnboardingFooterReveal = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    // Show only if user hasn't dismissed this helper yet
    const dismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
    if (!dismissed) {
      setVisible(true);
    }
  }, []);

  // Initialize Gemini effects when component becomes visible
  useEffect(() => {
    if (visible) {
      // Small delay to ensure DOM is ready
      const timer = setTimeout(() => {
        if (localStorage.getItem('enable_gemini_effects') !== 'false') {
          initGeminiButtonEffects();
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  const handleLetsGo = () => {
    // Start dismissal animation
    setDismissing(true);

    // After animation completes, hide and remember
    setTimeout(() => {
      localStorage.setItem('onboarding_controls_dismissed', 'true');
      setVisible(false);
      setDismissing(false);
    }, 500); // Match animation duration
  };

  if (!visible) return null;

  return (
    <div className={`onboarding-reveal-overlay ${dismissing ? 'dismissing' : ''}`} aria-hidden={false}>
      <OnboardingStarryBackground />
      <div className={`onboarding-reveal-card ${dismissing ? 'dismissing' : ''}`}>
        <div className="onboarding-reveal-header">{/* empty header keeps layout clean */}</div>
        <div className="onboarding-reveal-body">
          <div className="onboarding-controls-row">
            <SettingsFooterControls size="large" layout="group" isDropup={true} />
            <button className="lets-go-btn" onClick={handleLetsGo}>
              <div className="gemini-icon-container"></div>
              <span className="lets-go-text">{t('onboarding.letsGo')}</span>
              <span className="material-symbols-rounded lets-go-arrow" style={{ fontSize: '20px' }}>arrow_forward</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingFooterReveal;

