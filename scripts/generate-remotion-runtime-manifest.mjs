import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REMOTION_VERSION = '4.0.507';
const TARGET = 'x86_64-pc-windows-msvc';
const MANIFEST = 'remotion-runtime.json';
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

if (process.argv.length !== 3) {
  throw new Error('usage: generate-remotion-runtime-manifest <new-runtime-root>');
}
const root = path.resolve(process.argv[2]);
if (!fs.lstatSync(root).isDirectory() || fs.existsSync(path.join(root, MANIFEST))) {
  throw new Error('render-runtime-root-must-be-an-unmanifested-directory');
}

const roleByPath = new Map([
  ['bin/node.exe', 'node'],
  ['browser/chrome-win64/chrome.exe', 'browser'],
  ['renderer/node_modules/@remotion/renderer/package.json', 'rendererPackage'],
  ['bundle/index.html', 'bundleIndex'],
  ['renderer/node_modules/@remotion/compositor-win32-x64-msvc/package.json', 'binariesMarker'],
  ['bundle/fonts/fonts.css', 'fontManifest'],
  ['THIRD_PARTY_NOTICES.md', 'notices'],
]);

const files = [];
const pending = [{absolute: root, relative: ''}];
while (pending.length > 0) {
  const directory = pending.pop();
  for (const entry of fs.readdirSync(directory.absolute, {withFileTypes: true})) {
    const absolute = path.join(directory.absolute, entry.name);
    const relative = path.posix.join(directory.relative, entry.name);
    const metadata = fs.lstatSync(absolute);
    if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
      throw new Error('render-runtime-contains-an-unsafe-entry');
    }
    if (metadata.isDirectory()) {
      pending.push({absolute, relative});
      continue;
    }
    if (metadata.size === 0 || metadata.size > MAX_FILE_BYTES || relative === MANIFEST) {
      throw new Error('render-runtime-file-is-invalid');
    }
    files.push({
      role: roleByPath.get(relative) || 'payload',
      path: relative,
      sizeBytes: metadata.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    });
    if (files.length > MAX_FILES) throw new Error('render-runtime-has-too-many-files');
  }
}
files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
for (const [requiredPath, requiredRole] of roleByPath) {
  if (!files.some((file) => file.path === requiredPath && file.role === requiredRole)) {
    throw new Error(`render-runtime-is-missing-${requiredRole}`);
  }
}
fs.writeFileSync(path.join(root, MANIFEST), `${JSON.stringify({
  schemaVersion: 1,
  target: TARGET,
  remotionVersion: REMOTION_VERSION,
  files,
}, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
process.stdout.write(`Inventoried ${files.length} managed Remotion files.\n`);
