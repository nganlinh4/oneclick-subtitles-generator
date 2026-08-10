const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

const parseHttpUrl = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed : null;
  } catch {
    return null;
  }
};

export const extractYoutubeVideoId = (value) => {
  const url = parseHttpUrl(value);
  if (!url) return null;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const candidate = hostname === 'youtu.be'
    ? url.pathname.split('/').filter(Boolean)[0]
    : ['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(hostname)
      ? (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1])
      : null;
  return YOUTUBE_ID_PATTERN.test(candidate ?? '') ? candidate : null;
};

export const extractDouyinVideoId = (value) => {
  const url = parseHttpUrl(value);
  if (!url) return null;

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  if (hostname === 'douyin.com') {
    return url.pathname.match(/^\/video\/(\d+)(?:\/|$)/)?.[1] ?? null;
  }
  if (hostname === 'v.douyin.com') {
    return url.pathname.match(/^\/([A-Za-z0-9]+)(?:\/|$)/)?.[1] ?? null;
  }
  return null;
};

export const isValidYoutubeUrl = (value) => extractYoutubeVideoId(value) !== null;
export const isValidDouyinUrl = (value) => extractDouyinVideoId(value) !== null;

export const isValidUrl = (value) => {
  const url = parseHttpUrl(value);
  return url !== null && url.hostname.includes('.');
};

export const generateAllSitesVideoId = (value) => {
  const url = parseHttpUrl(value);
  if (!url) return `site_${Date.now()}`;
  const source = `${url.hostname.replace(/^www\./, '')}${url.pathname}`;
  const normalized = source.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `site_${normalized}_${Date.now()}`;
};
