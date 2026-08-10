import i18n from '../../../i18n/i18n';
import {
  authorizeYouTubeNative,
  clearYouTubeOAuthNative,
} from '../../../platform/providerService';

// Kept as a compatibility-shaped export for existing callers. Native credentials are
// write-only drafts and are never staged in browser storage.
export const storeClientCredentials = () => false;

// Handle YouTube OAuth authentication
export const handleOAuthAuthentication = (youtubeClientId, youtubeClientSecret, setIsAuthenticated) => {
  if (!youtubeClientId || !youtubeClientSecret) {
    alert(i18n.t('settings.youtubeOAuth.missingCredentials', 'Please enter both Client ID and Client Secret.'));
    return false;
  }
  return authorizeYouTubeNative({
    clientId: youtubeClientId,
    clientSecret: youtubeClientSecret,
  }).then((status) => {
    setIsAuthenticated(status.authenticated);
    return status.authenticated;
  }).catch(() => {
    setIsAuthenticated(false);
    alert(i18n.t('settings.youtubeOAuth.authFailed', 'YouTube authentication failed. Please try again.'));
    return false;
  });
};

// Handle clearing OAuth data
export const handleClearOAuth = (setIsAuthenticated) => {
  if (window.confirm(i18n.t('settings.youtubeOAuth.confirmClear', 'Are you sure you want to clear your YouTube OAuth credentials? You will need to authenticate again to use YouTube search.'))) {
    return clearYouTubeOAuthNative().then(() => {
      setIsAuthenticated(false);
      return true;
    }).catch(() => false);
  }
  return false;
};
