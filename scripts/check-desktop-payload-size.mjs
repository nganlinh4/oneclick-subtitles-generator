import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const TAURI_CONFIG = path.join(REPOSITORY_ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
const LARGE_FILE_BYTES = 256 * 1024;
const FRONTEND_BUDGET_BYTES = 30 * 1024 * 1024;
const WINDOWS_EXECUTABLE_BUDGET_BYTES = 16 * 1024 * 1024;
const OTHER_EXECUTABLE_BUDGET_BYTES = 48 * 1024 * 1024;
const EXPECTED_BOOTSTRAPS = new Set([
  'workers/osg_asr_worker.py',
  'workers/osg_speech_worker.py',
  'workers/osg_render_worker.mjs',
]);
const FORBIDDEN_PAYLOAD = /(?:^|[/\\])(?:ffmpeg|ffprobe|yt-dlp|deno|node|chrome|chromium)(?:\.exe)?$|\.(?:dll|dylib|so|node|onnx|pt|pth|safetensors|ckpt|gguf)$/i;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function filesBelow(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      invariant(!entry.isSymbolicLink(), `Payload may not contain symlinks: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  return files;
}

function portable(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

export function auditDesktopPayload({ rootDirectory = REPOSITORY_ROOT, executablePath = null } = {}) {
  const configPath = path.join(rootDirectory, path.relative(REPOSITORY_ROOT, TAURI_CONFIG));
  const configDirectory = path.dirname(configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const frontendDirectory = path.resolve(configDirectory, config.build.frontendDist);
  invariant(fs.statSync(frontendDirectory).isDirectory(), 'Compiled frontend directory is missing');

  const frontendFiles = filesBelow(frontendDirectory).map((absolute) => ({
    path: portable(frontendDirectory, absolute),
    bytes: fs.statSync(absolute).size,
  }));
  const frontendBytes = frontendFiles.reduce((sum, file) => sum + file.bytes, 0);
  invariant(frontendBytes <= FRONTEND_BUDGET_BYTES,
    `Compiled frontend exceeds the ${FRONTEND_BUDGET_BYTES}-byte desktop budget: ${frontendBytes}`);
  for (const file of frontendFiles) {
    invariant(!FORBIDDEN_PAYLOAD.test(file.path), `Forbidden managed payload is embedded in frontend: ${file.path}`);
    invariant(!/product[ _-]?sans/i.test(file.path), `Product Sans remains embedded: ${file.path}`);
  }

  const resources = config.bundle?.resources;
  invariant(resources && typeof resources === 'object' && !Array.isArray(resources),
    'Tauri resources must be a source-to-destination mapping');
  const destinations = Object.values(resources).map((value) => String(value).replaceAll('\\', '/'));
  invariant(destinations.length === EXPECTED_BOOTSTRAPS.size
    && destinations.every((destination) => EXPECTED_BOOTSTRAPS.has(destination)),
  `Tauri must embed only the three protocol bootstrap workers: ${destinations.join(', ')}`);
  for (const [source, destination] of Object.entries(resources)) {
    invariant(!FORBIDDEN_PAYLOAD.test(source) && !FORBIDDEN_PAYLOAD.test(destination),
      `Forbidden managed payload is embedded as a Tauri resource: ${destination}`);
  }

  let executableBytes = null;
  if (executablePath) {
    const absolute = path.resolve(rootDirectory, executablePath);
    const metadata = fs.statSync(absolute);
    invariant(metadata.isFile() && metadata.size > 0, `Desktop executable is missing or empty: ${absolute}`);
    executableBytes = metadata.size;
    const budget = absolute.toLowerCase().endsWith('.exe')
      ? WINDOWS_EXECUTABLE_BUDGET_BYTES
      : OTHER_EXECUTABLE_BUDGET_BYTES;
    invariant(executableBytes <= budget,
      `Desktop executable exceeds the ${budget}-byte budget: ${executableBytes}`);
  }

  return {
    executableBytes,
    frontendBytes,
    frontendFileCount: frontendFiles.length,
    largeFiles: frontendFiles.filter(({ bytes }) => bytes >= LARGE_FILE_BYTES)
      .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)),
    resourceDestinations: destinations.sort(),
  };
}

function parseExecutable(arguments_) {
  const explicit = arguments_.indexOf('--executable');
  if (explicit >= 0) {
    invariant(arguments_[explicit + 1], '--executable requires a path');
    return arguments_[explicit + 1];
  }
  const targetIndex = arguments_.indexOf('--target');
  if (targetIndex < 0) return null;
  const target = arguments_[targetIndex + 1];
  invariant(target && /^[a-z0-9_.-]+$/i.test(target), '--target requires a valid Rust target');
  const suffix = target.endsWith('windows-msvc') ? '.exe' : '';
  return path.join('target', target, 'release', `osg-desktop${suffix}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = auditDesktopPayload({ executablePath: parseExecutable(process.argv.slice(2)) });
    const executable = report.executableBytes === null ? 'not requested' : `${report.executableBytes} bytes`;
    console.log(`Desktop payload passed: executable ${executable}; frontend ${report.frontendBytes} bytes across ${report.frontendFileCount} files; ${report.resourceDestinations.length} bootstrap workers.`);
    for (const file of report.largeFiles) console.log(`  ${file.bytes}\t${file.path}`);
  } catch (error) {
    console.error(`Desktop payload failed: ${error.message}`);
    process.exitCode = 1;
  }
}
