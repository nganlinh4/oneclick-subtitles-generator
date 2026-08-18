import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const TAURI_CONFIG = path.join(REPOSITORY_ROOT, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
/** A backslash, built rather than written so no transport can eat the escape. */
const SEPARATOR = String.fromCharCode(92);
const LARGE_FILE_BYTES = 256 * 1024;
const FRONTEND_BUDGET_BYTES = 30 * 1024 * 1024;
const WINDOWS_EXECUTABLE_BUDGET_BYTES = 16 * 1024 * 1024;
const OTHER_EXECUTABLE_BUDGET_BYTES = 48 * 1024 * 1024;
const EXPECTED_BOOTSTRAPS = new Set([
  'workers/osg_asr_worker.py',
  'workers/osg_speech_worker.py',
]);
/** Text the licences require us to ship beside the code they cover. */
const EXPECTED_LICENCES = new Set([
  'licenses/LICENSE',
  'licenses/THIRD_PARTY_NOTICES.md',
]);
/** A managed font resource is named by its own SHA-256; see `auditManagedFontResources`. */
const UI_FONT_DESTINATION = /^ui-fonts[/]([0-9a-f]{64})$/;
const UI_FONT_DELIVERY = 'crates/osg-engine-packages/delivery/ui-fonts.delivery.json';
/** The reviewed managed font payload is small on purpose, and must stay that way. */
const UI_FONT_BUDGET_BYTES = 768 * 1024;
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

/**
 * The shipped managed font bytes are exactly the bytes the delivery catalog pins.
 *
 * The font is the default subtitle face, so it is bundled rather than downloaded: a clean offline
 * installation must be able to draw a subtitle. Bundling also means the payload can now legitimately
 * carry font bytes, and a name allowlist alone would let any file through under a plausible name. So
 * each resource is verified the way the delivery system verifies a download — its destination IS its
 * SHA-256, that digest is recomputed from the file on disk, and the shipped set must equal the
 * catalog's pinned set exactly, with no extra file and none missing.
 */
function auditManagedFontResources(rootDirectory, configDirectory, resources) {
  const shipped = new Map();
  for (const [source, rawDestination] of Object.entries(resources)) {
    const destination = String(rawDestination).split(SEPARATOR).join('/');
    const match = UI_FONT_DESTINATION.exec(destination);
    if (match === null) continue;
    const contents = fs.readFileSync(path.resolve(configDirectory, source));
    const digest = createHash('sha256').update(contents).digest('hex');
    invariant(digest === match[1],
      `Managed font resource is not the bytes its name claims: ${destination} hashes to ${digest}`);
    shipped.set(digest, contents.length);
  }

  const catalog = JSON.parse(fs.readFileSync(path.join(rootDirectory, UI_FONT_DELIVERY), 'utf8'));
  const pinned = new Set();
  for (const platform of Object.values(catalog.platforms)) {
    for (const release of platform.releases) {
      for (const entry of [...release.sources, release.manifest]) pinned.add(entry.sha256);
    }
  }

  const missing = [...pinned].filter((digest) => !shipped.has(digest));
  invariant(missing.length === 0,
    `The catalog pins managed font bytes the application does not ship: ${missing.join(', ')}`);
  const extra = [...shipped.keys()].filter((digest) => !pinned.has(digest));
  invariant(extra.length === 0,
    `The application ships managed font bytes no catalog pins: ${extra.join(', ')}`);

  const total = [...shipped.values()].reduce((sum, bytes) => sum + bytes, 0);
  invariant(total <= UI_FONT_BUDGET_BYTES,
    `Managed font payload exceeds the ${UI_FONT_BUDGET_BYTES}-byte budget: ${total}`);
  return total;
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
    invariant(!/google[ _-]?sans(?:[ _-]?flex)?\.(?:eot|otf|ttf|woff2?)$/i.test(file.path),
      `Managed Google Sans Flex remains embedded: ${file.path}`);
  }

  const resources = config.bundle?.resources;
  invariant(resources && typeof resources === 'object' && !Array.isArray(resources),
    'Tauri resources must be a source-to-destination mapping');
  const destinations = Object.values(resources)
    .map((value) => String(value).split(SEPARATOR).join('/'));
  const unexpected = destinations.filter((destination) => (
    !EXPECTED_BOOTSTRAPS.has(destination)
      && !EXPECTED_LICENCES.has(destination)
      && !UI_FONT_DESTINATION.test(destination)
  ));
  invariant(unexpected.length === 0,
    `Tauri may embed only reviewed workers, licences and managed font bytes: ${unexpected.join(', ')}`);
  for (const required of [...EXPECTED_BOOTSTRAPS, ...EXPECTED_LICENCES]) {
    invariant(destinations.includes(required), `Tauri no longer embeds ${required}`);
  }
  for (const [source, destination] of Object.entries(resources)) {
    invariant(!FORBIDDEN_PAYLOAD.test(source) && !FORBIDDEN_PAYLOAD.test(destination),
      `Forbidden managed payload is embedded as a Tauri resource: ${destination}`);
  }
  const uiFontBytes = auditManagedFontResources(rootDirectory, configDirectory, resources);

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
    uiFontBytes,
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
    console.log(`Desktop payload passed: executable ${executable}; frontend ${report.frontendBytes} bytes across ${report.frontendFileCount} files; ${report.resourceDestinations.length} embedded resources including ${report.uiFontBytes} bytes of verified managed font.`);
    for (const file of report.largeFiles) console.log(`  ${file.bytes}\t${file.path}`);
  } catch (error) {
    console.error(`Desktop payload failed: ${error.message}`);
    process.exitCode = 1;
  }
}
