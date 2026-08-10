import { inspectDownloadUrl } from '../platform/downloadService';

const QUALITY_LABELS = Object.freeze({
  2160: '4K',
  1440: '2K',
  1080: 'Full HD',
  720: 'HD',
  480: 'SD',
  360: 'Low',
  240: 'Very Low',
  144: 'Minimum',
});

const qualityDescription = (height) => (
  QUALITY_LABELS[height] ? `${height}p (${QUALITY_LABELS[height]})` : `${height}p`
);

const bestFormatAtHeight = (formats, height) => formats
  .filter((format) => format.height === height)
  .sort((left, right) => {
    if (left.includesAudio !== right.includesAudio) return left.includesAudio ? -1 : 1;
    return (right.bitrateKbps ?? 0) - (left.bitrateKbps ?? 0);
  })[0];

export const mapNativeVideoQualities = (inventory) => inventory.formats.qualities
  .map(({ height }) => bestFormatAtHeight(inventory.formats.video, height))
  .filter(Boolean)
  .map((format) => Object.freeze({
    height: format.height,
    quality: `${format.height}p`,
    description: qualityDescription(format.height),
    formatId: format.formatId,
    extension: format.container,
    resolution: format.width === null ? null : `${format.width}x${format.height}`,
  }))
  .sort((left, right) => right.height - left.height);

const inspect = (videoUrl) => inspectDownloadUrl({
  url: videoUrl,
  cookieSource: localStorage.getItem('use_cookies_for_download') === 'true'
    ? 'chrome'
    : 'none',
});

export const scanVideoQualities = async (videoUrl) => {
  const { inventory } = await inspect(videoUrl);
  return mapNativeVideoQualities(inventory);
};

export const getVideoInfo = async (videoUrl) => {
  const { inventory } = await inspect(videoUrl);
  return Object.freeze({
    title: inventory.title,
    duration: inventory.durationSeconds,
  });
};
