import { fontCapabilitySnapshot } from './fontCapability';
import { resolveFontIdentity } from './fontIdentity';

const FONT_WEIGHTS = Object.freeze([400, 700, 300, 500, 600, 800, 900, 100, 200]);

export const fontPlatform = (userAgent = typeof navigator === 'object' ? navigator.userAgent : '') => {
  const agent = String(userAgent).toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

export const systemFontProbe = (fonts = typeof document === 'object' ? document.fonts : null) => {
  if (typeof fonts?.check !== 'function') return null;
  return ({ family, weight }) => {
    try {
      return fonts.check(`${weight} 16px "${family}"`);
    } catch {
      return false;
    }
  };
};

/**
 * Return only font choices the running renderer can actually bake, each with a usable weight.
 *
 * The legacy picker advertised 121 choices while the packaged Windows renderer had byte identity
 * for only the managed face and reviewed OS faces. Selecting any other card persisted a state that
 * preview and export were required to refuse. Availability is now enforced before the click rather
 * than reported after the video has already stopped showing subtitles.
 */
export const selectableFontOptions = (options, {
  requestedWeight = 400,
  platform = fontPlatform(),
  capability = fontCapabilitySnapshot(),
  isSystemFaceInstalled = systemFontProbe(),
} = {}) => {
  if (!Array.isArray(options) || platform === null) return [];
  const weights = [requestedWeight, ...FONT_WEIGHTS.filter((weight) => weight !== requestedWeight)];
  return options.flatMap((option) => {
    for (const weight of weights) {
      const result = resolveFontIdentity({
        fontFamily: option?.value,
        fontWeight: weight,
        fontStyle: 'normal',
        platform,
        managedPackInstalled: capability.managedPackInstalled,
        isSystemFaceInstalled,
      });
      if (result.status === 'exact') return [{ ...option, resolvedWeight: weight }];
    }
    return [];
  });
};
