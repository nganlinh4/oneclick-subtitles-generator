import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PINNED_PROVIDER_IMAGE_SOURCES,
  rewriteProviderImageRenderSource,
} from '../../scripts/provider-image-desktop-boundary.mjs';

describe('provider image desktop boundary', () => {
  it('rewrites every hash-pinned frozen source to native capability state', () => {
    for (const relativePath of Object.keys(PINNED_PROVIDER_IMAGE_SOURCES)) {
      const source = readFileSync(resolve(relativePath), 'utf8');
      const transformed = rewriteProviderImageRenderSource(source, relativePath);
      expect(transformed).toContain('src={selectedVideo.thumbnail}');
      expect(transformed).not.toContain('img.youtube.com');
      if (relativePath.endsWith('YoutubeUrlInput.js')) {
        expect(transformed).toContain('getVideoThumbnail(item.id)');
      }
    }
  });

  it('fails closed when a frozen source drifts before pattern replacement', () => {
    const relativePath = 'src/components/inputs/VideoPreviewRenderer.js';
    const source = readFileSync(resolve(relativePath), 'utf8');
    expect(() => rewriteProviderImageRenderSource(
      `${source}\n// hostile drift`,
      `C:/workspace/${relativePath}`
    )).toThrow(/source integrity mismatch/);
  });
});
