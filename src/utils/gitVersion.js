/**
 * Version utilities for the About tab: the installed package version plus the signed updater's
 * view of the latest release.
 */

import { getDesktopAppVersion } from '../platform/updateService';
import { startStartupUpdateCheck } from '../platform/startupUpdateCoordinator';

/**
 * The installed desktop package version, decorated with the build's generated commit metadata.
 *
 * @returns {Promise<Object>} Version information
 */
export const getGitVersion = async () => {
  try {
    const { default: generatedVersion } = await import('../config/version.js')
      .catch(() => ({ default: null }));
    const appVersion = await getDesktopAppVersion();
    const buildDate = generatedVersion?.date || new Date(0).toISOString();
    return {
      ...(generatedVersion || {}),
      hash: generatedVersion?.hash || 'release',
      shortHash: generatedVersion?.shortHash || 'release',
      date: buildDate,
      timestamp: generatedVersion?.timestamp || 0,
      branch: 'main',
      version: appVersion,
      source: 'tauri-package'
    };
  } catch (error) {
    console.warn('Failed to get git version information:', error);
    return {
      hash: 'unknown',
      shortHash: 'unknown',
      date: new Date().toISOString().split('T')[0],
      timestamp: Date.now(),
      version: '1.0.0',
      source: 'error'
    };
  }
};

/**
 * Get a human-readable version string for display
 * 
 * @param {Object} versionInfo - Version information object
 * @returns {string} Human-readable version string
 */
export const getDisplayVersion = (versionInfo) => {
  if (!versionInfo) return 'Unknown Version';
  
  try {
    const date = new Date(versionInfo.date);
    const formattedDate = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    
    const formattedTime = date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `v${versionInfo.version} (${formattedDate} ${formattedTime})`;
  } catch (error) {
    return `v${versionInfo.version}`;
  }
};

/**
 * The latest release as reported by the signed desktop updater.
 *
 * @returns {Promise<Object>} Latest version information
 */
export const getLatestVersion = async () => {
  try {
    const current = await getGitVersion();
    const status = await startStartupUpdateCheck();
    if (status === null) {
      throw new Error('The signed update check failed');
    }
    if (!status.configured) {
      // Local/automation builds intentionally skip update checks. They have no latest-release
      // result, but that is not a failed request and must not become an error in About.
      return { configured: false, source: 'tauri-updater-unavailable' };
    }
    if (status.update === null) {
      return {
        ...current,
        version: status.currentVersion,
        source: 'tauri-updater-current'
      };
    }
    return {
      hash: 'release',
      shortHash: 'release',
      date: status.update.publishedAt || current.date,
      timestamp: status.update.publishedAt
        ? Math.floor(Date.parse(status.update.publishedAt) / 1000)
        : current.timestamp,
      branch: 'main',
      message: status.update.notes || '',
      version: status.update.version,
      source: 'tauri-updater'
    };
  } catch (error) {
    console.warn('Failed to fetch latest version information:', error);
    throw new Error('Unable to fetch latest version information');
  }
};

/**
 * Compare two version strings
 * Supports both semantic versioning (1.2.3) and git-based versioning (2025.08.26-143304-abc1234)
 *
 * @param {string} version1 - First version string
 * @param {string} version2 - Second version string
 * @returns {number} -1 if version1 < version2, 0 if equal, 1 if version1 > version2
 */
export const compareVersions = (version1, version2) => {
  if (!version1 || !version2) return 0;

  try {
    // Handle git-based versions (YYYY.MM.DD-HHMMSS-hash)
    const gitVersionRegex = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{6})-([a-f0-9]+)$/;
    const match1 = version1.match(gitVersionRegex);
    const match2 = version2.match(gitVersionRegex);

    if (match1 && match2) {
      // Both are git-based versions, compare by date and time
      const date1 = new Date(`${match1[1]}-${match1[2]}-${match1[3]}T${match1[4].substring(0,2)}:${match1[4].substring(2,4)}:${match1[4].substring(4,6)}Z`);
      const date2 = new Date(`${match2[1]}-${match2[2]}-${match2[3]}T${match2[4].substring(0,2)}:${match2[4].substring(2,4)}:${match2[4].substring(4,6)}Z`);

      if (date1 < date2) return -1;
      if (date1 > date2) return 1;
      return 0;
    }

    // Handle semantic versions (1.2.3)
    const semverRegex = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/;
    const semver1 = version1.match(semverRegex);
    const semver2 = version2.match(semverRegex);

    if (semver1 && semver2) {
      const major1 = parseInt(semver1[1]);
      const minor1 = parseInt(semver1[2]);
      const patch1 = parseInt(semver1[3]);

      const major2 = parseInt(semver2[1]);
      const minor2 = parseInt(semver2[2]);
      const patch2 = parseInt(semver2[3]);

      if (major1 !== major2) return major1 > major2 ? 1 : -1;
      if (minor1 !== minor2) return minor1 > minor2 ? 1 : -1;
      if (patch1 !== patch2) return patch1 > patch2 ? 1 : -1;
      return 0;
    }

    // Fallback: simple string comparison
    if (version1 < version2) return -1;
    if (version1 > version2) return 1;
    return 0;

  } catch (error) {
    console.warn('Version comparison failed:', error);
    return 0;
  }
};

/**
 * Detect the user's operating system
 *
 * @returns {string} Operating system ('windows', 'mac', 'linux', 'unknown')
 */
const detectOS = () => {
  if (typeof window === 'undefined') return 'unknown';

  const userAgent = window.navigator.userAgent.toLowerCase();

  if (userAgent.includes('win')) return 'windows';
  if (userAgent.includes('mac')) return 'mac';
  if (userAgent.includes('linux')) return 'linux';

  return 'unknown';
};

/**
 * Get the appropriate installer filename for the current OS
 *
 * @returns {string} Installer filename
 */
export const getInstallerFilename = () => {
  const os = detectOS();

  switch (os) {
    case 'windows':
      return 'OSG_installer_Windows.bat';
    case 'mac':
    case 'linux':
      return 'OSG_installer.sh';
    default:
      return 'OSG_installer_Windows.bat'; // Default to Windows
  }
};

