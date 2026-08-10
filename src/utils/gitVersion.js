/**
 * Git version utilities for displaying app version based on commit information
 */

import { fetchBrowserResource } from '../platform/browserFetch';

/**
 * Get git commit information from the current repository
 * This function attempts to get git info in multiple ways:
 * 1. From environment variables (set during build)
 * 2. From a generated version file (created during build)
 * 3. From package.json as fallback
 * 
 * @returns {Promise<Object>} Git version information
 */
export const getGitVersion = async () => {
  try {
    if (typeof window !== 'undefined' && window.isTauri) {
      const [{ default: generatedVersion }, { getDesktopAppVersion }] = await Promise.all([
        import('../config/version.js').catch(() => ({ default: null })),
        import('../platform/updateService'),
      ]);
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
    }

    // Try to get from environment variables first (set during build)
    if (process.env.REACT_APP_GIT_COMMIT_HASH && process.env.REACT_APP_GIT_COMMIT_DATE) {
      return {
        hash: process.env.REACT_APP_GIT_COMMIT_HASH,
        shortHash: process.env.REACT_APP_GIT_COMMIT_HASH.substring(0, 7),
        date: process.env.REACT_APP_GIT_COMMIT_DATE,
        timestamp: process.env.REACT_APP_GIT_COMMIT_TIMESTAMP,
        version: formatGitVersion(
          process.env.REACT_APP_GIT_COMMIT_DATE,
          process.env.REACT_APP_GIT_COMMIT_HASH.substring(0, 7)
        ),
        source: 'environment'
      };
    }

    // Try to load from generated version file
    try {
      const versionModule = await import('../config/version.js');
      if (versionModule.default) {
        const versionInfo = versionModule.default;
        return {
          ...versionInfo,
          version: formatGitVersion(versionInfo.date, versionInfo.shortHash),
          source: 'generated'
        };
      }
    } catch (error) {
      // Version file doesn't exist, continue to fallback
    }

    // Fallback to package.json version
    return {
      hash: 'unknown',
      shortHash: 'unknown',
      date: new Date().toISOString().split('T')[0],
      timestamp: Date.now(),
      version: '1.0.0', // From package.json
      source: 'fallback'
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
 * Format git commit date and hash into a version string
 * Format: YYYY.MM.DD-HHMMSS-{shortHash}
 * 
 * @param {string} dateString - ISO date string or date in format YYYY-MM-DD HH:MM:SS
 * @param {string} shortHash - Short git commit hash
 * @returns {string} Formatted version string
 */
export const formatGitVersion = (dateString, shortHash) => {
  try {
    let date;
    
    // Handle different date formats
    if (dateString.includes('T')) {
      // ISO format: 2024-01-15T14:30:45Z
      date = new Date(dateString);
    } else if (dateString.includes(' ')) {
      // Format: 2024-01-15 14:30:45
      date = new Date(dateString.replace(' ', 'T') + 'Z');
    } else {
      // Just date: 2024-01-15
      date = new Date(dateString + 'T00:00:00Z');
    }

    if (isNaN(date.getTime())) {
      throw new Error('Invalid date');
    }

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}.${month}.${day}-${hours}${minutes}${seconds}-${shortHash}`;
  } catch (error) {
    console.warn('Failed to format git version:', error);
    return `unknown-${shortHash}`;
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
 * Get the latest version information from GitHub repository (latest commit on main branch)
 *
 * @returns {Promise<Object>} Latest version information
 */
export const getLatestVersion = async () => {
  try {
    if (typeof window !== 'undefined' && window.isTauri) {
      const [{ checkDesktopUpdate }, current] = await Promise.all([
        import('../platform/updateService'),
        getGitVersion(),
      ]);
      const status = await checkDesktopUpdate();
      if (!status.configured) {
        throw new Error('Signed updater is not configured');
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
    }

    // Get the latest commit from the main branch
    const commitsResponse = await fetchBrowserResource('https://api.github.com/repos/nganlinh4/oneclick-subtitles-generator/commits/main', {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OSG-App'
      }
    });

    if (!commitsResponse.ok) {
      throw new Error(`GitHub API error: ${commitsResponse.status}`);
    }

    const commitData = await commitsResponse.json();
    const commitDate = commitData.commit.committer.date;
    const shortHash = commitData.sha.substring(0, 7);
    const fullHash = commitData.sha;

    // Format version the same way as current version
    const version = formatGitVersion(commitDate, shortHash);

    return {
      hash: fullHash,
      shortHash: shortHash,
      date: commitDate,
      timestamp: Math.floor(new Date(commitDate).getTime() / 1000),
      branch: 'main',
      message: commitData.commit.message,
      author: {
        name: commitData.commit.author.name,
        email: commitData.commit.author.email
      },
      version: version,
      url: commitData.html_url,
      source: 'github-commits'
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
export const detectOS = () => {
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

/**
 * Get build information for debugging
 *
 * @param {Object} versionInfo - Version information object
 * @returns {string} Build information string
 */
export const getBuildInfo = (versionInfo) => {
  if (!versionInfo) return 'No build info available';

  const parts = [
    `Source: ${versionInfo.source}`,
    `Hash: ${versionInfo.shortHash}`,
    `Built: ${versionInfo.date}`
  ];

  return parts.join(' | ');
};

const gitVersionUtils = {
  getGitVersion,
  formatGitVersion,
  getDisplayVersion,
  getBuildInfo,
  getLatestVersion,
  compareVersions,
  detectOS,
  getInstallerFilename
};

export default gitVersionUtils;
