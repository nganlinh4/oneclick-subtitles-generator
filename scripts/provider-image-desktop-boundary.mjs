import { createHash } from 'node:crypto';

export const PINNED_PROVIDER_IMAGE_SOURCES = Object.freeze({
  'src/components/inputs/YoutubeUrlInput.js':
    '9ab71631a1ab9420ac32958460a43f94043da9e7677496268b5120c55f4cf5de',
  'src/components/inputs/VideoPreviewRenderer.js':
    '112a91132a32907d723b2962b6febc92f56d3d4701ef887d1d6fc1a2ebac503e',
});

const normalizedId = (value) => value.split(/[?#]/, 1)[0].replaceAll('\\', '/');
const normalizedSource = (value) => value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
const sha256 = (value) => createHash('sha256').update(normalizedSource(value), 'utf8').digest('hex');

const targetPath = (id) => {
  const path = normalizedId(id);
  return Object.keys(PINNED_PROVIDER_IMAGE_SOURCES).find(
    (target) => path === target || path.endsWith(`/${target}`)
  ) ?? null;
};

const SELECTED_VIDEO_REMOTE = 'src={`https://img.youtube.com/vi/${selectedVideo.id}/0.jpg`}';
const SELECTED_VIDEO_NATIVE = 'src={selectedVideo.thumbnail}';
const HISTORY_REMOTE = 'e.target.src = `https://img.youtube.com/vi/${item.id}/0.jpg`;';
const HISTORY_NATIVE = [
  "if (e.target.dataset.nativeThumbnailRetry === 'true') {",
  "  e.target.removeAttribute('src');",
  '  return;',
  '}',
  "e.target.dataset.nativeThumbnailRetry = 'true';",
  'const image = e.target;',
  'void getVideoThumbnail(item.id).then(',
  '  (url) => { image.src = url; },',
  "  () => { image.removeAttribute('src'); },",
  ');',
].join('\n');

const count = (source, marker) => source.split(marker).length - 1;

const replaceExactly = (source, marker, replacement, expected, label) => {
  const discovered = count(source, marker);
  if (discovered !== expected) {
    throw new Error(
      `Frozen provider-image compatibility marker drifted for ${label}: expected ${expected}, found ${discovered}`
    );
  }
  return source.replaceAll(marker, replacement);
};

export const rewriteProviderImageRenderSource = (source, id) => {
  const target = targetPath(id);
  if (target === null) return null;

  const actualHash = sha256(source);
  const expectedHash = PINNED_PROVIDER_IMAGE_SOURCES[target];
  if (actualHash !== expectedHash) {
    throw new Error(
      `Frozen provider-image source integrity mismatch for ${target}: expected ${expectedHash}, found ${actualHash}`
    );
  }

  if (target === 'src/components/inputs/YoutubeUrlInput.js') {
    const selected = replaceExactly(
      source,
      SELECTED_VIDEO_REMOTE,
      SELECTED_VIDEO_NATIVE,
      1,
      'YoutubeUrlInput selected thumbnail'
    );
    return replaceExactly(
      selected,
      HISTORY_REMOTE,
      HISTORY_NATIVE,
      1,
      'YoutubeUrlInput history fallback'
    );
  }
  if (target === 'src/components/inputs/VideoPreviewRenderer.js') {
    return replaceExactly(
      source,
      SELECTED_VIDEO_REMOTE,
      SELECTED_VIDEO_NATIVE,
      1,
      'VideoPreviewRenderer selected thumbnail'
    );
  }
  throw new Error(`Unsupported frozen provider-image source ${target}`);
};

export const createProviderImageDesktopBoundaryPlugin = () => ({
  name: 'osg-provider-image-desktop-boundary',
  enforce: 'pre',
  transform(source, id) {
    const code = rewriteProviderImageRenderSource(source, id);
    return code === null ? null : { code, map: null };
  },
});
