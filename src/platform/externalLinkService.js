import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

const TARGET_BY_URL = new Map([
  ['https://aistudio.google.com/app/apikey', 'aiStudioApiKeys'],
  ['https://aistudio.google.com/usage?timeRange=last-1-day&tab=rate-limit', 'aiStudioUsage'],
  ['mailto:nganlinh4@gmail.com', 'creatorEmail'],
  ['https://github.com/nganlinh4', 'creatorGithub'],
  ['https://scholar.google.com/citations?user=kWFVuFwAAAAJ&hl=en', 'creatorScholar'],
  ['https://www.youtube.com/@tteokl', 'creatorYoutube'],
  ['https://ai.google.dev/gemini-api/docs/video-understanding', 'geminiVideoDocumentation'],
  ['https://genius.com/api-clients', 'geniusApiClients'],
  ['https://console.cloud.google.com/apis/credentials', 'googleCloudCredentials'],
  ['https://github.com/nganlinh4/udbm/releases', 'udbmReleases'],
  ['https://console.developers.google.com/apis/api/youtube.googleapis.com/overview', 'youtubeApiOverview'],
  ['https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md', 'ytDlpSupportedSites'],
].map(([url, target]) => [new URL(url).href, target]));

const canonicalize = (value) => {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    return new URL(String(value), window.location.href).href;
  } catch {
    return null;
  }
};

export class ExternalLinkError extends Error {
  constructor(code) {
    super('The external link could not be opened');
    this.name = 'ExternalLinkError';
    this.code = code;
  }
}

export const openDesktopExternalLink = async (
  value,
  { nativeRuntime = isDesktopRuntime, invokeCommand = invokeDesktop } = {}
) => {
  if (!nativeRuntime()) throw new ExternalLinkError('desktopRuntimeUnavailable');
  const target = TARGET_BY_URL.get(canonicalize(value));
  if (!target) throw new ExternalLinkError('externalLinkNotAllowed');
  try {
    await invokeCommand('open_external_link', { link: target });
  } catch {
    throw new ExternalLinkError('externalLinkUnavailable');
  }
};

const isExternalNavigation = (value) => {
  const canonical = canonicalize(value);
  if (!canonical) return false;
  const destination = new URL(canonical);
  return destination.protocol === 'mailto:' || destination.origin !== window.location.origin;
};

export const installDesktopExternalLinkGuard = ({
  nativeRuntime = isDesktopRuntime,
  openLink = openDesktopExternalLink,
} = {}) => {
  if (!nativeRuntime()) return () => {};

  const originalOpen = window.open;
  const openSafely = (value) => {
    void openLink(value).catch(() => {});
    return null;
  };
  const handleClick = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download') || !isExternalNavigation(anchor.href)) return;
    event.preventDefault();
    openSafely(anchor.href);
  };

  window.open = openSafely;
  document.addEventListener('click', handleClick, true);

  return () => {
    document.removeEventListener('click', handleClick, true);
    if (window.open === openSafely) window.open = originalOpen;
  };
};
