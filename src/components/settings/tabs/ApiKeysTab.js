import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAuthUrl, hasValidTokens, clearOAuthData } from '../../../services/youtubeApiService';
import { getAllKeys, addKey, removeKey, getActiveKeyIndex, setActiveKeyIndex } from '../../../services/gemini/keyManager';
import CloseButton from '../../common/CloseButton';

// Helper function for animating input visibility toggle with subtle fade
const animateToggle = (elementId, currentState, setState) => {
  const element = document.getElementById(elementId);
  if (!element) {
    setState(!currentState);
    return;
  }

  // Apply fade-out animation
  element.style.animation = 'fade-out 0.15s ease-in-out forwards';

  // After animation completes, toggle state
  setTimeout(() => {
    setState(!currentState);

    // Apply fade-in animation after state change
    setTimeout(() => {
      element.style.animation = 'fade-in 0.15s ease-in-out forwards';
    }, 50);
  }, 150);
};

// Note: This function is defined but not used - the functionality is implemented inline
// in the onKeyDown handlers of the contentEditable elements
// Prevent form submission on Enter key
// const preventSubmit = (e) => {
//   if (e.key === 'Enter') {
//     e.preventDefault();
//     return false;
//   }
// };

const ApiKeysTab = ({
  geminiApiKey,
  setGeminiApiKey,
  youtubeApiKey,
  setYoutubeApiKey,
  geniusApiKey,
  setGeniusApiKey,
  showGeminiKey,
  setShowGeminiKey,
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

  // State for multiple Gemini API keys
  const [geminiApiKeys, setGeminiApiKeys] = useState([]);
  const [newGeminiKey, setNewGeminiKey] = useState('');
  const [showNewGeminiKey, setShowNewGeminiKey] = useState(false);
  const [activeKeyIndex, setActiveKeyIndexState] = useState(0);
  const [visibleKeyIndices, setVisibleKeyIndices] = useState({});
  const [showGeminiPausedMessage, setShowGeminiPausedMessage] = useState(true);
  const [showUDBMMessage, setShowUDBMMessage] = useState(true);
  const [showUpcomingFeaturesMessage, setShowUpcomingFeaturesMessage] = useState(true);

  // Load all Gemini API keys on mount
  useEffect(() => {
    const keys = getAllKeys();
    setGeminiApiKeys(keys);
    setActiveKeyIndexState(getActiveKeyIndex());

    // Check if the messages have been closed before
    const messageClosedBefore = localStorage.getItem('gemini25ProPausedMessageClosed') === 'true';
    if (messageClosedBefore) {
      setShowGeminiPausedMessage(false);
    }
    
    const udbmMessageClosed = localStorage.getItem('udbmMessageClosed') === 'true';
    if (udbmMessageClosed) {
      setShowUDBMMessage(false);
    }
    
    const upcomingFeaturesMessageClosed = localStorage.getItem('upcomingFeaturesMessageClosed') === 'true';
    if (upcomingFeaturesMessageClosed) {
      setShowUpcomingFeaturesMessage(false);
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
  
  // Handle closing the upcoming features message
  const handleCloseUpcomingFeaturesMessage = () => {
    setShowUpcomingFeaturesMessage(false);
    localStorage.setItem('upcomingFeaturesMessageClosed', 'true');
  };

  // Update the active key when it changes
  const handleSetActiveKey = (index) => {
    setActiveKeyIndex(index);
    setActiveKeyIndexState(index);
    // Update the single key for backward compatibility
    setGeminiApiKey(geminiApiKeys[index]);
  };

  // Add a new Gemini API key
  const handleAddGeminiKey = () => {
    if (newGeminiKey && newGeminiKey.trim()) {
      if (addKey(newGeminiKey)) {
        const updatedKeys = getAllKeys();
        setGeminiApiKeys(updatedKeys);
        setNewGeminiKey('');
        setShowNewGeminiKey(false);

        // Update API keys set status
        setApiKeysSet(prevState => ({
          ...prevState,
          gemini: true
        }));
      }
    }
  };

  // Remove a Gemini API key
  const handleRemoveGeminiKey = (key) => {
    if (removeKey(key)) {
      const updatedKeys = getAllKeys();
      setGeminiApiKeys(updatedKeys);

      // Update API keys set status
      setApiKeysSet(prevState => ({
        ...prevState,
        gemini: updatedKeys.length > 0
      }));
    }
  };

  // Toggle key visibility with subtle fade animation
  const toggleKeyVisibility = (index) => {
    // Get the key element
    const keyElement = document.querySelector(`#gemini-key-${index} .gemini-key-content`);

    if (keyElement) {
      // Apply fade-out animation
      keyElement.style.animation = 'fade-out 0.15s ease-in-out forwards';

      // After animation completes, toggle visibility
      setTimeout(() => {
        setVisibleKeyIndices(prev => ({
          ...prev,
          [index]: !prev[index]
        }));

        // Apply fade-in animation after state change
        setTimeout(() => {
          keyElement.style.animation = 'fade-in 0.15s ease-in-out forwards';
        }, 50);
      }, 150);
    } else {
      // Fallback if element not found
      setVisibleKeyIndices(prev => ({
        ...prev,
        [index]: !prev[index]
      }));
    }
  };

  // Refs for editable fields
  const geminiKeyRef = useRef(null);
  const newGeminiKeyRef = useRef(null);
  const geniusKeyRef = useRef(null);
  const youtubeKeyRef = useRef(null);
  const clientIdRef = useRef(null);
  const clientSecretRef = useRef(null);

  // Focus effects for editable fields
  useEffect(() => {
    if (showGeminiKey && geminiKeyRef.current) {
      geminiKeyRef.current.focus();
    }
  }, [showGeminiKey]);

  useEffect(() => {
    if (showNewGeminiKey && newGeminiKeyRef.current) {
      newGeminiKeyRef.current.focus();
    }
  }, [showNewGeminiKey]);

  useEffect(() => {
    if (showGeniusKey && geniusKeyRef.current) {
      geniusKeyRef.current.focus();
    }
  }, [showGeniusKey]);

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

  // Handle YouTube OAuth authentication
  const handleOAuthAuthentication = () => {
    if (youtubeClientId && youtubeClientSecret) {
      // Store client credentials
      storeClientCredentials(youtubeClientId, youtubeClientSecret);

      // Get authorization URL
      const authUrl = getAuthUrl();
      if (authUrl) {
        // Set up message listener for OAuth success
        const messageListener = (event) => {
          if (event.origin === window.location.origin &&
              event.data && event.data.type === 'OAUTH_SUCCESS') {
            // Update authentication status
            setIsAuthenticated(hasValidTokens());
            // Remove the listener
            window.removeEventListener('message', messageListener);
          }
        };

        // Add the listener
        window.addEventListener('message', messageListener);

        // Open the authorization URL in a new window
        const authWindow = window.open(authUrl, 'youtube-oauth', 'width=800,height=600');

        // Check if popup was blocked
        if (!authWindow || authWindow.closed || typeof authWindow.closed === 'undefined') {
          alert('Popup blocked! Please allow popups for this site and try again.');
          window.removeEventListener('message', messageListener);
        }
      } else {
        alert('Failed to generate authorization URL. Please check your client credentials.');
      }
    } else {
      alert('Please enter both Client ID and Client Secret.');
    }
  };

  // Handle clearing OAuth data
  const handleClearOAuth = () => {
    if (window.confirm('Are you sure you want to clear your YouTube OAuth credentials? You will need to authenticate again to use YouTube search.')) {
      clearOAuthData();
      setIsAuthenticated(false);
    }
  };

  // Function to store client credentials (imported from youtubeApiService)
  const storeClientCredentials = (clientId, clientSecret) => {
    localStorage.setItem('youtube_client_id', clientId);
    localStorage.setItem('youtube_client_secret', clientSecret);
  };

  return (
    <div className="settings-section api-key-section">
      {/* Notification Messages and API Link Row - Layout Fixed */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', width: '100%' }}>
          {/* notification-messages-container: Added flex: 1, display: flex, flexDirection: column, and gap for correct stacking and horizontal filling */}
          <div 
            className="notification-messages-container"
            style={{ flex: '1', display: 'flex', flexDirection: 'column'}}
          >
              {/* Gemini 2.5 Pro API Pause Message */}
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
                ? t('settings.keysSet', {count: geminiApiKeys.length})
                : t('settings.keyNotSet', 'Not Set')}
            </span>
          </label>

          {/* Multiple Gemini API keys list */}
          <div className="gemini-keys-container">
            {geminiApiKeys.length > 0 ? (
              <div className="gemini-keys-list">
                {geminiApiKeys.map((key, index) => (
                  <div
                    key={`gemini-key-${index}`}
                    id={`gemini-key-${index}`}
                    className={`gemini-key-item ${index === activeKeyIndex ? 'active' : ''} ${geminiApiKeys.length === 1 ? 'single-key' : ''}`}
                  >
                    <div className="gemini-key-content">
                      {visibleKeyIndices[index] ? (
                        <>
                          <div className="gemini-key-display">
                            <div className="gemini-key-text">
                              <div className="gemini-key-visible">
                                {key}
                              </div>
                            </div>
                          </div>
                          <div className="gemini-key-actions expanded">
                            <button
                              type="button"
                              className="gemini-key-button"
                              onClick={() => toggleKeyVisibility(index)}
                              title={t('settings.hideKey', 'Hide key')}
                            >
                              {t('settings.hide', 'Hide')}
                            </button>
                            <div className="gemini-key-actions-right">
                              <button
                                type="button"
                                className={`gemini-key-button ${index === activeKeyIndex ? 'active' : ''}`}
                                onClick={() => handleSetActiveKey(index)}
                                disabled={index === activeKeyIndex}
                                title={t('settings.setAsActive', 'Set as active key')}
                              >
                                {index === activeKeyIndex ?
                                  t('settings.activeKey', 'Active') :
                                  t('settings.setActive', 'Set Active')}
                              </button>
                              <button
                                type="button"
                                className="remove-key"
                                onClick={() => handleRemoveGeminiKey(key)}
                                title={t('settings.removeKey', 'Remove key')}
                              >
                                <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                              </button>
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="gemini-key-row">
                          <div
                            className="gemini-key-text gemini-key-masked"
                            title={key}
                          >
                            {key ? `${key.substring(0, 4)}••••••${key.substring(key.length - 4)}` : ''}
                          </div>
                          <div className="gemini-key-actions">
                            <button
                              type="button"
                              className="gemini-key-button"
                              onClick={() => toggleKeyVisibility(index)}
                              title={t('settings.showKey', 'Show key')}
                            >
                              {t('settings.show', 'Show')}
                            </button>
                            <button
                              type="button"
                              className={`gemini-key-button ${index === activeKeyIndex ? 'active' : ''}`}
                              onClick={() => handleSetActiveKey(index)}
                              disabled={index === activeKeyIndex}
                              title={t('settings.setAsActive', 'Set as active key')}
                            >
                              {index === activeKeyIndex ?
                                t('settings.activeKey', 'Active') :
                                t('settings.setActive', 'Set Active')}
                            </button>
                            <button
                              type="button"
                              className="remove-key"
                              onClick={() => handleRemoveGeminiKey(key)}
                              title={t('settings.removeKey', 'Remove key')}
                            >
                              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>close</span>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                  </div>
                ))}
              </div>
            ) : (
              <div className="no-keys-message">
                {t('settings.noGeminiKeys', 'No Gemini API keys added yet. Add your first key below.')}
              </div>
            )}

            {/* Add new key input */}
            <div className="add-new-key-container">
              <div className="add-key-input-row">
                <div className="custom-api-key-input">
                  <div className="custom-input-field">
                    <input
                      type="text"
                      id="new-gemini-key-input"
                      className={`api-key-input-field ${!showNewGeminiKey ? 'masked-input' : ''}`}
                      value={newGeminiKey}
                      onChange={(e) => setNewGeminiKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddGeminiKey();
                        }
                      }}
                      placeholder={t('settings.addGeminiKeyPlaceholder', 'Enter a new Gemini API key')}
                      ref={newGeminiKeyRef}
                      autoComplete="new-password"
                      data-lpignore="true"
                      data-form-type="other"
                      spellCheck="false"
                    />
                  </div>
                  <button
                    type="button"
                    className="toggle-visibility"
                    onClick={() => animateToggle('new-gemini-key-input', showNewGeminiKey, setShowNewGeminiKey)}
                    aria-label={showNewGeminiKey ? t('settings.hide') : t('settings.show')}
                  >
                    {showNewGeminiKey ? t('settings.hide') : t('settings.show')}
                  </button>
                </div>
                <button
                  type="button"
                  className="add-key-button"
                  onClick={handleAddGeminiKey}
                  disabled={!newGeminiKey}
                >
                  {t('settings.addKey', 'Add Key')}
                </button>
              </div>
            </div>
          </div>

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
            {/* <div className="multiple-keys-info">
              <h4>{t('settings.multipleKeysInfo', 'About Multiple API Keys')}</h4>
              <p>{t('settings.multipleKeysDescription', 'Adding multiple Gemini API keys enables automatic failover. If one key encounters an error, the system will automatically try another key.')}</p>
              <p>{t('settings.activeKeyDescription', 'The active key is used first. If it fails, other keys will be tried in sequence.')}</p>
            </div> */}
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
                onClick={handleOAuthAuthentication}
                disabled={!youtubeClientId || !youtubeClientSecret}
              >
                {t('settings.authenticateWithYouTube', 'Authenticate with YouTube')}
              </button>
              {isAuthenticated && (
                <button
                  className="oauth-clear-btn"
                  onClick={handleClearOAuth}
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
        )}
      </div>
    </div>
  );
};

export default ApiKeysTab;