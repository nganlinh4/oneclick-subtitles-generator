// The WebView's fonts ship with the app: pinned bytes, CSS that points only at them, and no CDN.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const BUNDLES = [
  { fonts: 'src/assets/fonts', css: 'src/styles/fonts.css' },
  { fonts: 'promptdj-midi/assets/fonts', css: 'promptdj-midi/styles/fonts.css' },
];
const GOOGLE_FONTS_CDN = /fonts\.(?:googleapis|gstatic)\.com/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist']);

const read = (path) => readFileSync(join(ROOT, path));

const filesBelow = (directory, pattern) => readdirSync(join(ROOT, directory), { withFileTypes: true })
  .flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : filesBelow(path, pattern);
    return pattern.test(entry.name) ? [path] : [];
  });

describe.each(BUNDLES)('bundled fonts in $fonts', ({ fonts, css }) => {
  const manifest = JSON.parse(read(`${fonts}/fonts.manifest.json`));
  const pinned = manifest.families.flatMap((family) => family.files);

  test('every pinned file is present with its recorded size and SHA-256', () => {
    expect(pinned.length).toBeGreaterThan(0);
    for (const file of pinned) {
      const bytes = read(`${fonts}/${file.path}`);
      expect(bytes.length, file.path).toBe(file.sizeBytes);
      expect(createHash('sha256').update(bytes).digest('hex'), file.path).toBe(file.sha256);
      expect(file.sourceUrl).toMatch(/^https:\/\/fonts\.gstatic\.com\/s\/[a-z]+\/v\d+\//);
    }
    const shipped = filesBelow(fonts, /\.woff2$/).map((path) => relative(join(ROOT, fonts), join(ROOT, path)));
    expect(shipped.map((path) => path.split('\\').join('/')).sort())
      .toEqual(pinned.map((file) => file.path).sort());
  });

  test('the stylesheet references exactly the pinned files', () => {
    const cssDirectory = dirname(join(ROOT, css));
    const referenced = [...read(css).toString('utf8').matchAll(/url\('([^']+)'\)/g)]
      .map(([, url]) => resolve(cssDirectory, url));
    for (const target of referenced) expect(existsSync(target) && statSync(target).isFile(), target).toBe(true);
    const expected = pinned.map((file) => resolve(ROOT, fonts, file.path));
    expect([...new Set(referenced)].sort()).toEqual(expected.sort());
  });
});

test('no stylesheet or page loads fonts from the Google Fonts CDN', () => {
  const sources = [
    'index.html',
    'promptdj-midi/index.html',
    ...filesBelow('src', /\.css$/),
    ...filesBelow('promptdj-midi', /\.css$/),
  ];
  const offenders = sources.filter((path) => GOOGLE_FONTS_CDN.test(read(path).toString('utf8')));
  expect(offenders).toEqual([]);
});

test('the desktop CSP admits fonts and stylesheets only from the application', () => {
  const { security } = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).app;
  const allowed = new Set(["'self'", "'unsafe-inline'", 'data:', 'http://127.0.0.1:3030']);
  for (const policy of [security.csp, security.devCsp]) {
    for (const directive of ['font-src', 'style-src']) {
      const sources = policy[directive].trim().split(/\s+/);
      expect(sources.filter((source) => !allowed.has(source)), directive).toEqual([]);
    }
  }
  expect(security.csp['font-src']).not.toContain('127.0.0.1');
  expect(security.csp['style-src']).not.toContain('127.0.0.1');
});
