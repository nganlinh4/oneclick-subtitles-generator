import { getGitVersion } from '../utils/gitVersion';

const normalizeChannel = (branch) => branch === 'old_version' ? 'old_version' : 'main';

export class VersionChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VersionChannelError';
    this.code = code;
  }
}

export const detectVersionChannel = async ({
  getVersion = getGitVersion,
} = {}) => {
  const version = await getVersion();
  return normalizeChannel(version?.branch);
};

export const switchVersionChannel = async (targetBranch) => {
  if (!['main', 'old_version'].includes(targetBranch)) {
    throw new VersionChannelError('invalidVersionChannel', 'The version channel is invalid');
  }
  // Installed desktop builds are immutable artifacts. Updates flow only through signed Tauri
  // updater packages; source-control mutation is never exposed to the WebView.
  throw new VersionChannelError(
    'versionSwitchUnavailable',
    'Runtime version switching is unavailable in the desktop build'
  );
};
