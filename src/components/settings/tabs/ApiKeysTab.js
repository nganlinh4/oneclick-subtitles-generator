import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { removeSingletonCredential } from '../../../platform/credentialStateController';
import { showConfirmationToast, showErrorToast } from '../../../utils/toastUtils';
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

  const requestCredentialRemoval = (purpose, label) => showConfirmationToast({
    key: `clear-${purpose}`,
    message: t(
      'settings.credentials.confirmClear',
      'Remove the saved {{label}} credential from this device?',
      { label },
    ),
    confirmText: t('common.confirm', 'Confirm'),
    onConfirm: async () => {
      try {
        await removeSingletonCredential(purpose);
        return true;
      } catch {
        showErrorToast(t(
          'settings.credentials.clearFailed',
          'The saved credential could not be removed. Please try again.',
        ));
        return false;
      }
    },
  });

  // Gemini multi-key state + handlers
  const geminiKeys = useGeminiKeys({ setGeminiApiKey, setApiKeysSet });

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
      {/* Grid layout for API keys */}
      <div className="api-keys-grid">
        {/* Gemini API Keys - Left column (spans two rows) */}
        <div className="api-key-input gemini-column">
          <div className="gemini-key-header">
            <label htmlFor="new-gemini-key-input">
              {t('settings.geminiApiKeys', 'Gemini API Keys')}
              <span className={`api-key-status ${apiKeysSet.gemini ? 'set' : 'not-set'}`}>
                {apiKeysSet.gemini
                  ? t('settings.keysSet', {count: geminiKeys.geminiApiKeys.length})
                  : t('settings.keyNotSet', 'Not Set')}
              </span>
            </label>
            <a
              className="gemini-usage-link"
              href="https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="material-symbols-rounded" aria-hidden="true">analytics</span>
              <span>{t('settings.geminiApiUsage', 'Gemini API usage')}</span>
            </a>
          </div>

          {/* Multiple Gemini API keys list */}
          <GeminiKeysManager {...geminiKeys} />

          <p className="gemini-key-rotation-note">
            {t('settings.geminiKeyRotation', 'Add multiple keys and OSG will distribute parallel Gemini work across them, rotating when a request can be retried.')}
          </p>

          <p className="api-key-help">
            {t('settings.geminiApiKeyHelp', 'Required for Gemini features. Get one at')}
            {' '}
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

          {apiKeysSet.genius && (
            <button
              type="button"
              className="oauth-clear-btn"
              data-credential-action="clear-genius"
              onClick={() => requestCredentialRemoval(
                'geniusAccessToken',
                t('settings.geniusApiKey', 'Genius API Key'),
              )}
            >
              {t('settings.clearSavedCredential', 'Clear saved credential')}
            </button>
          )}

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
            onClearApiKey={() => requestCredentialRemoval(
              'youtubeApiKey',
              t('settings.youtubeApiKey', 'YouTube API Key'),
            )}
          />
        )}
      </div>
    </div>
  );
};

export default ApiKeysTab;
