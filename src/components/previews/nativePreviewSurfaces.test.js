import { readFileSync, existsSync, globSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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

/**
 * Source with its comments removed, for the guards that search text rather than structure.
 *
 * These files explain what they no longer do — naming the deleted `#fullscreen-subtitle` builder and
 * the `.custom-subtitle` overlay is the point of those comments — and a guard that the explanation
 * itself trips is a guard the next person deletes rather than fixes.
 */
const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

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

describe('no WebView subtitle compositor is reachable from the editor', () => {
  const surfaces = [
    'src/components/previews/VideoPreview.js',
    'src/components/VideoRenderingSection/PreviewCustomizationRow.js',
  ];

  /**
   * Every implementation that has ever drawn a subtitle's APPEARANCE in the WebView.
   *
   * `SubtitleDisplay` is deleted rather than merely unimported, because it was the one that could
   * come back by accident: it was wired in as the composited frame's fallback, so it drew whenever
   * the compositor did not, and a preview that silently changes renderer is the exact disagreement
   * with the export this migration removes. The two Remotion modules are still in the tree and only
   * unreachable, which is why both facts are checked separately below.
   */
  const WEBVIEW_SUBTITLE_COMPOSITORS = [
    '/components/RemotionVideoPreview.js',
    '/components/SubtitledVideoComposition.js',
    '/components/previews/SubtitleDisplay.js',
  ];

  it.each(surfaces)('%s reaches no module that draws a subtitle itself', (entry) => {
    const { files } = moduleGraph(entry);
    for (const compositor of WEBVIEW_SUBTITLE_COMPOSITORS) {
      expect(files.some((file) => file.endsWith(compositor))).toBe(false);
    }
  });

  it.each(surfaces)('%s pulls in no Remotion package', (entry) => {
    const { packages } = moduleGraph(entry);
    expect([...packages].filter((name) => name === 'remotion' || name.startsWith('@remotion/'))).toEqual([]);
  });

  it('leaves both Remotion modules in the tree, because their removal is gated on the parity run', () => {
    expect(existsSync(resolve(ROOT, 'src/components/RemotionVideoPreview.js'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'src/components/SubtitledVideoComposition.js'))).toBe(true);
  });

  it('has no CSS-overlay module left to import', () => {
    expect(existsSync(resolve(ROOT, 'src/components/previews/SubtitleDisplay.js'))).toBe(false);
  });

  /**
   * The overlay's other half was CSS, and CSS is reachable without an import that a module graph can
   * see: a class name in JSX, or a global selector like `::cue` that needs no class at all. So the
   * stylesheets are read directly and required to contain no subtitle appearance of any kind.
   *
   * EVERY stylesheet, not the editor's own. Three of the four selectors below were found in files
   * the video preview does not import — `.video-subtitle` in `OutputContainer.css` and in
   * `video-player-dark-theme.css`, which `src/index.js` loads globally, and an unscoped `::cue`.
   * All were dormant, and all would have composed a second subtitle appearance the moment someone
   * added the class or a `<track>`. Scoping this check to one file is what let them survive.
   */
  it('leaves no stylesheet in the product with a subtitle appearance in it', () => {
    // Matched as whole selectors, not as substrings. `.custom-subtitles` — plural — is the segment
    // retry modal's textarea container, a form input the user types into, and it is in use. A guard
    // that trips on it is a guard someone deletes instead of fixing.
    const banned = [
      /\.custom-subtitle(?![\w-])/,
      /#fullscreen-subtitle(?![\w-])/,
      /\.video-subtitle(?![\w-])/,
      /::cue/,
    ];
    const stylesheets = globSync('src/styles/**/*.css', { cwd: ROOT, absolute: true });
    expect(stylesheets.length).toBeGreaterThan(10);
    for (const path of stylesheets) {
      const declared = withoutComments(readFileSync(path, 'utf8'));
      for (const selector of banned) {
        expect(declared, `${relative(ROOT, path)} styles ${selector.source}`).not.toMatch(selector);
      }
    }
  });

  /**
   * The imperative one left no import and no class behind either — it built a `#fullscreen-subtitle`
   * div and assigned `subtitleSettings` fields straight onto `element.style` — so what is asserted
   * is the absence of the act rather than of a module.
   */
  it('leaves no preview module writing subtitle style onto a DOM node', () => {
    const { files } = moduleGraph('src/components/previews/VideoPreview.js');
    const previewModules = files.filter((file) => file.includes('/components/previews/'));
    expect(previewModules.length).toBeGreaterThan(0);
    for (const file of previewModules) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source).not.toMatch(/\bstyle\.(fontFamily|fontSize|fontWeight|textShadow|letterSpacing|textTransform)\b/);
      expect(source).not.toContain('fullscreen-subtitle');
      expect(source).not.toContain('custom-subtitle');
    }
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

  // `visible` is the surface's own switch, not the playback state: both editor surfaces now keep the
  // element on screen while playing and change which LAYER the frame carries instead. What is
  // asserted here is the switch itself, which is what a surface with no native frames at all uses.
  it('draws nothing at all when the surface is not showing native frames', () => {
    const { container } = render(<NativeCompositedFrame frame={frame} visible={false} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('img')).toBeNull();
  });

  // This element used to accept a `fallback` — the CSS overlay, drawn whenever no native frame had
  // decoded. The prop is gone with the overlay: a second implementation that draws whenever the
  // first cannot is the disagreement with the export the migration removes, so the element now
  // renders a native frame or nothing at all, and the surface states the unavailability in words.
  it('renders a native frame or nothing, with no second implementation to hand over to', () => {
    const { container, rerender } = render(<NativeCompositedFrame frame={null} visible />);
    expect(container.querySelectorAll('img')).toHaveLength(0);

    // A frame has been RETURNED but not yet decoded: still nothing visible, which is why the
    // handover is decided on decode rather than on the return value.
    rerender(<NativeCompositedFrame frame={frame} visible />);
    expect(container.querySelector('.native-composited-frame')).toBeNull();

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(container.querySelector('.native-composited-frame')).not.toBeNull();

    rerender(<NativeCompositedFrame frame={frame} visible={false} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});
