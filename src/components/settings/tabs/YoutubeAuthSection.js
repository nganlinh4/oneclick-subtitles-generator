import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { animateToggle } from '../utils/keyVisibilityAnimation';
import { handleOAuthAuthentication, handleClearOAuth } from '../utils/youtubeOAuthHandlers';

// Full YouTube authentication UI: API key method + OAuth 2.0 method.
const YoutubeAuthSection = ({
  youtubeApiKey,
  setYoutubeApiKey,
  showYoutubeKey,
  setShowYoutubeKey,
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
}) => {
  const { t } = useTranslation();

  const youtubeKeyRef = useRef(null);
  const clientIdRef = useRef(null);
  const clientSecretRef = useRef(null);

  useEffect(() => {
    if (showYoutubeKey && youtubeKeyRef.current) {
      youtubeKeyRef.current.focus();
    }
  }, [showYoutubeKey]);

  useEffect(() => {
    if (showClientId && clientIdRef.current) {
      clientIdRef.current.focus();
    }
  }, [showClientId]);

  useEffect(() => {
    if (showClientSecret && clientSecretRef.current) {
      clientSecretRef.current.focus();
    }
  }, [showClientSecret]);

  return (
    <div className="api-key-input full-width">
      <div className="auth-method-toggle">
        <label className="auth-method-label">{t('settings.youtubeAuthMethod', 'YouTube Authentication Method')}</label>
        <div className="auth-toggle-buttons">
          <button
            className={`auth-toggle-btn ${!useOAuth ? 'active' : ''}`}
            onClick={() => {
              setUseOAuth(false);
              localStorage.setItem('use_youtube_oauth', 'false');

              // Update apiKeysSet to reflect the API key method
              setApiKeysSet(prevState => ({
                ...prevState,
                youtube: !!youtubeApiKey
              }));
            }}
          >
            {t('settings.apiKeyMethod', 'API Key')}
          </button>
          <button
            className={`auth-toggle-btn ${useOAuth ? 'active' : ''}`}
            onClick={() => {
              setUseOAuth(true);
              localStorage.setItem('use_youtube_oauth', 'true');

              // Update apiKeysSet to reflect the OAuth method
              setApiKeysSet(prevState => ({
                ...prevState,
                youtube: isAuthenticated
              }));
            }}
          >
            {t('settings.oauthMethod', 'OAuth 2.0')}
          </button>
        </div>
      </div>

    {!useOAuth ? (
      <>
        <label htmlFor="youtube-api-key">
          {t('settings.youtubeApiKey', 'YouTube API Key')}
          <span className={`api-key-status ${apiKeysSet.youtube ? 'set' : 'not-set'}`}>
            {apiKeysSet.youtube
              ? t('settings.keySet', 'Set')
              : t('settings.keyNotSet', 'Not Set')}
          </span>
        </label>
        {/* Custom non-password input implementation for YouTube */}
        <div className="custom-api-key-input">
          <div className="custom-input-field">
            <input
              type="text"
              id="youtube-key-input"
              className={`api-key-input-field ${!showYoutubeKey ? 'masked-input' : ''}`}
              value={youtubeApiKey}
              onChange={(e) => setYoutubeApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
              placeholder={t('settings.youtubeApiKeyPlaceholder', 'Enter your YouTube API key')}
              ref={youtubeKeyRef}
              autoComplete="new-password"
              data-lpignore="true"
              data-form-type="other"
              spellCheck="false"
            />
          </div>
          <button
            type="button"
            className="toggle-visibility"
            onClick={() => animateToggle('youtube-key-input', showYoutubeKey, setShowYoutubeKey)}
            aria-label={showYoutubeKey ? t('settings.hide') : t('settings.show')}
          >
            {showYoutubeKey ? t('settings.hide') : t('settings.show')}
          </button>
        </div>
        <p className="api-key-help">
          {t('settings.youtubeApiKeyHelp', 'Required for YouTube search. Get one at')}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Cloud Console
          </a>
        </p>
        <div className="api-key-instructions">
          <h4>{t('settings.getYoutubeApiKey', 'Get YouTube API Key')}</h4>
          <ol>
            <li>{t('settings.youtubeStep1', 'Go to Google Cloud Console')}</li>
            <li>{t('settings.youtubeStep2', 'Create or select a project')}</li>
            <li className="important-step">{t('settings.youtubeStep3', 'Enable \'YouTube Data API v3\'')}
              <a
                href="https://console.developers.google.com/apis/api/youtube.googleapis.com/overview"
                target="_blank"
                rel="noopener noreferrer"
                className="enable-api-link"
              >
                {t('settings.enableApiDirectly', 'Enable API directly')}
              </a>
            </li>
            <li>{t('settings.youtubeStep4', 'Go to credentials')}</li>
            <li>{t('settings.youtubeStep5', 'Generate API key')}</li>
          </ol>
          <div className="api-warning">
            <strong>{t('settings.important', 'Important:')}</strong> {t('settings.apiEnableWarning', 'You must enable the YouTube Data API v3 in your Google Cloud project before using your API key. If you get an error about "API not enabled", click the link above to enable it.')}
          </div>
        </div>
      </>
    ) : (
      <>
        <div className="oauth-status-container">
          <label>{t('settings.youtubeOAuth', 'YouTube OAuth 2.0')}</label>
          <span className={`api-key-status ${isAuthenticated ? 'set' : 'not-set'}`}>
            {isAuthenticated
              ? t('settings.authenticated', 'Authenticated')
              : t('settings.notAuthenticated', 'Not Authenticated')}
          </span>
        </div>

        <div className="oauth-client-inputs">
          <div className="oauth-input-group">
            <label htmlFor="youtube-client-id">{t('settings.clientId', 'Client ID')}</label>
            {/* Custom non-password input implementation for Client ID */}
            <div className="custom-api-key-input">
              <div className="custom-input-field">
                <input
                  type="text"
                  id="client-id-input"
                  className={`api-key-input-field ${!showClientId ? 'masked-input' : ''}`}
                  value={youtubeClientId}
                  onChange={(e) => setYoutubeClientId(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                    }
                  }}
                  placeholder={t('settings.clientIdPlaceholder', 'Enter your OAuth Client ID')}
                  ref={clientIdRef}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-form-type="other"
                  spellCheck="false"
                />
              </div>
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => animateToggle('client-id-input', showClientId, setShowClientId)}
                aria-label={showClientId ? t('settings.hide') : t('settings.show')}
              >
                {showClientId ? t('settings.hide') : t('settings.show')}
              </button>
            </div>
          </div>

          <div className="oauth-input-group">
            <label htmlFor="youtube-client-secret">{t('settings.clientSecret', 'Client Secret')}</label>
            {/* Custom non-password input implementation for Client Secret */}
            <div className="custom-api-key-input">
              <div className="custom-input-field">
                <input
                  type="text"
                  id="client-secret-input"
                  className={`api-key-input-field ${!showClientSecret ? 'masked-input' : ''}`}
                  value={youtubeClientSecret}
                  onChange={(e) => setYoutubeClientSecret(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                    }
                  }}
                  placeholder={t('settings.clientSecretPlaceholder', 'Enter your OAuth Client Secret')}
                  ref={clientSecretRef}
                  autoComplete="new-password"
                  data-lpignore="true"
                  data-form-type="other"
                  spellCheck="false"
                />
              </div>
              <button
                type="button"
                className="toggle-visibility"
                onClick={() => animateToggle('client-secret-input', showClientSecret, setShowClientSecret)}
                aria-label={showClientSecret ? t('settings.hide') : t('settings.show')}
              >
                {showClientSecret ? t('settings.hide') : t('settings.show')}
              </button>
            </div>
          </div>
        </div>

        <div className="oauth-actions">
          <button
            className="oauth-authenticate-btn"
            onClick={() => handleOAuthAuthentication(youtubeClientId, youtubeClientSecret, setIsAuthenticated)}
            disabled={!youtubeClientId || !youtubeClientSecret}
          >
            {t('settings.authenticateWithYouTube', 'Authenticate with YouTube')}
          </button>
          {isAuthenticated && (
            <button
              className="oauth-clear-btn"
              onClick={() => handleClearOAuth(setIsAuthenticated)}
            >
              {t('settings.clearAuth', 'Clear Authentication')}
            </button>
          )}
        </div>

        <p className="api-key-help">
          {t('settings.oauthDescription', 'OAuth 2.0 provides more reliable access to YouTube API. Get credentials at')}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
          >
            Google Cloud Console
          </a>
        </p>
        <div className="api-key-instructions">
          <h4>{t('settings.getOAuthCredentials', 'Get OAuth Credentials')}</h4>
          <ol>
            <li>{t('settings.createProject', 'Create a project in Google Cloud Console')}</li>
            <li>{t('settings.enableYouTubeAPI', 'Enable the YouTube Data API v3')}</li>
            <li>{t('settings.createOAuthClientId', 'Create OAuth 2.0 Client ID (Web application)')}</li>
            <li>{t('settings.addAuthorizedOrigins', 'Add Authorized JavaScript origins:')}<br/>
              <code>{window.location.origin}</code>
            </li>
            <li>{t('settings.addAuthorizedRedirect', 'Add Authorized redirect URI:')}<br/>
              <code>{window.location.origin + '/oauth2callback.html'}</code>
            </li>
            <li>{t('settings.copyClientCredentials', 'Copy your Client ID and Client Secret')}</li>
            <li>{t('settings.pasteAndAuthenticate', 'Paste them into the fields above and click Authenticate')}</li>
          </ol>

          <h4>{t('settings.troubleshootingOAuth', 'Troubleshooting OAuth Issues')}</h4>

          <h5>{t('settings.errorRedirectMismatch', 'Error: redirect_uri_mismatch')}</h5>
          <p>{t('settings.redirectMismatchDescription', 'This error occurs when the redirect URI in your application doesn\'t match what\'s registered in Google Cloud Console:')}</p>
          <ol>
            <li>{t('settings.goToCredentials', 'Go to Google Cloud Console > APIs & Services > Credentials')}</li>
            <li>{t('settings.findOAuthClient', 'Find your OAuth 2.0 Client ID and click to edit')}</li>
            <li>{t('settings.inAuthorizedOrigins', 'In "Authorized JavaScript origins", add exactly:')}<br/>
              <code>{window.location.origin}</code>
            </li>
            <li>{t('settings.inAuthorizedRedirect', 'In "Authorized redirect URIs", add exactly:')}<br/>
              <code>{window.location.origin + '/oauth2callback.html'}</code>
            </li>
            <li>{t('settings.clickSave', 'Click Save')}</li>
          </ol>

          <h5>{t('settings.errorAccessDenied', 'Error: access_denied')}</h5>
          <p>{t('settings.accessDeniedDescription', 'This error can occur for several reasons:')}</p>
          <ul>
            <li>{t('settings.deniedPermission', 'You denied permission during the OAuth flow')}</li>
            <li>{t('settings.apiNotEnabled', 'The YouTube Data API is not enabled for your project')}</li>
            <li>{t('settings.apiRestrictions', 'There are API restrictions on your OAuth client')}</li>
          </ul>
          <p>{t('settings.toFix', 'To fix:')}</p>
          <ol>
            <li>{t('settings.goToLibrary', 'Go to Google Cloud Console > APIs & Services > Library')}</li>
            <li>{t('settings.searchYouTubeAPI', 'Search for "YouTube Data API v3" and make sure it\'s enabled')}</li>
            <li>{t('settings.checkRestrictions', 'Check your OAuth client for any API restrictions')}</li>
          </ol>

          <h5>{t('settings.errorAppNotVerified', 'Error: App not verified')}</h5>
          <p>{t('settings.appNotVerifiedDescription', 'New OAuth applications start in "Testing" mode and can only be used by test users:')}</p>
          <ol>
            <li>{t('settings.goToConsentScreen', 'Go to Google Cloud Console > APIs & Services > OAuth consent screen')}</li>
            <li>{t('settings.scrollToTestUsers', 'Scroll down to "Test users" section')}</li>
            <li>{t('settings.clickAddUsers', 'Click "Add users"')}</li>
            <li>{t('settings.addYourEmail', 'Add your Google email address as a test user')}</li>
            <li>{t('settings.saveChanges', 'Save changes and try again')}</li>
          </ol>
          <p className="note">{t('settings.verificationNote', 'Note: You don\'t need to wait for verification if you add yourself as a test user. Verification is only required if you want to make your app available to all users.')}</p>
        </div>
      </>
    )}
    </div>
  );
};

export default YoutubeAuthSection;
