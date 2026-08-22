import { readFileSync, existsSync, globSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The editor's two preview surfaces, checked for the two things the migration is actually for: that
 * the second subtitle-drawing implementation is no longer reachable from either of them.
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
  /**
   * The one WebView subtitle compositor that could come back by accident.
   *
   * Asserted as absence rather than as unreachability: a reachability check against a path that no
   * longer resolves passes for the wrong reason, and reads as coverage the next person trusts.
   * `SubtitleDisplay` earns its own guard because it was wired in as the composited frame's
   * fallback, so it drew whenever the compositor did not, and a preview that silently changes
   * renderer is the exact disagreement with the export this migration removes.
   *
   * The browser renderer's own modules and npm packages used to be listed here too. They are not
   * any more, and this is not a gap: `assertNoLegacyRendererResidue` in
   * `scripts/check-release-readiness.js` refuses the token anywhere in `src/`, `crates/`, `apps/`,
   * `scripts/` or either manifest, which covers a package name, an import, a filename and a
   * comment alike. Restating the weaker half here would mean spelling the token in `src/` — the one
   * place that gate exists to keep clean.
   */
  it('SubtitleDisplay is gone from the tree, not merely unimported', () => {
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
