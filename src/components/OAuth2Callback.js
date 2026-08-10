import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getYouTubeOAuthStatusNative } from '../platform/providerService';
import '../styles/oauth-callback.css';

const OAuth2Callback = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState(t('settings.youtubeOAuth.processing', 'Processing authentication...'));
  const [isFailed, setIsFailed] = useState(false);

  useEffect(() => {
    const processAuthCode = async () => {
      try {
        // The native host owns the loopback callback, PKCE validation, code
        // exchange, and vault persistence. This legacy render surface may only
        // observe the resulting non-secret status.
        const oauthStatus = await getYouTubeOAuthStatusNative();
        if (!oauthStatus.authenticated) {
          setStatus(t('settings.youtubeOAuth.noCode', 'Error: No authorization code received'));
          return;
        }

        setStatus(t('settings.youtubeOAuth.success', 'Authentication successful! Redirecting...'));

        // Redirect back to the main page
        setTimeout(() => {
          window.location.href = '/';
        }, 2000);
      } catch (error) {
        console.error('OAuth callback error:', error);
        setStatus(t('settings.youtubeOAuth.failed', 'Authentication failed: {{message}}', { message: error.message }));
        setIsFailed(true);
      }
    };

    processAuthCode();
  }, [t]);

  return (
    <div className="oauth-callback-container">
      <div className="oauth-callback-content">
        <h2>{t('settings.youtubeOAuth.authTitle', 'YouTube Authentication')}</h2>
        <p>{status}</p>
        {isFailed && (
          <button
            onClick={() => window.location.href = '/'}
            className="primary-button"
          >
            {t('settings.youtubeOAuth.returnToApp', 'Return to Application')}
          </button>
        )}
      </div>
    </div>
  );
};

export default OAuth2Callback;
