import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CloseButton from '../../common/CloseButton';
import { animateToggle } from '../utils/keyVisibilityAnimation';
import GeminiKeysManager, { useGeminiKeys } from './GeminiKeysManager';
import YoutubeAuthSection from './YoutubeAuthSection';

const ApiKeysTab = ({
  geminiApiKey: _geminiApiKey,
  setGeminiApiKey,
  youtubeApiKey,
  setYoutubeApiKey,
  geniusApiKey,
  setGeniusApiKey,
  showGeminiKey: _showGeminiKey,
  setShowGeminiKey: _setShowGeminiKey,
  showYoutubeKey,
  setShowYoutubeKey,
  showGeniusKey,
  setShowGeniusKey,
  useOAuth,
  setUseOAuth,
  youtubeClientId,
  setYoutubeClientId,
  youtubeClientSecret,
  setYoutubeClientSecret,
  showClientId,
  setShowClientId,
  showClientSecret,
  setShowClientSecret,
  isAuthenticated,
  setIsAuthenticated,
  apiKeysSet,
  setApiKeysSet,
  enableYoutubeSearch
}) => {
  const { t } = useTranslation();

  // Gemini multi-key state + handlers
  const geminiKeys = useGeminiKeys({ setGeminiApiKey, setApiKeysSet });

  // Notification message visibility
  const [showGeminiPausedMessage, setShowGeminiPausedMessage] = useState(true);
  const [showUDBMMessage, setShowUDBMMessage] = useState(true);

  // Restore dismissed-notification state on mount
  useEffect(() => {
    if (localStorage.getItem('gemini25ProPausedMessageClosed') === 'true') {
      setShowGeminiPausedMessage(false);
    }
    if (localStorage.getItem('udbmMessageClosed') === 'true') {
      setShowUDBMMessage(false);
    }
  }, []);

  // Handle closing the Gemini paused message
  const handleCloseGeminiPausedMessage = () => {
    setShowGeminiPausedMessage(false);
    localStorage.setItem('gemini25ProPausedMessageClosed', 'true');
  };

  // Handle closing the UDBM message
  const handleCloseUDBMMessage = () => {
    setShowUDBMMessage(false);
    localStorage.setItem('udbmMessageClosed', 'true');
  };

  // Refs for editable fields
  const geniusKeyRef = useRef(null);

  // Focus effects for editable fields
  useEffect(() => {
    if (showGeniusKey && geniusKeyRef.current) {
      geniusKeyRef.current.focus();
    }
  }, [showGeniusKey]);

  return (
    <div className="settings-section api-key-section">
      {/* Notification Messages and API Link Row - Layout Fixed */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', width: '100%' }}>
          {/* notification-messages-container: Added flex: 1, display: flex, flexDirection: column, and gap for correct stacking and horizontal filling */}
          <div
            className="notification-messages-container"
            style={{ flex: '1', display: 'flex', flexDirection: 'column'}}
          >
              {/* Local-transcription availability notice */}
              {showGeminiPausedMessage && (
                <div className="gemini-paused-message">
                  <div className="message-content">
                    <span>{t('settings.gemini25ProPaused')}</span>
                  </div>
                  <CloseButton
                    onClick={handleCloseGeminiPausedMessage}
                    variant="default"
                    size="small"
                    ariaLabel={t('settings.closeMessage')}
                  />
                </div>
              )}

              {/* UDBM Announcement Message */}
              {showUDBMMessage && (
                <div className="gemini-paused-message udbm-message">
                  <div className="message-content">
                    <span className="material-symbols-rounded message-icon">celebration</span>
                    <span>
                      {t('settings.udbmIntroduction')}
                      {' '}
                      <a
                        href="https://github.com/nganlinh4/udbm/releases"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="message-link"
                      >
                        {t('settings.udbmDownloadHere')}
                      </a>
                    </span>
                  </div>
                  <CloseButton
                    onClick={handleCloseUDBMMessage}
                    variant="default"
                    size="small"
                    ariaLabel={t('settings.closeMessage')}
                  />
                </div>
              )}

              {/* Placeholder when no notifications are visible */}
              {!showGeminiPausedMessage && !showUDBMMessage && (
                <div className="notification-placeholder">
                  <div className="placeholder-content">
                    <span>{t('settings.noNewNotifications')}</span>
                  </div>
                </div>
              )}

          </div>
          {/* oauth-authenticate-btn: Added flexShrink: '0' for robust fixed-size positioning */}
          <button
            className="oauth-authenticate-btn"
            onClick={() => window.open('https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit', '_blank')}
            style={{ width: '85px', height: '85px', marginBottom: '16px', flexShrink: '0', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '2px' }}
            title="View Gemini API usage"
          >
            <span className="material-symbols-rounded">analytics</span>
            <span style={{ fontSize: '10px', marginTop: '4px', whiteSpace: 'normal', wordWrap: 'break-word', lineHeight: '1.4', overflow: 'hidden' }}>{t('settings.geminiApiUsage', 'Gemini API usage')}</span>
          </button>
        </div>
      {/* Grid layout for API keys */}
      <div className="api-keys-grid">
        {/* Gemini API Keys - Left column (spans two rows) */}
        <div className="api-key-input gemini-column">
          <label htmlFor="gemini-api-keys">
            {t('settings.geminiApiKeys', 'Gemini API Keys')}
            <span className={`api-key-status ${apiKeysSet.gemini ? 'set' : 'not-set'}`}>
              {apiKeysSet.gemini
                ? t('settings.keysSet', {count: geminiKeys.geminiApiKeys.length})
                : t('settings.keyNotSet', 'Not Set')}
            </span>
          </label>

          {/* Multiple Gemini API keys list */}
          <GeminiKeysManager {...geminiKeys} />

          <p className="api-key-help">
            {t('settings.geminiApiKeyHelp', 'Required for all functions. Get one at')}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google AI Studio
            </a>
          </p>
          <div className="api-key-instructions">
            <h4>{t('settings.getApiKey', 'Get Gemini API Key')}</h4>
            <ol>
              <li>{t('settings.geminiStep1', 'Login to Google AI Studio')}</li>
              <li>{t('settings.geminiStep2', 'Click \'Get API Key\'')}</li>
              <li>{t('settings.geminiStep3', 'Create a new key or select existing')}</li>
              <li>{t('settings.geminiStep4', 'Copy your API key')}</li>
              <li>{t('settings.geminiStep5', 'Paste it into the field above')}</li>
            </ol>
          </div>
        </div>

        {/* Genius API Key - Right column, first row */}
        <div className="api-key-input">
          <label htmlFor="genius-api-key">
            {t('settings.geniusApiKey', 'Genius API Key')}
            <span className={`api-key-status ${apiKeysSet.genius ? 'set' : 'not-set'}`}>
              {apiKeysSet.genius
                ? t('settings.keySet', 'Set')
                : t('settings.keyNotSet', 'Not Set')}
            </span>
          </label>

          {/* Custom non-password input implementation */}
          <div className="custom-api-key-input">
            <div className="custom-input-field">
              <input
                type="text"
                id="genius-key-input"
                className={`api-key-input-field ${!showGeniusKey ? 'masked-input' : ''}`}
                value={geniusApiKey}
                onChange={(e) => setGeniusApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                  }
                }}
                placeholder={t('settings.geniusApiKeyPlaceholder', 'Enter your Genius API key')}
                ref={geniusKeyRef}
                autoComplete="new-password"
                data-lpignore="true"
                data-form-type="other"
                spellCheck="false"
              />
            </div>
            <button
              type="button"
              className="toggle-visibility"
              onClick={() => animateToggle('genius-key-input', showGeniusKey, setShowGeniusKey)}
              aria-label={showGeniusKey ? t('settings.hide') : t('settings.show')}
            >
              {showGeniusKey ? t('settings.hide') : t('settings.show')}
            </button>
          </div>

          <p className="api-key-help">
            {t('settings.geniusApiKeyHelp', 'Required for lyrics fetching. Get one at')}
            <a
              href="https://genius.com/api-clients"
              target="_blank"
              rel="noopener noreferrer"
            >
              Genius API Clients
            </a>
          </p>
          <div className="api-key-instructions">
            <h4>{t('settings.getGeniusApiKey', 'Get Genius API Key')}</h4>
            <ol>
              <li>{t('settings.geniusStep1', 'Login to Genius')}</li>
              <li>{t('settings.geniusStep2', 'Go to API Clients page')}</li>
              <li>{t('settings.geniusStep3', 'Click \'New API Client\'')}</li>
              <li>{t('settings.geniusStep4', 'Fill in the form: APP NAME: \'OSG\' (or any name), leave other fields empty, click Save')}</li>
              <li>{t('settings.geniusStep5', 'Copy your Client Access Token from the created client')}</li>
              <li>{t('settings.geniusStep6', 'Paste it into the field above')}</li>
            </ol>
          </div>
        </div>

        {/* YouTube API Key - Right column, second row */}
        {enableYoutubeSearch && (
          <YoutubeAuthSection
            youtubeApiKey={youtubeApiKey}
            setYoutubeApiKey={setYoutubeApiKey}
            showYoutubeKey={showYoutubeKey}
            setShowYoutubeKey={setShowYoutubeKey}
            useOAuth={useOAuth}
            setUseOAuth={setUseOAuth}
            youtubeClientId={youtubeClientId}
            setYoutubeClientId={setYoutubeClientId}
            youtubeClientSecret={youtubeClientSecret}
            setYoutubeClientSecret={setYoutubeClientSecret}
            showClientId={showClientId}
            setShowClientId={setShowClientId}
            showClientSecret={showClientSecret}
            setShowClientSecret={setShowClientSecret}
            isAuthenticated={isAuthenticated}
            setIsAuthenticated={setIsAuthenticated}
            apiKeysSet={apiKeysSet}
            setApiKeysSet={setApiKeysSet}
          />
        )}
      </div>
    </div>
  );
};

export default ApiKeysTab;
