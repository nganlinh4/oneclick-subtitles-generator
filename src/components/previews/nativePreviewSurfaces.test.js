import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import NativeCompositedFrame from './native/NativeCompositedFrame';

/**
 * The editor's two preview surfaces, checked for the two things the migration is actually for: that
 * the second subtitle-drawing implementation is no longer reachable from either of them, and that
 * the element carrying the native frame never shows a blank where a subtitle should be.
 */

const ROOT = resolve(__dirname, '..', '..', '..');
const CANDIDATE_SUFFIXES = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx'];
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

const resolveImport = (specifier, fromFile) => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/** Every module statically reachable from `entry`, plus every bare specifier it pulls in. */
const moduleGraph = (entry) => {
  const files = new Set();
  const packages = new Set();
  const queue = [resolve(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (files.has(file) || !/\.(js|jsx|ts|tsx)$/.test(file)) continue;
    files.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(IMPORT_PATTERN)) {
      if (specifier.startsWith('.')) {
        const resolved = resolveImport(specifier, file);
        if (resolved !== null) queue.push(resolved);
      } else {
        packages.add(specifier);
      }
    }
  }
  return { files: [...files].map((file) => file.replace(/\\/g, '/')), packages };
};

describe('the second subtitle-drawing implementation is unreachable from the editor', () => {
  const surfaces = [
    'src/components/previews/VideoPreview.js',
    'src/components/VideoRenderingSection/PreviewCustomizationRow.js',
  ];

  it.each(surfaces)('%s reaches neither Remotion component', (entry) => {
    const { files } = moduleGraph(entry);
    expect(files.some((file) => file.endsWith('/components/RemotionVideoPreview.js'))).toBe(false);
    expect(files.some((file) => file.endsWith('/components/SubtitledVideoComposition.js'))).toBe(false);
  });

  it.each(surfaces)('%s pulls in no Remotion package', (entry) => {
    const { packages } = moduleGraph(entry);
    expect([...packages].filter((name) => name === 'remotion' || name.startsWith('@remotion/'))).toEqual([]);
  });

  it('leaves both Remotion modules in the tree, because their removal is gated on the parity run', () => {
    expect(existsSync(resolve(ROOT, 'src/components/RemotionVideoPreview.js'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/components/SubtitledVideoComposition.js'))).toBe(true);
  });
});

describe('the composited frame element', () => {
  const frame = Object.freeze({
    url: 'http://127.0.0.1:49152/frame/3f2504e0-4f89-41d3-9a0c-0305e82c3301/7?token=a&frame_token=b',
    cacheKey: 'abcdef01-64:atlas:7',
    frameIndex: 7,
  });

  it('shows nothing until the frame has actually decoded, then shows only that frame', () => {
    const { container } = render(<NativeCompositedFrame frame={frame} visible />);
    expect(container.querySelector('.native-composited-frame')).toBeNull();

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));

    const shown = container.querySelector('.native-composited-frame');
    expect(shown.getAttribute('src')).toBe(frame.url);
    expect(container.querySelector('.native-composited-frame-pending')).toBeNull();
  });

  it('holds the frame already decoded while the next one loads, so a scrub never blanks', () => {
    const next = { ...frame, url: `${frame.url}0`, frameIndex: 8 };
    const { container, rerender } = render(<NativeCompositedFrame frame={frame} visible />);
    fireEvent.load(container.querySelector('.native-composited-frame-pending'));

    rerender(<NativeCompositedFrame frame={next} visible />);
    expect(container.querySelector('.native-composited-frame').getAttribute('src')).toBe(frame.url);

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(container.querySelector('.native-composited-frame').getAttribute('src')).toBe(next.url);
  });

  it('reports a URL the native registry no longer serves instead of leaving a hole', () => {
    const onLoadError = vi.fn();
    const { container } = render(<NativeCompositedFrame frame={frame} visible onLoadError={onLoadError} />);

    fireEvent.error(container.querySelector('.native-composited-frame-pending'));

    expect(onLoadError).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.native-composited-frame')).toBeNull();
  });

  it('draws nothing at all during continuous playback, when the <video> owns the surface', () => {
    const { container } = render(<NativeCompositedFrame frame={frame} visible={false} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('hands the surface over only once a real frame has decoded, so the overlay never blinks out', () => {
    const overlay = <div data-testid="css-overlay" />;
    const { container, rerender } = render(
      <NativeCompositedFrame frame={null} visible fallback={overlay} />,
    );
    expect(screen.getByTestId('css-overlay')).toBeInTheDocument();

    // A frame has been RETURNED but not yet decoded. Deciding the handover on the return value
    // would blank the subtitle for exactly this interval.
    rerender(<NativeCompositedFrame frame={frame} visible fallback={overlay} />);
    expect(screen.getByTestId('css-overlay')).toBeInTheDocument();

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(screen.queryByTestId('css-overlay')).toBeNull();
    expect(container.querySelector('.native-composited-frame')).not.toBeNull();
  });

  it('gives the surface back to the overlay the moment playback starts', () => {
    const overlay = <div data-testid="css-overlay" />;
    const { container, rerender } = render(
      <NativeCompositedFrame frame={frame} visible fallback={overlay} />,
    );
    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(screen.queryByTestId('css-overlay')).toBeNull();

    rerender(<NativeCompositedFrame frame={frame} visible={false} fallback={overlay} />);
    expect(screen.getByTestId('css-overlay')).toBeInTheDocument();
    expect(container.querySelector('.native-composited-frame')).toBeNull();
  });
});
