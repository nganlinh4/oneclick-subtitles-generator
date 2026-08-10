import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

if (process.argv.length !== 4) {
  throw new Error('usage: generate-remotion-delivery-manifest <package-root> <output-file>');
}
const root = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const runtimeManifestPath = path.join(root, 'runtime', 'remotion-runtime.json');
const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
if (runtimeManifest.schemaVersion !== 1
    || runtimeManifest.target !== 'x86_64-pc-windows-msvc'
    || runtimeManifest.remotionVersion !== '4.0.507'
    || !Array.isArray(runtimeManifest.files)) {
  throw new Error('invalid-remotion-runtime-manifest');
}

const files = runtimeManifest.files.map((file) => ({
  path: `runtime/${file.path}`,
  sizeBytes: file.sizeBytes,
  sha256: file.sha256,
  executable: file.role === 'node' || file.role === 'browser',
  role: 'runtime',
  sourceIndex: 0,
  archivePath: `runtime/${file.path}`,
}));
const runtimeManifestBytes = fs.readFileSync(runtimeManifestPath);
files.push({
  path: 'runtime/remotion-runtime.json',
  sizeBytes: runtimeManifestBytes.length,
  sha256: crypto.createHash('sha256').update(runtimeManifestBytes).digest('hex'),
  executable: false,
  role: 'runtime',
  sourceIndex: 0,
  archivePath: 'runtime/remotion-runtime.json',
});
const noticePath = path.join(root, 'licenses', 'DELIVERY-NOTICES.md');
const noticeBytes = fs.readFileSync(noticePath);
files.push({
  path: 'licenses/DELIVERY-NOTICES.md',
  sizeBytes: noticeBytes.length,
  sha256: crypto.createHash('sha256').update(noticeBytes).digest('hex'),
  executable: false,
  role: 'license',
  sourceIndex: 0,
  archivePath: 'licenses/DELIVERY-NOTICES.md',
});
files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
const unpackedSizeBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  component: 'remotion-runtime',
  platform: 'windows-x86_64',
  version: '4.0.507',
  pythonRelativePath: 'runtime/bin/node.exe',
  modelRelativePath: null,
  alignerRelativePath: null,
  unpackedSizeBytes,
  files,
}, null, 2)}\n`, {encoding: 'utf8', flag: 'wx'});
process.stdout.write(`Inventoried ${files.length} managed delivery files (${unpackedSizeBytes} bytes).\n`);
