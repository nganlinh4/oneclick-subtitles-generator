import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (relativePath) => readFileSync(resolve(ROOT, relativePath), 'utf8');

it('keeps production YouTube, Genius, and OAuth sources structurally native-only', () => {
  expect(existsSync(resolve(ROOT, 'public/oauth2callback.html'))).toBe(false);

  const productionSources = [
    'src/platform/desktopYoutubeService.js',
    'src/platform/providerService.js',
    'src/hooks/useGeniusLyrics.js',
    'src/components/OAuth2Callback.js',
    'src/components/inputs/UnifiedUrlInput.js',
    'src/components/inputs/YoutubeUrlInput.js',
    'src/components/inputs/YoutubeSearchInput.js',
  ].map(read).join('\n');

  expect(productionSources).not.toMatch(/youtubeApiService|googleAuthService|youtubeService/);
  expect(productionSources).not.toMatch(
    /accounts\.google\.com|oauth2\.googleapis\.com|www\.googleapis\.com\/youtube/i
  );
  expect(productionSources).not.toMatch(/api\.genius\.com/i);
  expect(productionSources).not.toMatch(/\bfetch\s*\(/);
  expect(productionSources).not.toMatch(/window\.open\s*\(/);
  expect(productionSources).not.toMatch(/youtube_(?:oauth_token|client_id|client_secret|api_key)/);
  expect(productionSources).not.toMatch(/genius_token/);

  for (const removed of [
    'src/services/youtubeApiService.js',
    'src/services/googleAuthService.js',
    'src/services/youtubeService.js',
  ]) {
    expect(existsSync(resolve(ROOT, removed))).toBe(false);
  }

  expect(read('vite.config.mjs')).not.toMatch(
    /youtubeApiService|desktopYoutubeService|provider-image-desktop-boundary/,
  );
  expect(existsSync(resolve(ROOT, 'scripts/provider-image-desktop-boundary.mjs'))).toBe(false);

  const imagePaths = [
    'src/platform/providerService.js',
    'src/platform/desktopYoutubeService.js',
    'src/components/inputs/UnifiedUrlInput.js',
    'src/components/inputs/YoutubeUrlInput.js',
    'src/components/inputs/YoutubeSearchInput.js',
    'src/components/inputs/VideoPreviewRenderer.js',
    'src/components/inputs/urlHistory.js',
    'src/utils/historyUtils.js',
  ];
  const imageSources = imagePaths.map(read).join('\n');
  expect(imageSources).not.toMatch(/img\.youtube\.com|ytimg\.com|ggpht\.com|images\.genius\.com/i);
  expect(imageSources).toMatch(/youtube_thumbnail/);
});
