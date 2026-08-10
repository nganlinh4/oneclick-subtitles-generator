import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {bundle} from '@remotion/bundler';

const REMOTION_VERSION = '4.0.507';
const MAX_FONT_FILES = 2_048;
const MAX_FONT_BYTES = 1024 * 1024 * 1024;
const rendererRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(rendererRoot, '..');

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--out', '--fonts'].includes(name) || !value || argumentsByName.has(name)) {
    throw new Error('usage: build-native-bundle --out <empty-directory> --fonts <font-pack-directory>');
  }
  argumentsByName.set(name, value);
}
if (argumentsByName.size !== 2) {
  throw new Error('usage: build-native-bundle --out <empty-directory> --fonts <font-pack-directory>');
}

const outputDirectory = path.resolve(argumentsByName.get('--out'));
const fontDirectory = path.resolve(argumentsByName.get('--fonts'));
if (outputDirectory === repositoryRoot || outputDirectory === rendererRoot
    || outputDirectory.startsWith(`${rendererRoot}${path.sep}`)
    || fs.existsSync(outputDirectory)) {
  throw new Error('native-render-bundle-output-must-be-a-new-external-directory');
}
const fontMetadata = fs.lstatSync(fontDirectory);
if (!fontMetadata.isDirectory() || fontMetadata.isSymbolicLink()) {
  throw new Error('invalid-native-render-font-pack');
}

const fontFiles = [];
const pending = [{source: fontDirectory, relative: ''}];
let fontBytes = 0;
while (pending.length > 0) {
  const {source, relative} = pending.pop();
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    const sourcePath = path.join(source, entry.name);
    const relativePath = path.posix.join(relative, entry.name);
    const metadata = fs.lstatSync(sourcePath);
    if (metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      throw new Error('invalid-native-render-font-pack-entry');
    }
    if (metadata.isDirectory()) {
      pending.push({source: sourcePath, relative: relativePath});
      continue;
    }
    fontBytes += metadata.size;
    fontFiles.push({sourcePath, relativePath, sizeBytes: metadata.size});
    if (fontFiles.length > MAX_FONT_FILES || fontBytes > MAX_FONT_BYTES || metadata.size === 0) {
      throw new Error('native-render-font-pack-exceeds-bounds');
    }
  }
}
const stylesheet = fontFiles.find((file) => file.relativePath === 'fonts.css');
if (!stylesheet) throw new Error('native-render-font-pack-is-missing-fonts.css');
const stylesheetText = fs.readFileSync(stylesheet.sourcePath, 'utf8');
if (/url\(\s*['"]?(?:data:|https?:|\/|\\|\.\.)/i.test(stylesheetText)
    || !/@font-face\b/i.test(stylesheetText)) {
  throw new Error('native-render-font-pack-stylesheet-is-not-offline');
}
const filesByRelativePath = new Map(fontFiles.map((file) => [file.relativePath, file]));
const referencedFontFiles = new Set();
for (const match of stylesheetText.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/gi)) {
  const relativePath = path.posix.normalize(match[1]);
  if (relativePath.startsWith('../') || path.posix.isAbsolute(relativePath)
      || !filesByRelativePath.has(relativePath)) {
    throw new Error('native-render-font-pack-references-an-unmanaged-file');
  }
  referencedFontFiles.add(relativePath);
}
if (referencedFontFiles.size === 0) throw new Error('native-render-font-pack-has-no-font-files');

const fontManifestFile = filesByRelativePath.get('font-pack.json');
if (!fontManifestFile) throw new Error('native-render-font-pack-is-missing-font-pack.json');
const fontManifest = JSON.parse(fs.readFileSync(fontManifestFile.sourcePath, 'utf8'));
if (fontManifest.schemaVersion !== 1 || !Array.isArray(fontManifest.families)
    || fontManifest.families.length === 0) {
  throw new Error('invalid-native-render-font-manifest');
}
const extractFamily = (value) => value.replaceAll(/["']/g, '').split(',')[0].trim();
const requiredFamilies = new Set(['Inter']);
for (const relativePath of [
  'src/components/subtitleCustomization/fontOptions.js',
  'src/components/subtitleCustomization/presetsPartA.js',
  'src/components/subtitleCustomization/presetsPartB.js',
]) {
  const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
  const expression = relativePath.endsWith('fontOptions.js')
    ? /\bvalue:\s*(["'])(.*?)\1/g
    : /\bfontFamily:\s*(["'])(.*?)\1/g;
  for (const match of source.matchAll(expression)) requiredFamilies.add(extractFamily(match[2]));
}
const observedFamilies = new Set();
for (const family of fontManifest.families) {
  if (!family || typeof family.name !== 'string' || family.name !== family.name.trim()
      || family.name.length === 0 || family.name.length > 256
      || observedFamilies.has(family.name) || !Array.isArray(family.faces)
      || family.faces.length === 0 || !family.license
      || typeof family.license.spdx !== 'string' || !family.license.spdx.trim()) {
    throw new Error('invalid-native-render-font-family');
  }
  observedFamilies.add(family.name);
  const noticePath = path.posix.normalize(family.license.noticePath || '');
  if (noticePath.startsWith('../') || !filesByRelativePath.has(noticePath)) {
    throw new Error('native-render-font-license-notice-is-missing');
  }
  const faces = new Set();
  for (const face of family.faces) {
    const facePath = path.posix.normalize(face?.path || '');
    const inventory = filesByRelativePath.get(facePath);
    const identity = `${face?.weight}:${face?.style}`;
    if (!inventory || !referencedFontFiles.has(facePath) || faces.has(identity)
        || !Number.isSafeInteger(face.weight) || face.weight < 100 || face.weight > 900
        || face.weight % 100 !== 0 || !['normal', 'italic'].includes(face.style)
        || face.sizeBytes !== inventory.sizeBytes || !/^[0-9a-f]{64}$/.test(face.sha256)
        || crypto.createHash('sha256').update(fs.readFileSync(inventory.sourcePath)).digest('hex')
          !== face.sha256) {
      throw new Error('invalid-native-render-font-face');
    }
    faces.add(identity);
  }
}
const missingFamilies = [...requiredFamilies].filter((family) => !observedFamilies.has(family));
if (missingFamilies.length > 0) {
  throw new Error(`native-render-font-pack-is-missing-families:${missingFamilies.join(',')}`);
}

for (const packageName of [
  'remotion', '@remotion/bundler', '@remotion/renderer', '@remotion/google-fonts',
]) {
  const packageJson = JSON.parse(fs.readFileSync(
    path.join(repositoryRoot, 'node_modules', packageName, 'package.json'),
    'utf8',
  ));
  if (packageJson.version !== REMOTION_VERSION) throw new Error('remotion-version-drift');
}

process.env.NODE_ENV = 'production';
process.env.TZ = 'UTC';
await bundle({
  entryPoint: path.join(rendererRoot, 'src/remotion/index.ts'),
  outDir: outputDirectory,
  enableCaching: false,
  publicDir: null,
  rootDir: repositoryRoot,
  onSymlinkDetected: () => {
    throw new Error('remotion-bundle-symlink-detected');
  },
});

const outputFonts = path.join(outputDirectory, 'fonts');
for (const fontFile of fontFiles) {
  const destination = path.join(outputFonts, ...fontFile.relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), {recursive: true});
  fs.copyFileSync(fontFile.sourcePath, destination, fs.constants.COPYFILE_EXCL);
}
if (!fs.existsSync(path.join(outputDirectory, 'index.html'))) {
  throw new Error('remotion-bundle-is-missing-index');
}

const bundledFiles = [];
const bundlePending = [outputDirectory];
while (bundlePending.length > 0) {
  const directory = bundlePending.pop();
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      bundlePending.push(absolutePath);
    } else if (entry.isFile()) {
      const bytes = fs.readFileSync(absolutePath);
      bundledFiles.push({
        path: path.relative(outputDirectory, absolutePath).replaceAll('\\', '/'),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
      });
    } else {
      throw new Error('invalid-remotion-bundle-entry');
    }
  }
}
bundledFiles.sort((left, right) => left.path.localeCompare(right.path, 'en'));
fs.writeFileSync(path.join(outputDirectory, 'native-render-bundle.json'), `${JSON.stringify({
  schemaVersion: 1,
  remotionVersion: REMOTION_VERSION,
  files: bundledFiles,
}, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
process.stdout.write(`Native Remotion bundle created with ${bundledFiles.length} verified files.\n`);
