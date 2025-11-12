import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AppLayout from './AppLayout';
import { useAppState } from './AppState';
import { useAppHandlers } from './AppHandlers';
import { useModalHandlers } from './ModalHandlers';
import { useAppEffects } from './AppEffects';
import OnboardingBanner from '../OnboardingBanner';
import OnboardingFooterReveal from '../OnboardingFooterReveal';
import ToastPanel from '../common/ToastPanel';

// Import CSS files
import '../../styles/App.css';
import '../../styles/GeminiButtonAnimations.css';
import '../../styles/ProcessingTextAnimation.css';
import '../../styles/SrtUploadButton.css';
import '../../styles/VideoAnalysisModal.css';
import '../../styles/TranscriptionRulesEditor.css';
import '../../styles/OnboardingBanner.css';
import '../../styles/AutoGenerate.css'; // Auto-generate button and flow styles
// Removed spinner-fix.css - now using LoadingIndicator component
import '../../styles/lyrics/save-message.css'; // Audio alignment notification styles
import '../../styles/OnboardingFooterReveal.css';


/**
 * Main App component
 */
function App() {
  const { t } = useTranslation();


  // Initialize app state
  const appState = { ...useAppState(), t };

  // Initialize app handlers
  const appHandlers = useAppHandlers(appState);

  // Initialize modal handlers
  const modalHandlers = useModalHandlers(appState);

  // Set up app effects
  useAppEffects({
    ...appState,
    handleDownloadAndPrepareYouTubeVideo: appHandlers.handleDownloadAndPrepareYouTubeVideo,
    t
  });

  // State change effects removed to reduce console logs

  return (
    <>
      {/* Onboarding banner for first-time visitors - rendered at the top level */}
      <OnboardingBanner />

      {/* This is rendered on top of the app, behind the onboarding overlay */}
      <OnboardingFooterReveal />

      {/* Toast notifications panel - moved early to ensure it's available before other components */}
      <ToastPanel />

      <AppLayout
        appState={appState}
        appHandlers={appHandlers}
        modalHandlers={modalHandlers}
        t={t}
      />
    </>
  );
}

export default App;
