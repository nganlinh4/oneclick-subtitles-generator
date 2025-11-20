// No need to import React with modern JSX transform
import { useTranslation } from 'react-i18next';
import { useState, useEffect } from 'react';
import { getGitVersion, getDisplayVersion, getLatestVersion, compareVersions, getInstallerFilename } from '../../../utils/gitVersion';
import LoadingIndicator from '../../common/LoadingIndicator';

const AboutTab = ({ backgroundType }) => {
  const { t } = useTranslation();
  const [versionInfo, setVersionInfo] = useState(null);
  const [latestVersionInfo, setLatestVersionInfo] = useState(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Load version information on component mount
  useEffect(() => {
    const loadVersionInfo = async () => {
      try {
        const gitVersion = await getGitVersion();
        setVersionInfo(gitVersion);
      } catch (error) {
        console.warn('Failed to load version information:', error);
        // Set fallback version info
        setVersionInfo({
          version: '1.0.0',
          source: 'fallback',
          date: new Date().toISOString().split('T')[0],
          shortHash: 'unknown'
        });
      }
    };

    const checkForUpdates = async () => {
      setIsCheckingUpdate(true);
      try {
        const latestVersion = await getLatestVersion();
        setLatestVersionInfo(latestVersion);

        // Compare versions if we have both current and latest
        if (versionInfo && latestVersion) {
          const isNewer = compareVersions(latestVersion.version, versionInfo.version);
          setUpdateAvailable(isNewer > 0);
        }
      } catch (error) {
        console.warn('Failed to check for updates:', error);
      } finally {
        setIsCheckingUpdate(false);
      }
    };

    loadVersionInfo();
    // Only check for updates once, not dependent on versionInfo
    if (!latestVersionInfo && !isCheckingUpdate) {
      checkForUpdates();
    }
  }, []); // Run once on mount

  // Separate effect to compare versions when both are available
  useEffect(() => {
    if (versionInfo && latestVersionInfo) {
      const isNewer = compareVersions(latestVersionInfo.version, versionInfo.version);
      setUpdateAvailable(isNewer > 0);
    }
  }, [versionInfo, latestVersionInfo]);

  // Determine the background class based on the backgroundType
  const getBackgroundClass = () => {
    if (!backgroundType || backgroundType === 'default') {
      return '';
    }

    if (backgroundType === 'random') {
      return '';  // This should never happen as random is resolved in the parent component
    }

    return `alternative-bg${backgroundType === 'alternative' ? '' : `-${backgroundType}`}`;
  };

  // Function to replay the onboarding animation
  const handleReplayOnboarding = () => {
    // Remove the flag from localStorage so the onboarding will show again
    localStorage.removeItem('has_visited_site');

    // Reload the page to show the onboarding
    window.location.reload();
  };

  return (
    <div className={`settings-section about-section ${getBackgroundClass()}`}>
      <h3>{t('settings.about', 'About')}</h3>
      <div className="about-content">
        <h2 className="about-app-title">One-click Subtitles Generator</h2>
        <div className="creator-info">
          <p><strong>{t('settings.creator', 'Creator')}:</strong> nganlinh4</p>
          <p>
            <strong>GitHub:</strong>
            <a href="https://github.com/nganlinh4" target="_blank" rel="noopener noreferrer">
              https://github.com/nganlinh4
            </a>
          </p>
          <p>
            <strong>YouTube:</strong>
            <a href="https://www.youtube.com/@tteokl" target="_blank" rel="noopener noreferrer">
              https://www.youtube.com/@tteokl
            </a>
          </p>
          <p>
            <strong>Google Scholar:</strong>
            <a href="https://scholar.google.com/citations?user=kWFVuFwAAAAJ&hl=en" target="_blank" rel="noopener noreferrer">
              https://scholar.google.com/citations?user=kWFVuFwAAAAJ&hl=en
            </a>
          </p>
          <p>
            <strong>Email:</strong>
            <a href="mailto:nganlinh4@gmail.com">
              nganlinh4@gmail.com
            </a>
          </p>
        </div>
        <div className="app-description">
          <p>{t('settings.appDescription', 'One-click Subtitles Generator is a tool that helps you generate, edit, and translate subtitles for your videos with just one click.')}</p>
        </div>

        {/* Version Information */}
        <div className="version-info">
          <h4>{t('settings.version', 'Version')}</h4>
          {versionInfo ? (
            <div className="version-details">
              <p className="version-display">
                <strong>{t('settings.currentVersion', 'Current Version')}:</strong> {getDisplayVersion(versionInfo)}
              </p>

              {/* Latest Version Check */}
              <div className="latest-version-check">
                {isCheckingUpdate ? (
                  <div className="checking-update">
                    <LoadingIndicator size={16} theme="dark" showContainer={false} />
                    {t('settings.checkingUpdates', 'Checking for updates...')}
                  </div>
                ) : latestVersionInfo ? (
                  <div className="latest-version-info">
                    <p className="latest-version-display">
                      <strong>{t('settings.latestVersion', 'Latest Version')}:</strong> {getDisplayVersion(latestVersionInfo)}
                    </p>

                    {updateAvailable ? (
                      <div className="update-notification">
                        <div className="update-message">
                          <span className="material-symbols-rounded update-icon" style={{ fontSize: '20px' }}>update</span>
                          <span>{t('settings.updateAvailable', 'A new version is available!')}</span>
                        </div>
                        <p className="update-description">
                          {t('settings.updateDescription', 'Update to get the latest features and bug fixes.')}
                        </p>
                        <div className="update-instructions">
                          <p><strong>{t('settings.howToUpdate', 'How to update')}:</strong></p>
                          <div className="installer-options">
                            <div className="installer-option primary-installer">
                              {t('settings.runInstaller', 'Run')} <code>{getInstallerFilename()}</code>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="up-to-date">
                        <span className="material-symbols-rounded check-icon">check</span>
                        {t('settings.upToDate', 'You are using the latest version!')}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="update-check-failed">
                    {t('settings.updateCheckFailed', 'Unable to check for updates')}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p>{t('settings.loadingVersion', 'Loading version information...')}</p>
          )}
        </div>

        {/* Replay Onboarding Button */}
        <div className="replay-onboarding-container">
          <button
            className="replay-onboarding-button"
            onClick={handleReplayOnboarding}
            title={t('settings.replayOnboardingTooltip', 'Show the welcome animation again')}
            aria-label={t('settings.replayOnboardingTooltip', 'Show the welcome animation again')}
          >
            <span className="material-symbols-rounded">emoji_people</span>
            {t('settings.replayOnboarding', 'Replay Welcome Animation')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AboutTab;

