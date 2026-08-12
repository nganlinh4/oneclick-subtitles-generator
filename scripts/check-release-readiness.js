#!/usr/bin/env node

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = '.github/workflows/rewrite-ci.yml';
const UPDATER_SMOKE_WORKFLOW_PATH = '.github/workflows/updater-smoke.yml';
const TAURI_NSIS_BOOTSTRAP_PATH = 'scripts/prepare-tauri-nsis.ps1';
const TAURI_DIRECTORY = 'apps/desktop/src-tauri';
const TAURI_CONFIG_PATH = `${TAURI_DIRECTORY}/tauri.conf.json`;
const NATIVE_TOOL_DELIVERY_PATH =
  'crates/osg-native-tools/delivery/native-tools.delivery.json';
const NATIVE_TOOL_AUDIT_PATH =
  'crates/osg-native-tools/delivery/native-tools.upstreams.lock.json';
const ASR_DELIVERY_PATH = 'crates/osg-engine-packages/delivery/engine-packages.delivery.json';
const SPEECH_DELIVERY_PATH = 'crates/osg-speech/delivery/speech-packages.delivery.json';
const RENDER_DELIVERY_PATH = 'video-renderer/delivery/remotion-runtime.delivery.json';
const LOOPBACK_AUDIT_PATH = 'scripts/production-loopback-audit.json';
const UPDATER_PUBLIC_KEY_PATH = `${TAURI_DIRECTORY}/updater-public-key.txt`;
const PROMPTDJ_FONT_DIRECTORY = 'promptdj-midi/assets/fonts';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const PYTHON_VERSION = '3.12.10';
const REACT_VERSION = '18.3.1';
const REMOTION_VERSION = '4.0.507';
const SEVEN_ZIP_PACKAGE = '7zip-bin-full';
const SEVEN_ZIP_VERSION = '26.2.1';
const SEVEN_ZIP_RESOLVED =
  'https://registry.npmjs.org/7zip-bin-full/-/7zip-bin-full-26.2.1.tgz';
const SEVEN_ZIP_INTEGRITY =
  'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==';
const CI_UPDATER_WRY_VERSION = '0.55.1';
const CI_UPDATER_WRY_CHECKSUM =
  '186f9871daa55fd9c016578b810d149de58367113db7fb72b462d2323ce19514';
const CI_UPDATER_WRY_DEFAULT_BROWSER_ARGUMENTS =
  '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required';
const TAURI_NSIS_BOOTSTRAP_SHA256 =
  '930bef57b7bccd22ba36ce8a045eabdcb92b74eaeeaa0273cbb45e2a7471d41b';
const DISTRIBUTABLE_FONT_EXTENSION = /\.(?:eot|otf|ttf|woff2?)$/i;

const ACTION_PINS = Object.freeze({
  'actions/checkout': 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/setup-python': 'a309ff8b426b58ec0e2a45f0f869d46889d02405',
  'actions/upload-artifact': 'b7c566a772e6b6bfb58ed0dc250532a479d7789f',
});

const RELEASE_MATRIX = Object.freeze([
  Object.freeze({
    platform: 'Linux x64',
    os: 'ubuntu-24.04',
    target: 'x86_64-unknown-linux-gnu',
    bundles: 'appimage,deb',
  }),
  Object.freeze({
    platform: 'macOS arm64',
    os: 'macos-15',
    target: 'aarch64-apple-darwin',
    bundles: 'app,dmg',
  }),
  Object.freeze({
    platform: 'macOS x64',
    os: 'macos-15-intel',
    target: 'x86_64-apple-darwin',
    bundles: 'app,dmg',
  }),
  Object.freeze({
    platform: 'Windows x64',
    os: 'windows-2022',
    target: 'x86_64-pc-windows-msvc',
    bundles: 'nsis',
  }),
]);

const TARGETS = Object.freeze(
  Object.fromEntries(
    RELEASE_MATRIX.map((entry) => [entry.target, entry]),
  ),
);

const ENGINE_PLATFORM_BY_TARGET = Object.freeze({
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
  'aarch64-apple-darwin': 'macos-aarch64',
  'x86_64-apple-darwin': 'macos-x86_64',
  'x86_64-pc-windows-msvc': 'windows-x86_64',
});

const ASR_ENGINE_IDS = Object.freeze([
  'parakeet',
  'faster-whisper-turbo',
  'faster-whisper-large-v3',
  'qwen3-asr-1.7b',
  'qwen3-asr-0.6b',
]);

const SPEECH_BACKEND_IDS = Object.freeze([
  'f5-tts',
  'chatterbox',
  'edge-tts',
  'gtts',
  'gemini-tts',
]);

const NATIVE_TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const NATIVE_TOOL_EXPECTATIONS = Object.freeze({
  'yt-dlp': Object.freeze({
    license: 'GPL-3.0-or-later',
    noticeCount: 2,
    repository: 'yt-dlp/yt-dlp',
    releaseTag: '2026.07.04',
    revisionKey: 'ytDlp',
    role: 'yt-dlp',
    version: '2026.07.04',
  }),
  deno: Object.freeze({
    license: 'MIT',
    noticeCount: 1,
    repository: 'denoland/deno',
    releaseTag: 'v2.9.5',
    revisionKey: 'deno',
    role: 'deno',
    version: '2.9.5',
  }),
});

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(rootDirectory, relativePath) {
  const absolutePath = path.join(rootDirectory, relativePath);
  try {
    return fs.readFileSync(absolutePath, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new Error(`Could not read ${relativePath}: ${error.message}`);
  }
}

function readJson(rootDirectory, relativePath) {
  try {
    return JSON.parse(readText(rootDirectory, relativePath));
  } catch (error) {
    throw new Error(`Could not parse ${relativePath}: ${error.message}`);
  }
}

function assertLoopbackAuditManifest(rootDirectory) {
  const audit = readJson(rootDirectory, LOOPBACK_AUDIT_PATH);
  invariant(audit.schemaVersion === 2, 'Production transport audit must use schemaVersion 2');
  invariant(audit.productionPolicy === 'native-only',
    'Production transport audit must enforce the native-only policy');
  invariant(audit.guardModule === 'src/platform/browserOnlyService.js',
    'Production transport audit must name the reviewed inspection guard module');
  invariant(fs.existsSync(path.join(rootDirectory, audit.guardModule)),
    `Production inspection guard module is missing: ${audit.guardModule}`);
  invariant(audit.artifactGate === 'scripts/check-production-transport.js',
    'Production transport audit must name the compiled-artifact transport gate');
  invariant(fs.existsSync(path.join(rootDirectory, audit.artifactGate)),
    `Production transport artifact gate is missing: ${audit.artifactGate}`);
  invariant(Array.isArray(audit.reviewedCompatibilitySources),
    'Production transport audit must declare its retained compatibility sources');
  invariant(Array.isArray(audit.missingCapabilities),
    'Production transport audit must declare its unresolved native capabilities array');

  const dispositions = new Set(['development-inspection-only', 'unreachable-visual-compatibility']);
  const reviewedPaths = new Set();
  for (const entry of audit.reviewedCompatibilitySources) {
    invariant(entry && typeof entry.path === 'string' && entry.path.startsWith('src/'),
      'Every retained compatibility entry must name a source path');
    invariant(!reviewedPaths.has(entry.path),
      `Production transport audit repeats ${entry.path}`);
    reviewedPaths.add(entry.path);
    invariant(fs.existsSync(path.join(rootDirectory, entry.path)),
      `Retained compatibility source is missing: ${entry.path}`);
    invariant(dispositions.has(entry.disposition),
      `Retained compatibility source has an invalid disposition: ${entry.path}`);
    invariant(typeof entry.reason === 'string' && entry.reason.length >= 40,
      `Retained compatibility source needs an exact reason: ${entry.path}`);
  }

  const capabilityIds = new Set();
  for (const capability of audit.missingCapabilities) {
    invariant(capability && typeof capability.id === 'string' && capability.id.length > 0,
      'Every missing native capability must have an ID');
    invariant(!capabilityIds.has(capability.id),
      `Production loopback audit repeats capability ${capability.id}`);
    capabilityIds.add(capability.id);
    invariant(typeof capability.requiredContract === 'string'
      && capability.requiredContract.length >= 40,
    `Missing native capability ${capability.id} needs an exact required contract`);
    invariant(Array.isArray(capability.sources) && capability.sources.length > 0,
      `Missing native capability ${capability.id} must name affected sources`);
    for (const source of capability.sources) {
      invariant(typeof source === 'string' && source.startsWith('src/'),
        `Missing native capability ${capability.id} names an invalid source ${source}`);
      invariant(fs.existsSync(path.join(rootDirectory, source)),
        `Missing native capability ${capability.id} source is missing: ${source}`);
    }
  }

  const packageJson = readJson(rootDirectory, 'package.json');
  invariant(packageJson.scripts?.['check:production-transport']
    === 'node scripts/check-production-transport.js',
  'package.json must expose the compiled production transport gate');
  const workflow = readText(rootDirectory, '.github/workflows/rewrite-ci.yml');
  invariant(workflow.includes('npm run check:production-transport'),
    'Rewrite CI must verify the compiled production transport boundary');
  return audit;
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTomlSection(toml, sectionName) {
  const sectionLines = [];
  let found = false;
  for (const line of toml.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (heading) {
      if (found) {
        break;
      }
      found = heading[1].trim() === sectionName;
      continue;
    }
    if (found) {
      sectionLines.push(line);
    }
  }
  invariant(found, `Cargo.toml is missing [${sectionName}]`);
  return sectionLines.join('\n');
}

function extractTomlString(section, key, sourceName) {
  const match = section.match(
    new RegExp(`^\\s*${escapeRegularExpression(key)}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'),
  );
  invariant(match, `${sourceName} is missing a string ${key}`);
  return match[1];
}

function assertPinnedToolchains(rootDirectory = REPOSITORY_ROOT) {
  const nodeVersion = readText(rootDirectory, '.node-version').trim();
  invariant(
    EXACT_VERSION.test(nodeVersion),
    `.node-version must contain one exact stable version, received ${JSON.stringify(nodeVersion)}`,
  );

  const desktopPackage = readJson(rootDirectory, 'apps/desktop/package.json');
  const rootPackage = readJson(rootDirectory, 'package.json');
  invariant(
    typeof desktopPackage.packageManager === 'string' &&
      /^npm@\d+\.\d+\.\d+$/.test(desktopPackage.packageManager),
    'apps/desktop/package.json must pin npm with an exact packageManager version',
  );
  invariant(
    rootPackage.packageManager === desktopPackage.packageManager,
    'Root and desktop package.json must share one exact npm packageManager version',
  );
  const rootTauriCli = rootPackage.devDependencies && rootPackage.devDependencies['@tauri-apps/cli'];
  const desktopTauriCli =
    desktopPackage.devDependencies && desktopPackage.devDependencies['@tauri-apps/cli'];
  invariant(
    EXACT_VERSION.test(rootTauriCli) && rootTauriCli === desktopTauriCli,
    'Root and desktop package.json must share one exact @tauri-apps/cli version',
  );
  invariant(
    EXACT_VERSION.test(rootPackage.dependencies && rootPackage.dependencies['@tauri-apps/api']),
    'package.json must pin @tauri-apps/api to an exact version',
  );
  const rendererPackage = readJson(rootDirectory, 'video-renderer/package.json');
  const promptDjPackage = readJson(rootDirectory, 'promptdj-midi/package.json');
  for (const [relativePath, packageManifest] of [
    ['package.json', rootPackage],
    ['video-renderer/package.json', rendererPackage],
    ['promptdj-midi/package.json', promptDjPackage],
  ]) {
    invariant(
      packageManifest.dependencies &&
        packageManifest.dependencies.react === REACT_VERSION &&
        packageManifest.dependencies['react-dom'] === REACT_VERSION,
      `${relativePath} must pin React and React DOM to the reviewed ${REACT_VERSION} pair`,
    );
  }
  invariant(
    rootPackage.devDependencies &&
      rootPackage.devDependencies[SEVEN_ZIP_PACKAGE] === SEVEN_ZIP_VERSION,
    `package.json must pin ${SEVEN_ZIP_PACKAGE} to exact version ${SEVEN_ZIP_VERSION}`,
  );

  const toolchain = readText(rootDirectory, 'rust-toolchain.toml');
  const toolchainSection = extractTomlSection(toolchain, 'toolchain');
  const rustVersion = extractTomlString(toolchainSection, 'channel', 'rust-toolchain.toml [toolchain]');
  const profile = extractTomlString(toolchainSection, 'profile', 'rust-toolchain.toml [toolchain]');
  invariant(EXACT_VERSION.test(rustVersion), 'rust-toolchain.toml must pin an exact stable Rust version');
  invariant(profile === 'minimal', 'rust-toolchain.toml must use the minimal profile');

  const components = toolchainSection.match(/^\s*components\s*=\s*\[([^\]]*)]\s*(?:#.*)?$/m);
  invariant(components, 'rust-toolchain.toml must declare toolchain components');
  const componentNames = new Set(
    [...components[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]),
  );
  invariant(componentNames.has('clippy'), 'rust-toolchain.toml must include clippy');
  invariant(componentNames.has('rustfmt'), 'rust-toolchain.toml must include rustfmt');

  const cargo = readText(rootDirectory, 'Cargo.toml');
  const workspacePackage = extractTomlSection(cargo, 'workspace.package');
  const minimumRust = extractTomlString(workspacePackage, 'rust-version', 'Cargo.toml [workspace.package]');
  invariant(
    rustVersion.startsWith(`${minimumRust}.`),
    `Cargo.toml rust-version ${minimumRust} must match pinned Rust ${rustVersion} at major/minor precision`,
  );

  return {
    nodeVersion,
    packageManager: desktopPackage.packageManager,
    pythonVersion: PYTHON_VERSION,
    rustVersion,
    tauriCliVersion: rootTauriCli,
  };
}

function walkFiles(directory, predicate, ignoredNames = new Set()) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath, predicate, ignoredNames));
    } else if (entry.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results;
}

function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value.slice('sha512-'.length), 'base64').length === 64;
}

function assertLockfiles(rootDirectory = REPOSITORY_ROOT) {
  const ignoredLockDirectories = new Set(['.git', 'node_modules', 'target']);
  const npmLocks = walkFiles(
    rootDirectory,
    (candidate) => path.basename(candidate) === 'package-lock.json',
    ignoredLockDirectories,
  ).map((candidate) => path.relative(rootDirectory, candidate).replaceAll('\\', '/')).sort();
  invariant(
    JSON.stringify(npmLocks) === JSON.stringify([
      'apps/desktop/package-lock.json',
      'package-lock.json',
    ]),
    `Repository npm lockfile set is unexpected: ${npmLocks.join(', ')}`,
  );
  const expectedTauriCli =
    readJson(rootDirectory, 'apps/desktop/package.json').devDependencies['@tauri-apps/cli'];
  for (const relativePath of ['package-lock.json', 'apps/desktop/package-lock.json']) {
    const lockfile = readJson(rootDirectory, relativePath);
    invariant(lockfile.lockfileVersion === 3, `${relativePath} must use npm lockfileVersion 3`);
    invariant(
      lockfile.packages && lockfile.packages[''],
      `${relativePath} must contain its root package record`,
    );
    const tauriCli = lockfile.packages['node_modules/@tauri-apps/cli'];
    invariant(
      tauriCli && tauriCli.version === expectedTauriCli,
      `${relativePath} must resolve pinned @tauri-apps/cli ${expectedTauriCli}`,
    );
    invariant(
      typeof tauriCli.resolved === 'string' &&
        tauriCli.resolved ===
          `https://registry.npmjs.org/@tauri-apps/cli/-/cli-${tauriCli.version}.tgz`,
      `${relativePath} must resolve @tauri-apps/cli from the canonical npm registry URL`,
    );
    invariant(
      isSha512Integrity(tauriCli.integrity),
      `${relativePath} must integrity-lock @tauri-apps/cli`,
    );
    for (const [packagePath, packageRecord] of Object.entries(lockfile.packages)) {
      if (!packagePath.startsWith('node_modules/') || packageRecord.link === true) {
        continue;
      }
      invariant(
        typeof packageRecord.resolved === 'string' &&
          packageRecord.resolved.startsWith('https://registry.npmjs.org/'),
        `${relativePath} must resolve ${packagePath} from the canonical npm registry`,
      );
      invariant(
        isSha512Integrity(packageRecord.integrity),
        `${relativePath} must integrity-lock ${packagePath}`,
      );
    }
  }

  const rootLock = readJson(rootDirectory, 'package-lock.json');
  const rootRecord = rootLock.packages[''];
  invariant(
    rootRecord.dependencies &&
      rootRecord.dependencies.react === REACT_VERSION &&
      rootRecord.dependencies['react-dom'] === REACT_VERSION,
    `package-lock.json root record must pin React and React DOM to ${REACT_VERSION}`,
  );
  for (const workspacePath of ['promptdj-midi', 'video-renderer']) {
    const workspaceRecord = rootLock.packages[workspacePath];
    invariant(
      workspaceRecord && workspaceRecord.dependencies &&
        workspaceRecord.dependencies.react === REACT_VERSION &&
        workspaceRecord.dependencies['react-dom'] === REACT_VERSION,
      `package-lock.json ${workspacePath} record must pin React and React DOM to ${REACT_VERSION}`,
    );
  }
  for (const packageName of ['react', 'react-dom']) {
    invariant(
      rootLock.packages[`node_modules/${packageName}`]?.version === REACT_VERSION,
      `package-lock.json must resolve ${packageName} ${REACT_VERSION}`,
    );
  }
  const sevenZip = rootLock.packages[`node_modules/${SEVEN_ZIP_PACKAGE}`];
  invariant(
    sevenZip && sevenZip.version === SEVEN_ZIP_VERSION,
    `package-lock.json must resolve ${SEVEN_ZIP_PACKAGE} ${SEVEN_ZIP_VERSION}`,
  );
  invariant(
    sevenZip.resolved === SEVEN_ZIP_RESOLVED && sevenZip.integrity === SEVEN_ZIP_INTEGRITY,
    `package-lock.json must bind ${SEVEN_ZIP_PACKAGE} to its reviewed registry artifact`,
  );
  invariant(
    rootRecord.devDependencies?.[SEVEN_ZIP_PACKAGE] === SEVEN_ZIP_VERSION &&
      sevenZip.dev === true &&
      sevenZip.license === 'MIT' &&
      sevenZip.hasInstallScript !== true &&
      Object.keys(sevenZip.dependencies || {}).length === 0,
    `package-lock.json must keep ${SEVEN_ZIP_PACKAGE} dev-only, MIT, lifecycle-hook-free, and dependency-free`,
  );

  const cargoLock = readText(rootDirectory, 'Cargo.lock');
  invariant(/^version\s*=\s*4\s*$/m.test(cargoLock), 'Cargo.lock must use lockfile format 4');
  const cargoLocks = walkFiles(
    rootDirectory,
    (candidate) => path.basename(candidate) === 'Cargo.lock',
    ignoredLockDirectories,
  ).map((candidate) => path.relative(rootDirectory, candidate).replaceAll('\\', '/')).sort();
  invariant(
    JSON.stringify(cargoLocks) === JSON.stringify(['Cargo.lock']),
    `Release workspace must use exactly the root Cargo.lock; found: ${cargoLocks.join(', ')}`,
  );
  const cargoPackages = cargoLock.split(/^\s*\[\[package]]\s*$/m).slice(1);
  for (const packageBlock of cargoPackages) {
    const name = packageBlock.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m)?.[1] || '<unknown>';
    const source = packageBlock.match(/^\s*source\s*=\s*"([^"]+)"\s*$/m)?.[1];
    if (source?.startsWith('git+')) {
      invariant(
        /^git\+https:\/\/[^#]+#[0-9a-f]{40}$/.test(source),
        `Cargo.lock git dependency ${name} must use HTTPS and a full commit revision`,
      );
    }
    if (source?.startsWith('registry+')) {
      invariant(
        /^\s*checksum\s*=\s*"[0-9a-f]{64}"\s*$/m.test(packageBlock),
        `Cargo.lock registry dependency ${name} must have a full SHA-256 checksum`,
      );
    }
  }

  const workspace = extractTomlSection(readText(rootDirectory, 'Cargo.toml'), 'workspace');
  const membersDeclaration = workspace.match(/^\s*members\s*=\s*\[([\s\S]*?)]\s*(?:#.*)?$/m);
  invariant(membersDeclaration, 'Cargo.toml [workspace] must declare explicit members');
  const workspaceMembers = [...membersDeclaration[1].matchAll(/["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  invariant(workspaceMembers.length > 0, 'Cargo.toml workspace must contain at least one member');
  invariant(
    workspaceMembers.every((member) => !/[?*\[]/.test(member)),
    'Release workspace members must be explicit paths so lockfile coverage is auditable',
  );
  const nestedLocks = workspaceMembers
    .map((member) => path.join(rootDirectory, member, 'Cargo.lock'))
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => path.relative(rootDirectory, candidate).replaceAll('\\', '/'));
  invariant(
    nestedLocks.length === 0,
    `Workspace members must use the root Cargo.lock; remove: ${nestedLocks.join(', ')}`,
  );
}

function assertPinnedActions(workflow) {
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );
  invariant(uses.length > 0, 'The workflow does not use any actions');

  for (const actionReference of uses) {
    if (actionReference.startsWith('./') || actionReference.startsWith('docker://')) {
      continue;
    }
    const match = actionReference.match(/^([^@]+)@([0-9a-f]{40})$/i);
    invariant(match, `GitHub Action ${actionReference} must be pinned to a full commit SHA`);
    const expectedPin = ACTION_PINS[match[1]];
    invariant(expectedPin, `GitHub Action ${match[1]} is not on the reviewed action allowlist`);
    invariant(
      match[2].toLowerCase() === expectedPin,
      `GitHub Action ${match[1]} must use reviewed pin ${expectedPin}`,
    );
  }

  for (const [action, pin] of Object.entries(ACTION_PINS)) {
    invariant(uses.includes(`${action}@${pin}`), `The workflow must use ${action}@${pin}`);
  }
}

function assertTauriNsisBootstrapScript(script) {
  const normalizedScript = script.replace(/\r\n/g, '\n');
  const executablePrologue = [
    '[CmdletBinding()]',
    'param(',
    '  [string]$CacheRoot,',
    '  [string]$ScratchRoot',
    ')',
    '',
    'Set-StrictMode -Version Latest',
    "$ErrorActionPreference = 'Stop'",
    '',
    'if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {',
    "  throw 'The verified Tauri NSIS bootstrap is Windows-only'",
    '}',
    '',
  ].join('\n');
  const successBoundary =
    "Write-Host 'Prepared the verified Tauri NSIS 3.11 toolchain in the exact Windows user cache.'";
  invariant(
    normalizedScript.startsWith(executablePrologue)
      && normalizedScript.trimEnd().endsWith(successBoundary)
      && !/^[ \t]*(?:return|exit)(?:[ \t]+[^#\r\n]+)?[ \t]*(?:#.*)?$/im.test(normalizedScript)
      && !/^[ \t]*(?:if|while)[ \t]*\([ \t]*(?:\$false|0)[ \t]*\)[ \t]*\{[ \t]*(?:#.*)?$/im
        .test(normalizedScript),
    'Tauri NSIS bootstrap must keep its exact executable prologue and top-level success boundary without early termination or dead wrappers',
  );
  invariant(
    crypto.createHash('sha256').update(normalizedScript, 'utf8').digest('hex')
      === TAURI_NSIS_BOOTSTRAP_SHA256,
    'Tauri NSIS bootstrap must match the exact reviewed executable source',
  );
  invariant(
    !/<#|#>/.test(script),
    'Tauri NSIS bootstrap must not contain PowerShell block comments that can hide reviewed controls',
  );
  const exactLinePattern = (line) => new RegExp(
    `^[ \\t]*${escapeRegularExpression(line)}[ \\t]*$`,
    'm',
  );
  const exactLineIndex = (line) => {
    const match = exactLinePattern(line).exec(script);
    return match ? match.index : -1;
  };
  for (const cliBoundary of [
    "$desktopPackagePath = Join-Path $repositoryRoot 'apps\\desktop\\package.json'",
    "if ($desktopPackage.devDependencies.'@tauri-apps/cli' -cne '2.11.4') {",
    "throw 'The verified NSIS cache contract supports only Tauri CLI 2.11.4'",
  ]) {
    invariant(
      exactLinePattern(cliBoundary).test(script),
      `Tauri NSIS bootstrap is missing CLI-version boundary: ${cliBoundary}`,
    );
  }
  const pinnedArtifacts = [
    {
      name: 'nsis-3.11.zip',
      url: 'https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip',
      size: '2361546L',
      sha256: 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1',
      sha1: 'ef7ff767e5cbd9edd22add3a32c9b8f4500bb10d',
    },
    {
      name: 'nsis_tauri_utils.dll',
      url: 'https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll',
      size: '34304L',
      sha256: '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709',
      sha1: '75197fee3c6a814fe035788d1c34ead39349b860',
    },
  ];
  for (const artifact of pinnedArtifacts) {
    const artifactRecord = new RegExp(
      `^[ \\t]+Name = '${escapeRegularExpression(artifact.name)}'[ \\t]*\\r?\\n`
        + `[ \\t]+Url = '${escapeRegularExpression(artifact.url)}'[ \\t]*\\r?\\n`
        + `[ \\t]+Size = ${artifact.size}[ \\t]*\\r?\\n`
        + `[ \\t]+Sha256 = '${artifact.sha256}'[ \\t]*\\r?\\n`
        + `[ \\t]+TauriSha1 = '${artifact.sha1}'[ \\t]*$`,
      'm',
    );
    invariant(
      artifactRecord.test(script),
      `Tauri NSIS bootstrap is missing the exact ordered metadata for ${artifact.name}`,
    );
  }
  invariant(
    (script.match(/^[ \t]+Url = 'https:\/\/[^']+'[ \t]*$/gm) || []).length === pinnedArtifacts.length,
    'Tauri NSIS bootstrap must define exactly two reviewed HTTPS artifact sources',
  );

  invariant(
    !/http:\/\//i.test(script)
      && !/(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer|System\.Net\.WebClient)/i.test(script)
      && !/TAURI_BUNDLER_TOOLS_GITHUB_MIRROR/i.test(script),
    'Tauri NSIS bootstrap must use only its exact reviewed HTTPS sources',
  );
  for (const fragment of [
    '$windowsSystemDirectory = [Environment]::GetFolderPath(',
    '[Environment+SpecialFolder]::System',
    'if ([string]::IsNullOrWhiteSpace($windowsSystemDirectory)) {',
    "throw 'Could not resolve the Windows system directory'",
    '$windowsSystemDirectory = [IO.Path]::GetFullPath($windowsSystemDirectory)',
    "$curlPath = [IO.Path]::GetFullPath((Join-Path $windowsSystemDirectory 'curl.exe'))",
    'if (-not (Test-Path -LiteralPath $curlPath -PathType Leaf)) {',
    "throw 'The reviewed Windows system curl executable is missing or not a leaf file'",
    '$curlItem = Get-Item -LiteralPath $curlPath -Force',
    'if ($curlItem -isnot [IO.FileInfo] -or',
    '$curlItem.PSIsContainer -or',
    '($curlItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {',
    "throw 'Refusing to use a non-file or reparse-point Windows system curl executable'",
  ]) {
    invariant(
      exactLinePattern(fragment).test(script),
      `Tauri NSIS bootstrap is missing reviewed Windows system curl resolution: ${fragment}`,
    );
  }
  invariant(
    !/\bGet-Command\b/i.test(script)
      && !/^[ \t]*where(?:\.exe)?[ \t]/im.test(script)
      && !/\$env:(?:Path|PATHEXT)\b/i.test(script),
    'Tauri NSIS bootstrap must not use PATH or fallback command discovery for curl',
  );
  for (const fragment of [
    '& $curlPath `',
    '--fail `',
    '--location `',
    "--proto '=https' `",
    "--proto-redir '=https' `",
    '--retry-all-errors `',
    '--remove-on-error `',
    '--silent `',
    '--show-error `',
    '--output $Destination `',
    '$Artifact.Url',
  ]) {
    invariant(
      exactLinePattern(fragment).test(script),
      `Tauri NSIS bootstrap is missing bounded HTTPS download control: ${fragment}`,
    );
  }
  for (const [flag, value] of [
    ['--max-redirs', '5'],
    ['--retry', '4'],
    ['--retry-delay', '2'],
    ['--retry-max-time', '120'],
    ['--connect-timeout', '20'],
    ['--max-time', '180'],
  ]) {
    const exactOption = new RegExp(
      `^[ \\t]*${escapeRegularExpression(flag)}[ \\t]+${value}[ \\t]+\\x60[ \\t]*$`,
      'm',
    );
    invariant(
      exactOption.test(script),
      `Tauri NSIS bootstrap must pin bounded curl option ${flag} ${value}`,
    );
  }
  invariant(
    (script.match(/\bcurl\.exe\b/gi) || []).length === 1,
    'Tauri NSIS bootstrap must have one fail-closed curl implementation',
  );

  const fileVerifierStart = exactLineIndex('function Assert-PinnedFile {');
  const downloaderStart = exactLineIndex('function Receive-PinnedArtifact {');
  const layoutVerifierStart = exactLineIndex('function Assert-NsisLayout {');
  invariant(
    fileVerifierStart >= 0 && downloaderStart > fileVerifierStart
      && layoutVerifierStart > downloaderStart,
    'Tauri NSIS bootstrap must define file, download, and layout verification boundaries',
  );
  const fileVerifier = script.slice(fileVerifierStart, downloaderStart);
  const downloader = script.slice(downloaderStart, layoutVerifierStart);
  invariant(
    exactLinePattern('if ((Get-Item -LiteralPath $Path).Length -ne $Artifact.Size) {').test(fileVerifier)
      && exactLinePattern('$sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()').test(fileVerifier)
      && exactLinePattern('if ($sha256 -cne $Artifact.Sha256) {').test(fileVerifier)
      && exactLinePattern('$sha1 = (Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash.ToLowerInvariant()').test(fileVerifier)
      && exactLinePattern('if ($sha1 -cne $Artifact.TauriSha1) {').test(fileVerifier),
    'Tauri NSIS bootstrap must verify size, strong SHA-256, and Tauri compatibility SHA-1',
  );
  invariant(
    exactLinePattern('if ($LASTEXITCODE -ne 0) {').test(downloader)
      && exactLinePattern('Assert-PinnedFile -Path $Destination -Artifact $Artifact').test(downloader),
    'Tauri NSIS bootstrap must reject curl failures and unverified response bytes',
  );

  const requiredFiles = [
    'makensis.exe',
    'Bin\\makensis.exe',
    'Stubs\\lzma-x86-unicode',
    'Stubs\\lzma_solid-x86-unicode',
    'Plugins\\x86-unicode\\additional\\nsis_tauri_utils.dll',
    'Include\\MUI2.nsh',
    'Include\\FileFunc.nsh',
    'Include\\x64.nsh',
    'Include\\nsDialogs.nsh',
    'Include\\WinMessages.nsh',
    'Include\\Win\\COM.nsh',
    'Include\\Win\\Propkey.nsh',
    'Include\\Win\\RestartManager.nsh',
  ];
  for (const [index, requiredFile] of requiredFiles.entries()) {
    const suffix = index === requiredFiles.length - 1 ? '' : ',';
    invariant(
      exactLinePattern(`'${requiredFile}'${suffix}`).test(script),
      `Tauri NSIS bootstrap is missing Tauri-required layout proof: ${requiredFile}`,
    );
  }
  for (const cacheBoundary of [
    "$CacheRoot = Join-Path $localAppData 'tauri'",
    "$nsisRoot = Join-Path $CacheRoot 'NSIS'",
    "Assert-DirectChildPath -Parent $ScratchRoot -Child $workRoot -Label 'NSIS download workspace'",
    "Assert-DirectChildPath -Parent $CacheRoot -Child $candidateRoot -Label 'NSIS candidate cache'",
    "Assert-DirectChildPath -Parent $CacheRoot -Child $backupRoot -Label 'NSIS backup cache'",
    "Assert-DirectChildPath -Parent $CacheRoot -Child $nsisRoot -Label 'Tauri NSIS cache'",
    "foreach ($trustedRoot in @($CacheRoot, $ScratchRoot)) {",
    '($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {',
    "throw 'Refusing to use a non-directory or reparse-point NSIS bootstrap root'",
    "throw 'Refusing to replace a reparse-point Tauri NSIS cache'",
  ]) {
    invariant(
      exactLinePattern(cacheBoundary).test(script),
      `Tauri NSIS bootstrap is missing exact-cache safety boundary: ${cacheBoundary}`,
    );
  }

  const archiveDownload = exactLineIndex(
    'Receive-PinnedArtifact -Artifact $artifacts[0] -Destination $nsisArchive',
  );
  const pluginDownload = exactLineIndex(
    'Receive-PinnedArtifact -Artifact $artifacts[1] -Destination $tauriPlugin',
  );
  const extraction = exactLineIndex(
    'Expand-Archive -LiteralPath $nsisArchive -DestinationPath $candidateRoot',
  );
  const pluginCopy = exactLineIndex(
    "Copy-Item -LiteralPath $tauriPlugin -Destination (Join-Path $pluginDirectory 'nsis_tauri_utils.dll')",
  );
  const candidateVerification = exactLineIndex('Assert-NsisLayout -Root $expandedRoot');
  const publication = exactLineIndex('Move-Item -LiteralPath $expandedRoot -Destination $nsisRoot');
  const finalVerification = exactLineIndex('Assert-NsisLayout -Root $nsisRoot');
  invariant(
    archiveDownload >= 0 && pluginDownload > archiveDownload
      && extraction > pluginDownload && pluginCopy > extraction
      && candidateVerification > pluginCopy && publication > candidateVerification
      && finalVerification > publication,
    'Tauri NSIS bootstrap must verify both downloads and the staged layout before atomic publication',
  );
  invariant(
    exactLinePattern('Move-Item -LiteralPath $nsisRoot -Destination $backupRoot').test(script)
      && exactLinePattern('Move-Item -LiteralPath $backupRoot -Destination $nsisRoot').test(script)
      && exactLinePattern('Remove-Item -LiteralPath $candidateRoot -Recurse -Force').test(script)
      && exactLinePattern('Remove-Item -LiteralPath $workRoot -Recurse -Force').test(script),
    'Tauri NSIS bootstrap must replace the exact cache recoverably and clean bounded staging roots',
  );
}

function assertWorkflowMatrix(workflow) {
  invariant(!/\b(?:ubuntu|macos|windows)-latest\b/i.test(workflow), 'Runner labels must not use mutable *-latest aliases');

  const platformBlocks = [...workflow.matchAll(/^\s{10}- platform:\s*([^\r\n]+)\r?\n([\s\S]*?)(?=^\s{10}- platform:|^\s{4}steps:)/gm)];
  invariant(
    platformBlocks.length === RELEASE_MATRIX.length,
    `Native matrix must contain exactly ${RELEASE_MATRIX.length} explicit platform entries`,
  );

  for (const expected of RELEASE_MATRIX) {
    const block = platformBlocks.find((candidate) => candidate[1].trim() === expected.platform);
    invariant(block, `Native matrix is missing ${expected.platform}`);
    invariant(
      new RegExp(`^\\s*os:\\s*${escapeRegularExpression(expected.os)}\\s*$`, 'm').test(block[2]),
      `${expected.platform} must use ${expected.os}`,
    );
    invariant(
      new RegExp(`^\\s*rust-target:\\s*${escapeRegularExpression(expected.target)}\\s*$`, 'm').test(block[2]),
      `${expected.platform} must build ${expected.target}`,
    );
    invariant(
      new RegExp(`^\\s*bundles:\\s*["']?${escapeRegularExpression(expected.bundles)}["']?\\s*$`, 'm').test(block[2]),
      `${expected.platform} must smoke-package ${expected.bundles}`,
    );
  }
}

function workflowJobBlock(workflow, jobName) {
  const heading = new RegExp(`^  ${escapeRegularExpression(jobName)}:\\s*$`, 'm').exec(workflow);
  invariant(heading, `Workflow is missing job ${jobName}`);
  const tail = workflow.slice(heading.index + heading[0].length);
  const nextJob = /^  [a-zA-Z0-9_-]+:\s*$/m.exec(tail);
  return nextJob ? tail.slice(0, nextJob.index) : tail;
}

function exactWorkflowRunMatches(workflow, command) {
  return [...workflow.matchAll(new RegExp(
    `^ {8}run:[ \\t]+${escapeRegularExpression(command)}[ \\t]*$`,
    'gm',
  ))];
}

function assertWorkflowToolchainPins(workflow) {
  const checkout = `actions/checkout@${ACTION_PINS['actions/checkout']}`;
  const setupNode = `actions/setup-node@${ACTION_PINS['actions/setup-node']}`;
  const setupPython = `actions/setup-python@${ACTION_PINS['actions/setup-python']}`;
  for (const jobName of ['invariants', 'native-matrix', 'windows-installed-smoke']) {
    const job = workflowJobBlock(workflow, jobName);
    invariant(job.includes(`uses: ${checkout}`), `${jobName} must use the reviewed checkout action`);
    invariant(
      job.includes(`uses: ${setupNode}`) && job.includes('node-version-file: .node-version'),
      `${jobName} must install Node through the reviewed setup-node action and .node-version`,
    );
    invariant(
      job.includes(`uses: ${setupPython}`),
      `${jobName} must install Python through the reviewed setup-python action`,
    );
    invariant(
      job.includes(`python-version: "${PYTHON_VERSION}"`),
      `${jobName} must pin Python ${PYTHON_VERSION}`,
    );
    invariant(
      job.includes('node scripts/check-release-readiness.js --profile host-toolchain'),
      `${jobName} must verify the effective Python toolchain with host-toolchain readiness`,
    );
    invariant(
      /npm install --global "\$\(node -p 'require\("\.\/(?:apps\/desktop\/)?package\.json"\)\.packageManager'\)"/
        .test(job),
      `${jobName} must install npm from its exact packageManager pin`,
    );
  }
}

function assertWorkflowCommands(workflow) {
  const requiredFragments = [
    "group: rewrite-ci-${{ github.workflow }}-${{ github.ref }}-${{ github.event_name == 'workflow_dispatch' && inputs.job || 'full' }}",
    'npm ci --ignore-scripts',
    'npm --prefix apps/desktop ci --ignore-scripts',
    'rustup target add "${{ matrix.rust-target }}"',
    'cargo fetch --locked --target "${{ matrix.rust-target }}"',
    'cargo clippy --workspace --all-targets --all-features --locked --target "${{ matrix.rust-target }}" -- -D warnings',
    'cargo test --workspace --all-features --locked --target "${{ matrix.rust-target }}"',
    'node scripts/check-release-readiness.js --profile compile',
    'node scripts/check-release-readiness.js --profile host-toolchain',
    'node scripts/check-release-readiness.js --profile runtime-package --target "${{ matrix.rust-target }}"',
    'node scripts/check-release-artifacts.js --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}" --allow-unsigned-branch-build',
    'node --test scripts/frozen-css-compatibility.test.mjs scripts/check-frozen-css-output.test.mjs',
    'scripts/inspect-installed-webview.test.mjs',
    'scripts/inspect-installed-media-flow.test.mjs',
    'scripts/inspect-installed-local-media-flow.test.mjs',
    'scripts/inspect-installed-media-pipeline.test.mjs',
    'scripts/inspect-installed-editor-flow.test.mjs',
    'npm run build:frontend',
    'node scripts/check-frozen-css-output.mjs',
    'node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --features production --no-bundle --ci --target "${{ matrix.rust-target }}" -- --locked',
    'bundle --ci --no-sign --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
  ];
  for (const fragment of requiredFragments) {
    invariant(workflow.includes(fragment), `The workflow is missing required locked gate: ${fragment}`);
  }
  assertWorkflowToolchainPins(workflow);
  const nativeMatrix = workflowJobBlock(workflow, 'native-matrix');
  const branchInstalledSmoke = workflowJobBlock(workflow, 'windows-installed-smoke');
  const publishedInstalledSmoke = workflowJobBlock(workflow, 'windows-published-installed-smoke');
  const nsisBootstrapCommand = './scripts/prepare-tauri-nsis.ps1';
  const installedMediaFixtureDownload = 'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';
  const installedMediaFixtureAssignment = /^ {10}\$url = 'https:\/\/github\.com\/nganlinh4\/oneclick-subtitles-generator\/releases\/download\/osg-runtime-bundles-v1\/osg-installed-media-smoke-v1-aecf6c8ef3977cd4\.mp4'\r?$/m;
  const pickerEvidenceAssignment = /^ {10}\$pickerEvidencePath = Join-Path \$env:RUNNER_TEMP 'osg-installed-native-picker-evidence\.json'\r?$/m;
  const pickerEvidenceSuccessGate = /^ {10}if \(\$pickerEvidence\.outcome -cne 'succeeded' -or \$pickerEvidence\.stage -cne 'dialog-dismissed'\) \{\r?$/m;
  const pickerEvidenceUpload = /^ {12}\$\{\{ runner\.temp \}\}\/osg-installed-native-picker-evidence\.json\r?$/m;
  const branchWithoutInstalledMediaFixture = branchInstalledSmoke
    .replaceAll(installedMediaFixtureDownload, '');
  invariant(
    workflow.includes('- published-installed-smoke')
      && workflow.includes('- signed-updater-smoke'),
    'Workflow dispatch must keep branch-built, published, and signed-updater smoke tests distinct',
  );
  invariant(
    branchInstalledSmoke.includes("inputs.job == 'installed-smoke'") &&
      branchInstalledSmoke.includes('build --features production --no-bundle --ci --target x86_64-pc-windows-msvc -- --locked') &&
      branchInstalledSmoke.includes('bundle --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis') &&
      branchInstalledSmoke.includes('check-release-artifacts.js --target x86_64-pc-windows-msvc --bundles nsis --allow-unsigned-branch-build') &&
      branchInstalledSmoke.includes('./scripts/test-installed-windows.ps1') &&
      branchInstalledSmoke.includes('-IncludeMediaFlow') &&
      branchInstalledSmoke.includes('-LocalMediaPath $env:OSG_INSTALLED_LOCAL_MEDIA') &&
      branchInstalledSmoke.includes("$resultPath = Join-Path $env:RUNNER_TEMP 'osg-installed-branch-result.json'") &&
      pickerEvidenceAssignment.test(branchInstalledSmoke) &&
      branchInstalledSmoke.includes("throw 'Installed branch native-picker evidence path was not clean'") &&
      pickerEvidenceSuccessGate.test(branchInstalledSmoke) &&
      branchInstalledSmoke.includes('-ResultPath $resultPath') &&
      branchInstalledSmoke.includes("throw 'Installed branch smoke omitted its structured result evidence'") &&
      branchInstalledSmoke.includes('Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json | Out-Null') &&
      branchInstalledSmoke.includes("curl.exe --fail --location --proto '=https' --proto-redir '=https'") &&
      installedMediaFixtureAssignment.test(branchInstalledSmoke) &&
      branchInstalledSmoke.includes('aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db') &&
      branchInstalledSmoke.includes('actions/upload-artifact@') &&
      branchInstalledSmoke.includes('${{ runner.temp }}/osg-*.png') &&
      branchInstalledSmoke.includes('${{ runner.temp }}/osg-installed-branch-result.json') &&
      pickerEvidenceUpload.test(branchInstalledSmoke) &&
      !branchWithoutInstalledMediaFixture.includes('/releases/download/'),
    'installed-smoke must build, validate, install, and launch the current branch without downloading a published release',
  );
  const branchBootstrapRuns = exactWorkflowRunMatches(
    branchInstalledSmoke,
    nsisBootstrapCommand,
  );
  const branchBootstrapStep = new RegExp(
    `^ {6}- name: Prepare verified Tauri NSIS toolchain[ \\t]*\\r?\\n`
      + `^ {8}shell: pwsh[ \\t]*\\r?\\n`
      + `^ {8}run: ${escapeRegularExpression(nsisBootstrapCommand)}[ \\t]*$`,
    'm',
  );
  const branchBootstrapIndex = branchBootstrapRuns[0]?.index ?? -1;
  const branchCompileIndex = branchInstalledSmoke.indexOf(
    'build --features production --no-bundle --ci --target x86_64-pc-windows-msvc -- --locked',
  );
  const branchBundleIndex = branchInstalledSmoke.indexOf(
    'bundle --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis',
  );
  invariant(
    branchBootstrapStep.test(branchInstalledSmoke)
      && branchBootstrapIndex >= 0 && branchCompileIndex > branchBootstrapIndex
      && branchBundleIndex > branchCompileIndex
      && branchBootstrapRuns.length === 1
      && (branchInstalledSmoke.match(/\.\/scripts\/prepare-tauri-nsis\.ps1/g) || []).length === 1,
    'installed-smoke must prepare the verified Tauri NSIS cache exactly once before bundling',
  );
  invariant(
    publishedInstalledSmoke.includes("inputs.job == 'published-installed-smoke'") &&
      publishedInstalledSmoke.includes('timeout-minutes: 90') &&
      publishedInstalledSmoke.includes('/releases/download/v${version}') &&
      publishedInstalledSmoke.includes('$asset.sig') &&
      !publishedInstalledSmoke.includes('--allow-unsigned-branch-build') &&
      publishedInstalledSmoke.includes('./scripts/test-installed-windows.ps1') &&
      publishedInstalledSmoke.includes('-IncludeMediaFlow') &&
      publishedInstalledSmoke.includes('-LocalMediaPath $env:OSG_INSTALLED_LOCAL_MEDIA') &&
      publishedInstalledSmoke.includes("$resultPath = Join-Path $env:RUNNER_TEMP 'osg-installed-published-result.json'") &&
      pickerEvidenceAssignment.test(publishedInstalledSmoke) &&
      publishedInstalledSmoke.includes("throw 'Installed published native-picker evidence path was not clean'") &&
      pickerEvidenceSuccessGate.test(publishedInstalledSmoke) &&
      publishedInstalledSmoke.includes('-ResultPath $resultPath') &&
      publishedInstalledSmoke.includes("throw 'Installed published smoke omitted its structured result evidence'") &&
      publishedInstalledSmoke.includes('Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json | Out-Null') &&
      publishedInstalledSmoke.includes("curl.exe --fail --location --proto '=https' --proto-redir '=https'") &&
      installedMediaFixtureAssignment.test(publishedInstalledSmoke) &&
      publishedInstalledSmoke.includes('aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db') &&
      publishedInstalledSmoke.includes('actions/upload-artifact@') &&
      publishedInstalledSmoke.includes('${{ runner.temp }}/osg-*.png') &&
      publishedInstalledSmoke.includes('${{ runner.temp }}/osg-installed-published-result.json') &&
      pickerEvidenceUpload.test(publishedInstalledSmoke),
    'published-installed-smoke must validate and launch the signed immutable release artifact',
  );
  const frontendBuildIndex = nativeMatrix.indexOf('run: npm run build:frontend');
  const rustClippyIndex = nativeMatrix.indexOf(
    'run: cargo clippy --workspace --all-targets --all-features --locked',
  );
  invariant(
    frontendBuildIndex !== -1 && rustClippyIndex !== -1 && frontendBuildIndex < rustClippyIndex,
    'native-matrix must build frontendDist before compiling the Tauri Rust workspace',
  );
  const guardedTauriCompile =
    'run: node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build --features production --no-bundle --ci --target "${{ matrix.rust-target }}" -- --locked';
  invariant(
    nativeMatrix.includes(guardedTauriCompile),
    'native-matrix must compile release executables through the production-feature Tauri wrapper',
  );
  invariant(
    !nativeMatrix.includes('run: npm --prefix apps/desktop run tauri -- build'),
    'native-matrix must not compile a release executable through the raw Tauri script',
  );
  const nativeBootstrapStep = new RegExp(
    `^ {6}- name: Prepare verified Tauri NSIS toolchain[ \\t]*\\r?\\n`
      + `^ {8}if: github\\.event_name == 'workflow_dispatch' && matrix\\.rust-target == 'x86_64-pc-windows-msvc'[ \\t]*\\r?\\n`
      + `^ {8}shell: pwsh[ \\t]*\\r?\\n`
      + `^ {8}run: ${escapeRegularExpression(nsisBootstrapCommand)}[ \\t]*$`,
    'm',
  );
  const nativeBootstrapRuns = exactWorkflowRunMatches(nativeMatrix, nsisBootstrapCommand);
  const nativeBootstrapIndex = nativeBootstrapRuns[0]?.index ?? -1;
  const nativeBundleIndex = nativeMatrix.indexOf(
    'npm --prefix apps/desktop run tauri -- bundle --ci --no-sign --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
  );
  invariant(
    nativeBootstrapStep.test(nativeMatrix)
      && nativeBootstrapIndex >= 0 && nativeBundleIndex > nativeBootstrapIndex
      && nativeBootstrapRuns.length === 1
      && (nativeMatrix.match(/\.\/scripts\/prepare-tauri-nsis\.ps1/g) || []).length === 1,
    'native-matrix must prepare verified NSIS only for manual Windows packaging and before bundling',
  );

  for (const manualCommand of [
    'node scripts/check-release-readiness.js --profile runtime-package --target "${{ matrix.rust-target }}"',
    'npm --prefix apps/desktop run tauri -- bundle --ci --no-sign --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
    'node scripts/check-release-artifacts.js --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}" --allow-unsigned-branch-build',
  ]) {
    const guardedStep = new RegExp(
      `- name:[^\\r\\n]+\\r?\\n\\s+if: github\\.event_name == 'workflow_dispatch'\\r?\\n\\s+run: ${escapeRegularExpression(manualCommand)}`,
    );
    invariant(
      guardedStep.test(workflow),
      `Unsigned package validation must be manual-only: ${manualCommand}`,
    );
  }

  invariant(!/CI:\s*["']?false["']?/i.test(workflow), 'CI builds must not suppress frontend warnings with CI=false');
  invariant(!/^\s*pull_request_target\s*:/m.test(workflow), 'Build workflows must not execute fork code through pull_request_target');
  invariant(
    /^permissions:\s*\r?\n\s{2}contents:\s*read\s*$/m.test(workflow) &&
      !/^\s{2,}[a-z-]+:\s*write\s*$/m.test(workflow),
    'Build workflow permissions must remain contents: read only',
  );
  const signedUpdaterWrapper = workflowJobBlock(workflow, 'signed-updater-smoke');
  const unsignedWorkflow = workflow.replace(signedUpdaterWrapper, '');
  invariant(
    /^\s{4}if: github\.event_name == 'workflow_dispatch' && inputs\.job == 'signed-updater-smoke'\s*$/m
      .test(signedUpdaterWrapper)
      && signedUpdaterWrapper.includes('uses: ./.github/workflows/updater-smoke.yml')
      && signedUpdaterWrapper.includes('TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}')
      && signedUpdaterWrapper.includes('TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}'),
    'Only the manual signed-updater wrapper may forward the two reviewed signing secrets',
  );
  invariant(!/\$\{\{\s*secrets\./i.test(unsignedWorkflow),
    'Unsigned CI jobs must not depend on repository secrets');
  invariant(
    !/(?:TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_SIGNING_IDENTITY|CSC_LINK|WIN_CSC_LINK|WINDOWS_CERTIFICATE)/i.test(unsignedWorkflow),
    'Unsigned CI jobs must not configure code-signing credentials',
  );
  const checkoutCount = (workflow.match(/uses:\s*actions\/checkout@/g) || []).length;
  const nonPersistingCheckoutCount = (workflow.match(/persist-credentials:\s*false/g) || []).length;
  invariant(
    checkoutCount > 0 && nonPersistingCheckoutCount === checkoutCount,
    'Every checkout step must disable persisted Git credentials',
  );

  for (const dependency of [
    'libayatana-appindicator3-dev',
    'librsvg2-dev',
    'libwebkit2gtk-4.1-dev',
  ]) {
    invariant(workflow.includes(dependency), `Linux Tauri builds must install ${dependency}`);
  }
}

function assertInstalledSmokeScript(script) {
  const requiredFragments = [
    "$env:CI -ne 'true'",
    '$installed = Install-Application',
    "-Phase 'first-launch'",
    "-Phase 'relaunch'",
    '$fontBeforeRelaunch = Get-FontSnapshot',
    '$fontAfterRelaunch = Get-FontSnapshot',
    '$fontAfterRelaunch -cne $fontBeforeRelaunch',
    'Uninstall-Application -Installation $installed',
    '$reinstalled = Install-Application',
    "-Phase 'reinstall-launch'",
    'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    'scripts/inspect-installed-webview.mjs',
    'scripts/inspect-installed-media-flow.mjs',
    'scripts/inspect-installed-local-media-flow.mjs',
    'scripts/inspect-installed-media-pipeline.mjs',
    'scripts/inspect-installed-editor-flow.mjs',
    '$inspection = Inspect-InstalledWebView',
    '$initialMediaFlow = Inspect-InstalledMediaFlow',
    '$mediaFlow = Inspect-InstalledMediaFlow',
    "@('--prior-asset-id', $PriorAssetId)",
    '-PriorAssetId $localMediaFlow.assetId',
    '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
    '$mediaPipeline = Inspect-InstalledMediaPipeline',
    '$editorFlow = Inspect-InstalledEditorFlow',
    'function Inspect-InstalledMediaPipeline',
    'function Inspect-InstalledEditorFlow',
    "'--expected-source-name', $ExpectedSourceName",
    "'osg-installed-editor-flow.png'",
    'function Complete-NativeMediaPicker',
    'function Set-NativePickerEvidence',
    'function Get-NativeMediaPickerDialogs',
    'function Dismiss-NativeMediaPicker',
    "$nativePickerEvidencePath = Join-Path $runnerTempRoot 'osg-installed-native-picker-evidence.json'",
    '[IO.File]::Replace(',
    ".Current.Name -ceq 'Choose video or audio'",
    ".Current.ClassName -ceq '#32770'",
    '[OsgNativePickerWindow]::GetWindow($nativeHandle, 4)',
    '-OwnerHandle $ownerHandle',
    '[System.Windows.Automation.ValuePattern]::Pattern',
    '[StringComparison]::Ordinal',
    '$invokePattern.Invoke()',
    '$remainingDialogs.Count -eq 0',
    "-Stage 'dialog-dismissed'",
    "-Outcome 'succeeded'",
    'osg-installed-media-flow-initial.png',
    "Where-Object event -eq 'download.completed'",
    "Where-Object event -eq 'native-tool.completed'",
    "Where-Object event -eq 'native-tool.started'",
    "'native-tool.failed'",
    "'native-tool.cancelled'",
    "'native-tool.invalid-terminal'",
    '$failedTools.Count -ne 0',
    '$lastStartedIndex -ge $firstCompletedIndex',
    '$startedToolEvents.Count -ne 3',
    '$completedToolEvents.Count -ne 3',
    '$startedToolJobs.Count -ne 3',
    '$completedToolJobs.Count -ne 3',
    "($startedToolJobs -join ',') -cne ($completedToolJobs -join ',')",
    "($startedToolPairs -join ',') -cne ($completedToolPairs -join ',')",
    '$invalidToolJobIds.Count -ne 0',
    'function Get-DiagnosticEventCount',
    "Get-DiagnosticEventCount -LogPath $LogPath -Name 'app.close_requested'",
    '$Process.MainWindowHandle -eq [IntPtr]::Zero -or -not $Process.Responding',
    '$Process.ExitCode -ne 0',
    '$closeEventsAfter -ne ($closeEventsBefore + 1)',
    'Stop-Application -Process $first.Process -LogPath $logPath',
    'Stop-Application -Process $second.Process -LogPath $logPath',
    'Stop-Application -Process $third.Process -LogPath $logPath',
    '$startedDownloads.Count -ne 2',
    '$completedDownloads.Count -ne 2',
    '$startedDownloadJobs.Count -ne 2',
    '$completedDownloadJobs.Count -ne 2',
    "($startedDownloadJobs -join ',') -cne ($completedDownloadJobs -join ',')",
    '$invalidDownloadJobIds.Count -ne 0',
    "-notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'",
    "'download.cancelled'",
    "'download.failed'",
    "'download.admission_failed'",
    "'download.engine_failed'",
    "'download.command_failed'",
    "'download.inspection_failed'",
    '$failedDownloads.Count -ne 0',
    '$initialMediaFlow.assetId -eq $localMediaFlow.assetId',
    '$localMediaFlow.assetId -eq $mediaFlow.assetId',
    'installedInitialMediaFlow = $initialMediaFlow',
    'installedMediaFlow = $mediaFlow',
    'installedLocalMediaFlow = $localMediaFlow',
    'installedMediaPipeline = $mediaPipeline',
    'installedEditorFlow = $editorFlow',
    'Installed smoke result evidence exposed a URL, capability, token, or filesystem path',
    'firstLaunchWebView = $first.Inspection',
    'managedFontCacheStable = $true',
    '$rotationFixtureSha256 = Prepare-DiagnosticRotationFixture',
    '-ExpectedPreviousSha256 $rotationFixtureSha256',
    'diagnosticLogRotation = $true',
    'uninstallPreservedProfile = $true',
  ];
  for (const fragment of requiredFragments) {
    invariant(
      script.includes(fragment),
      `Installed Windows smoke is missing lifecycle proof: ${fragment}`,
    );
  }
  const stopFunctionStart = script.indexOf('function Stop-Application {');
  const stopFunctionEnd = script.indexOf('\nfunction ', stopFunctionStart + 1);
  const stopFunction = stopFunctionStart >= 0 && stopFunctionEnd > stopFunctionStart
    ? script.slice(stopFunctionStart, stopFunctionEnd)
    : '';
  invariant(
    /\$Process\.Refresh\(\)/.test(stopFunction)
      && /if\s*\(\$Process\.HasExited\)\s*\{\s*throw/.test(stopFunction)
      && /\$Process\.MainWindowHandle\s+-eq\s+\[IntPtr\]::Zero\s+-or\s+-not\s+\$Process\.Responding/.test(stopFunction)
      && /\$closeEventsBefore\s*=\s*Get-DiagnosticEventCount\s+-LogPath\s+\$LogPath\s+-Name\s+'app\.close_requested'/.test(stopFunction)
      && /\$Process\.CloseMainWindow\(\)/.test(stopFunction)
      && /\$Process\.WaitForExit\(30000\)/.test(stopFunction)
      && /if\s*\(\$Process\.ExitCode\s+-ne\s+0\)\s*\{\s*throw/.test(stopFunction)
      && /\$closeEventsAfter\s+-ne\s+\(\$closeEventsBefore\s+\+\s+1\)/.test(stopFunction),
    'Installed Windows smoke must close only a live responsive app and prove one clean flushed close',
  );
  const mediaFlowFunctionStart = script.indexOf('function Inspect-InstalledMediaFlow {');
  const mediaFlowFunctionEnd = script.indexOf('\nfunction ', mediaFlowFunctionStart + 1);
  const mediaFlowFunction = mediaFlowFunctionStart >= 0
    && mediaFlowFunctionEnd > mediaFlowFunctionStart
    ? script.slice(mediaFlowFunctionStart, mediaFlowFunctionEnd)
    : '';
  invariant(
    /^\s{4}\$arguments \+= @\('--prior-asset-id', \$PriorAssetId\)\s*$/m
      .test(mediaFlowFunction)
      && /^\s{6}-PriorAssetId \$localMediaFlow\.assetId\s*$/m.test(script),
    'Installed Windows smoke must bind the second URL pass to the prior local-media identity',
  );
  const orderedInstalledMediaFragments = [
    '$initialMediaFlow = Inspect-InstalledMediaFlow',
    '$localMediaFlow = Inspect-InstalledLocalMediaFlow',
    '$mediaPipeline = Inspect-InstalledMediaPipeline',
    '$mediaFlow = Inspect-InstalledMediaFlow',
    "throw 'Installed media-flow did not start all three native tool downloads in parallel'",
    '$editorFlow = Inspect-InstalledEditorFlow',
  ];
  const orderedInstalledMediaIndices = orderedInstalledMediaFragments
    .map((fragment) => script.indexOf(fragment));
  invariant(orderedInstalledMediaIndices.every((index) => index >= 0)
    && orderedInstalledMediaIndices.every((index, position) => (
      position === 0 || orderedInstalledMediaIndices[position - 1] < index
    )),
  'Installed Windows smoke is missing lifecycle proof: ordered installed media flow');
  const pickerFunctionStart = script.indexOf('function Complete-NativeMediaPicker {');
  const pickerFunctionEnd = script.indexOf('\nfunction ', pickerFunctionStart + 1);
  const pickerFunction = pickerFunctionStart >= 0 && pickerFunctionEnd > pickerFunctionStart
    ? script.slice(pickerFunctionStart, pickerFunctionEnd)
    : '';
  invariant(
    (pickerFunction.match(/\.AddSeconds\(30\)/g) || []).length >= 4
      && pickerFunction.includes('$fileNameControls = @($dialog.FindAll(')
      && pickerFunction.includes('$openButtons = @($dialog.FindAll(')
      && pickerFunction.includes('$fileNameControls.Count -eq 1')
      && pickerFunction.includes('$openButtons.Count -eq 1')
      && pickerFunction.includes('$valuePattern.SetValue($MediaPath)')
      && pickerFunction.includes('[StringComparison]::Ordinal')
      && pickerFunction.includes('$invokePattern.Invoke()')
      && pickerFunction.includes('$remainingDialogs.Count -eq 0')
      && pickerFunction.includes("-Stage 'dialog-dismissed'")
      && pickerFunction.includes("-Outcome 'succeeded'")
      && pickerFunction.includes("-Stage 'failed'")
      && /catch\s*\{[\s\S]*?Set-NativePickerEvidence[\s\S]*?\bthrow\s*\r?\n\s*\}/.test(pickerFunction),
    'Installed native-picker automation must retry settled unique controls, invoke without focus, prove dismissal, and preserve its primary exception',
  );
  invariant(
    !/(?:SendKeys|SetFocus|SetForegroundWindow|mouse_event|keybd_event|System\.Windows\.Forms\.Cursor|Clipboard)/i.test(script),
    'Installed native-picker automation must remain non-focus-stealing and clipboard-free',
  );
  const evidenceWriterStart = script.indexOf('function Set-NativePickerEvidence {');
  const evidenceWriterEnd = script.indexOf('\nfunction ', evidenceWriterStart + 1);
  const evidenceWriter = evidenceWriterStart >= 0 && evidenceWriterEnd > evidenceWriterStart
    ? script.slice(evidenceWriterStart, evidenceWriterEnd)
    : '';
  const evidenceInitializerStart = script.indexOf('function Initialize-NativePickerEvidence {');
  const evidenceInitializerEnd = script.indexOf('\nfunction ', evidenceInitializerStart + 1);
  const evidenceInitializer = evidenceInitializerStart >= 0
    && evidenceInitializerEnd > evidenceInitializerStart
    ? script.slice(evidenceInitializerStart, evidenceInitializerEnd)
    : '';
  invariant(
    evidenceWriter.includes('$script:nativePickerEvidenceStages.Count -ge 16')
      && evidenceWriter.includes('[Text.Encoding]::UTF8.GetByteCount($json) -gt 16384')
      && evidenceWriter.includes('$nativePickerEvidenceTemporaryPath')
      && evidenceWriter.includes('[IO.File]::Replace(')
      && evidenceWriter.includes('[IO.File]::Move(')
      && evidenceWriter.includes('(?:path|pid|hwnd|handle|title|url|token)')
      && !/(?:\$MediaPath|\$ProcessId|\$OwnerHandle|\.Exception)/.test(evidenceWriter)
      && /schemaVersion\s*=\s*1/.test(evidenceInitializer)
      && !/^\s*[A-Za-z0-9_]*(?:path|pid|hwnd|handle|title|url|token)[A-Za-z0-9_]*\s*=/im.test(evidenceInitializer),
    'Installed native-picker evidence must remain atomic, bounded, and free of paths, process/window identities, titles, URLs, tokens, and exception text',
  );
  const localMediaFunctionStart = script.indexOf('function Inspect-InstalledLocalMediaFlow {');
  const localMediaFunctionEnd = script.indexOf('\nfunction ', localMediaFunctionStart + 1);
  const localMediaFunction = localMediaFunctionStart >= 0
    && localMediaFunctionEnd > localMediaFunctionStart
    ? script.slice(localMediaFunctionStart, localMediaFunctionEnd)
    : '';
  invariant(
    localMediaFunction.includes('$ownerHandle = $applicationProcess.MainWindowHandle.ToInt64()')
      && localMediaFunction.includes('-OwnerHandle $ownerHandle')
      && /finally\s*\{\s*try\s*\{[\s\S]*?Stop-Process[\s\S]*?\}\s*catch\s*\{/.test(localMediaFunction),
    'Installed local-media inspector cleanup must be non-throwing and bind automation to the original native owner',
  );
  const thirdLaunchStart = script.indexOf('$third = Start-And-WaitForReadiness');
  const thirdLaunchFlow = thirdLaunchStart >= 0 ? script.slice(thirdLaunchStart) : '';
  invariant(
    thirdLaunchFlow.includes('[void](Dismiss-NativeMediaPicker')
      && /catch\s*\{[\s\S]*?Dismiss-NativeMediaPicker[\s\S]*?Stop-Application[\s\S]*?\bthrow\s*\r?\n\s*\}/.test(thirdLaunchFlow)
      && !/finally\s*\{\s*Stop-Application\s+-Process\s+\$third\.Process/.test(thirdLaunchFlow),
    'Installed smoke failure cleanup must dismiss the exact picker and preserve the primary exception',
  );
  invariant(
    !/(?:Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer)/i.test(script),
    'Installed Windows smoke must validate the branch-built installer without a second download',
  );
}

function assertUpdaterSmokeWorkflow(workflow) {
  assertPinnedActions(workflow);
  invariant(/^on:\s*\r?\n\s{2}workflow_dispatch:\s*$/m.test(workflow)
    && /^\s{2}workflow_call:\s*$/m.test(workflow)
    && !/^\s{2}(?:push|pull_request|pull_request_target|schedule):/m.test(workflow),
  'Signed updater smoke must be explicit workflow_dispatch/workflow_call only');
  invariant(/^permissions:\s*\r?\n\s{2}contents:\s*read\s*$/m.test(workflow)
    && !/^\s{2,}[a-z-]+:\s*write\s*$/m.test(workflow),
  'Signed updater smoke must keep read-only repository permissions');
  const secrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*}}/g)]
    .map((match) => match[1]).sort();
  invariant(JSON.stringify(secrets) === JSON.stringify([
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
  ]), 'Signed updater smoke may consume only the two reviewed updater signing secrets');
  const requiredFragments = [
    'runs-on: windows-2022',
    'OSG_ENABLE_SIGNED_UPDATER_FIXTURE: "1"',
    'node scripts/check-release-readiness.js --profile runtime-package --target x86_64-pc-windows-msvc',
    'npm run test:updater-fixture',
    'build --features production,ci-updater-fixture --no-bundle --ci --target x86_64-pc-windows-msvc -- --locked',
    './scripts/prepare-tauri-nsis.ps1',
    'bundle --features production,ci-updater-fixture --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis',
    "version = '1.0.0-rc.2'",
    "build = @{ beforeBuildCommand = '' }",
    '--features production,ci-updater-fixture',
    'node scripts/check-release-artifacts.js --target x86_64-pc-windows-msvc --bundles nsis',
    './scripts/test-installed-windows.ps1',
    '-ResultPath (Join-Path $env:RUNNER_TEMP \'osg-installed-base.json\')',
    './scripts/test-signed-updater-windows.ps1',
    "url = 'https://localhost:38443/update.exe'",
    '${{ runner.temp }}/osg-updater-trigger.png',
    '${{ runner.temp }}/osg-updater-relaunch-verify.png',
    '${{ runner.temp }}/osg-updater-verify.png',
    '${{ runner.temp }}/osg-updater-close-evidence.json',
    '${{ runner.temp }}/osg-updater-diagnostics.log',
  ];
  for (const fragment of requiredFragments) {
    invariant(workflow.includes(fragment),
      `Signed updater smoke is missing required boundary: ${fragment}`);
  }
  const nsisBootstrapCommand = './scripts/prepare-tauri-nsis.ps1';
  const nsisBootstrapRuns = exactWorkflowRunMatches(workflow, nsisBootstrapCommand);
  const nsisBootstrapStep = new RegExp(
    `^ {6}- name: Prepare verified Tauri NSIS toolchain[ \\t]*\\r?\\n`
      + `^ {8}shell: pwsh[ \\t]*\\r?\\n`
      + `^ {8}run: ${escapeRegularExpression(nsisBootstrapCommand)}[ \\t]*$`,
    'm',
  );
  const nsisBootstrapIndex = nsisBootstrapRuns[0]?.index ?? -1;
  const baseCompileIndex = workflow.indexOf(
    'build --features production,ci-updater-fixture --no-bundle --ci --target x86_64-pc-windows-msvc -- --locked',
  );
  const baseBundleIndex = workflow.indexOf(
    'bundle --features production,ci-updater-fixture --ci --no-sign --target x86_64-pc-windows-msvc --bundles nsis',
  );
  const signedBundleIndex = workflow.indexOf(
    'node apps/desktop/node_modules/@tauri-apps/cli/tauri.js build `',
    baseBundleIndex,
  );
  invariant(
    nsisBootstrapStep.test(workflow)
      && nsisBootstrapIndex >= 0 && baseCompileIndex > nsisBootstrapIndex
      && baseBundleIndex > baseCompileIndex
      && signedBundleIndex > baseBundleIndex
      && nsisBootstrapRuns.length === 1
      && (workflow.match(/\.\/scripts\/prepare-tauri-nsis\.ps1/g) || []).length === 1,
    'Signed updater smoke must prepare the verified NSIS cache once before both bundle operations',
  );
  invariant(!/github\.com\/[^\s]+\/releases\/download/i.test(workflow),
    'Signed updater smoke must not publish or consume a public application prerelease');
  invariant(!/(?:osg-updater-fixture\.pfx|TAURI_SIGNING_PRIVATE_KEY)[^\r\n]*runner\.temp.*upload/i.test(workflow),
    'Signed updater smoke must not upload its signing material or ephemeral certificate');
}

function assertUpdaterFixtureSource(rootDirectory) {
  const cargo = readText(rootDirectory, `${TAURI_DIRECTORY}/Cargo.toml`);
  const cargoLock = readText(rootDirectory, 'Cargo.lock');
  const build = readText(rootDirectory, `${TAURI_DIRECTORY}/build.rs`);
  const desktop = readText(rootDirectory, `${TAURI_DIRECTORY}/src/lib.rs`);
  const fixtureArguments = readText(
    rootDirectory,
    `${TAURI_DIRECTORY}/src/ci_updater_fixture.rs`,
  );
  const diagnostics = readText(rootDirectory, `${TAURI_DIRECTORY}/src/diagnostics.rs`);
  const updater = readText(rootDirectory, `${TAURI_DIRECTORY}/src/updater.rs`);
  const config = readJson(rootDirectory, TAURI_CONFIG_PATH);
  invariant(/^ci-updater-fixture\s*=\s*\[\]\s*$/m.test(cargo),
    'Desktop Cargo features must declare the isolated updater fixture');
  for (const fragment of [
    'CARGO_FEATURE_CI_UPDATER_FIXTURE',
    'GITHUB_ACTIONS',
    'OSG_ENABLE_SIGNED_UPDATER_FIXTURE',
    'PROFILE',
    'release',
  ]) {
    invariant(build.includes(fragment),
      `Updater fixture build scope is missing ${fragment}`);
  }
  invariant(updater.includes('#[cfg(feature = "ci-updater-fixture")]')
    && updater.includes('https://localhost:38443/latest.json')
    && updater.includes('.endpoints(vec![')
    && updater.includes('.configure_client(|client| client.danger_accept_invalid_certs(true))')
    && updater.includes('"app-update.check_started"')
    && updater.includes('"app-update.check_completed"')
    && updater.includes('"app-update.handoff"')
    && updater.includes('"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"'),
  'Updater fixture endpoint must remain compile-time isolated and exact');
  assertCiUpdaterFixtureDebugPortSource(desktop, fixtureArguments, cargoLock);
  assertCiUpdaterFixtureHandoffSource(updater);
  invariant(desktop.includes('app.run(|app, event| handle_application_run_event(app, &event))')
    && desktop.includes('"app.environment"')
    && desktop.includes('"app.page_load_finished"')
    && desktop.includes('"app.exit_requested"')
    && desktop.includes('"app.exit"')
    && desktop.includes('"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"'),
  'Desktop updater lifecycle diagnostics must distinguish inherited WebView debugging and native exit phases');
  invariant(diagnostics.includes('static APP_INSTANCE_ID: OnceLock<String>')
    && diagnostics.includes('Uuid::now_v7().to_string()')
    && diagnostics.includes('"appInstanceId"'),
  'Every desktop diagnostic record must carry one process-scoped UUIDv7 application identity');
  invariant(JSON.stringify(config.plugins?.updater?.endpoints) === JSON.stringify([
    'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/latest/download/latest.json',
  ]), 'Production updater endpoint must remain the official GitHub latest release');
}

function assertCiUpdaterFixtureHandoffSource(updater) {
  const handoffDebugState = /let webview_debug = std::env::var_os\("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"\)\r?\n\s*\.is_some_and\(\|value\| !value\.is_empty\(\)\);\r?\n\s*#\[cfg\(feature = "ci-updater-fixture"\)\]\r?\n\s*let webview_debug =\r?\n\s*webview_debug \|\| crate::ci_updater_fixture::configuration\(\)\.enables_webview_debugging\(\);/;
  const debugStateIndex = updater.search(handoffDebugState);
  const handoffIndex = updater.indexOf('"app-update.handoff"');
  invariant(
    debugStateIndex >= 0
      && handoffIndex > debugStateIndex
      && (updater.match(/crate::ci_updater_fixture::configuration\(\)\.enables_webview_debugging\(\)/g) || []).length === 1,
    'Updater fixture handoff must report the feature-gated configured debug state without changing ordinary production semantics',
  );
}

function assertCiUpdaterFixtureDebugPortSource(desktop, fixtureArguments, cargoLock) {
  invariant(
    typeof cargoLock === 'string',
    'Updater fixture debug-port defaults must be coupled to the locked Wry package',
  );
  const lockedWryPackages = cargoLock
    .split(/^\s*\[\[package]]\s*$/m)
    .slice(1)
    .filter((packageBlock) => /^\s*name\s*=\s*"wry"\s*$/m.test(packageBlock));
  const lockedWryPackage = lockedWryPackages[0] || '';
  invariant(
    lockedWryPackages.length === 1
      && new RegExp(`^\\s*version\\s*=\\s*"${escapeRegularExpression(CI_UPDATER_WRY_VERSION)}"\\s*$`, 'm')
        .test(lockedWryPackage)
      && /^\s*source\s*=\s*"registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"\s*$/m
        .test(lockedWryPackage)
      && new RegExp(`^\\s*checksum\\s*=\\s*"${CI_UPDATER_WRY_CHECKSUM}"\\s*$`, 'm')
        .test(lockedWryPackage),
    `Updater fixture debug-port defaults require the reviewed Wry ${CI_UPDATER_WRY_VERSION} registry package`,
  );
  const wryDefaultDeclaration =
    `const WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS: &str = "${CI_UPDATER_WRY_DEFAULT_BROWSER_ARGUMENTS}";`;
  invariant(
    /#\[cfg\(feature = "ci-updater-fixture"\)\]\r?\nmod ci_updater_fixture;/.test(desktop)
      && fixtureArguments.includes('#![cfg(feature = "ci-updater-fixture")]')
      && !desktop.includes('--osg-ci-updater-debug-port='),
    'Updater fixture debug-port parser must remain outside ordinary production compilation',
  );
  for (const fragment of [
    'const DEBUG_PORT_ARGUMENT_PREFIX: &str = "--osg-ci-updater-debug-port=";',
    'static CONFIGURATION: OnceLock<Configuration> = OnceLock::new();',
    'std::env::args_os().skip(1)',
    'if arguments.len() != 1',
    '.strip_prefix(DEBUG_PORT_ARGUMENT_PREFIX)',
    '!value.bytes().all(|byte| byte.is_ascii_digit())',
    "value.starts_with('0')",
    '.parse::<u16>()',
    'if debug_port < 1024',
    wryDefaultDeclaration,
    'format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --remote-debugging-port={port}")',
    'rejects_duplicate_unknown_malformed_privileged_and_out_of_range_arguments',
    'initialize_from_process_arguments()',
    'the CI updater fixture was initialized more than once',
  ]) {
    invariant(fixtureArguments.includes(fragment),
      `Updater fixture debug-port parser is missing fail-closed proof: ${fragment}`);
  }
  invariant(
    desktop.includes('ci_updater_fixture::initialize_from_process_arguments()')
      && desktop.indexOf('ci_updater_fixture::initialize_from_process_arguments()')
        < desktop.indexOf('let app = tauri::Builder::default()')
      && desktop.includes('ci_updater_fixture::configuration().enables_webview_debugging()')
      && /ci_updater_fixture::configuration\(\)\.browser_arguments\(\)/.test(desktop)
      && desktop.includes('window_builder.additional_browser_args(&arguments)'),
    'Updater fixture debug-port must be parsed before Tauri setup and applied before WebView creation',
  );
  invariant(
    !fixtureArguments.includes('RemoveRedirectionBitmap')
      && fixtureArguments.split(wryDefaultDeclaration).length === 2,
    'Updater fixture debug-port arguments must match the locked Wry defaults exactly',
  );
}

function assertSignedUpdaterScript(script) {
  const requiredFragments = [
    "$env:GITHUB_ACTIONS -ne 'true'",
    "$env:OSG_ENABLE_SIGNED_UPDATER_FIXTURE -ne '1'",
    'CertificateRequest]::new(',
    '$certificateRequest.CreateSelfSigned(',
    'X509ContentType]::Pfx',
    "@($resultPath, ($fixture.TrimEnd('\\') + '\\'))",
    'scripts/serve-updater-fixture.mjs',
    '-WindowStyle Hidden',
    "signed-updater.phase name=$Name elapsedMs=$elapsedMilliseconds",
    'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    'Get-CiUpdaterDebugArgument',
    '"--osg-ci-updater-debug-port=$Port"',
    '-ArgumentList @($debugArgument)',
    '-ArgumentList @($verificationDebugArgument)',
    "-Mode 'trigger'",
    "-Mode 'verify'",
    '$exitDeadline = (Get-Date).AddMinutes(5)',
    'Get-UpdaterFailurePhase',
    "'app-update.download_failed' = @('transport-or-signature')",
    "'app-update.install_failed' = @('extract-or-launch')",
    "'app-update.cancel_requested' = @('user', 'protocol')",
    '$diagnosticEvidence',
    '$diagnosticEvidenceByteLimit = 128 * 1024',
    'ConvertTo-BoundedDiagnosticEvidenceRecord',
    'Write-BoundedDiagnosticEvidence',
    'Invoke-UpdaterFinalizationStep',
    '$primaryFailure = $null',
    '$finalizationFailure = $null',
    'signed-updater.finalization-warning step=$Name',
    'signed-updater.identity phase=$Phase webviewDebug=present',
    '$updatedRegistry.DisplayVersion -ne $UpdatedVersion',
    "'updated-application-relaunched'",
    'Wait-ForApplicationInstance',
    'Wait-ForReadyApplicationWindow',
    '-AppInstanceId $updatedInstanceId',
    "'updated-application-ready'",
    "-EvidenceName 'relaunch-verify'",
    'Wait-ForSettledUpdaterChecks',
    '-MinimumChecks 2',
    "'updated-frontend-ready'",
    '$updatedClose = Stop-Gracefully',
    "-Phase 'updater-relaunched'",
    'Get-BoundedProcessTreeSnapshot',
    'Get-BoundedEvidenceDelta',
    'Write-CloseEvidence',
    '$closeEvidencePath',
    '$closeEvidenceTemporaryPath',
    'Write-CloseEvidenceDocument',
    'schemaVersion = 1',
    'appInstanceId = $AppInstanceId',
    'mainWindowStable = $MainWindowStable',
    'diagnosticDeltasUnclamped = $diagnosticDeltasUnclamped',
    'diagnosticLifecycleExact = $diagnosticLifecycleExact',
    'cleanExit = $CleanExit',
    'Signed updater temporary path was not clean',
    '[IO.File]::Move(',
    "'app.environment'",
    "'app.exit_requested'",
    "'app.exit'",
    "'osg.previous.log'",
    "Get-CimInstance Win32_Process -OperationTimeoutSec 3",
    '$verificationPort = Get-FreeLoopbackPort',
    "'verification-application-launched'",
    "'app-update.checking'",
    "'app-update.installing'",
    '$updateRequests.Count -ne 1',
    'closeProof = [ordered]@{',
    'relaunchFrontend = $relaunchFrontend',
    'preservedSettingsProjectAndHistory = $true',
    'signedNsisRelaunch = $true',
  ];
  for (const fragment of requiredFragments) {
    invariant(script.includes(fragment),
      `Signed updater runner is missing lifecycle proof: ${fragment}`);
  }
  invariant(/foreach\s*\(\$path\s+in\s+@\([\s\S]*?\$closeEvidencePath,[\s\S]*?\$closeEvidenceTemporaryPath[\s\S]*?\)\)\s*\{\s*if\s*\(Test-Path\s+-LiteralPath\s+\$path\)\s*\{\s*throw/.test(script),
    'Signed updater runner must require clean close-evidence paths before writing bounded diagnostics');
  invariant(/\$closeEvidence\s*=\s*\[ordered\]@\{\s*schemaVersion\s*=\s*1\s*updaterRelaunch\s*=\s*\$null\s*verification\s*=\s*\$null\s*\}/.test(script),
    'Signed updater runner must retain exactly two close-evidence phase slots');
  const debugArgumentFunctionStart = script.indexOf('function Get-CiUpdaterDebugArgument {');
  const debugArgumentFunctionEnd = script.indexOf('\nfunction ', debugArgumentFunctionStart + 1);
  const debugArgumentFunction = debugArgumentFunctionStart >= 0
    && debugArgumentFunctionEnd > debugArgumentFunctionStart
    ? script.slice(debugArgumentFunctionStart, debugArgumentFunctionEnd)
    : '';
  invariant(
    debugArgumentFunction.includes('$Port -lt 1024 -or $Port -gt 65535')
      && debugArgumentFunction.includes('"--osg-ci-updater-debug-port=$Port"')
      && !/(?:Invoke-|Start-|&\s)/.test(debugArgumentFunction),
    'Signed updater runner must construct only one bounded CI debug-port argument',
  );
  invariant(
    /\$debugArgument\s*=\s*Get-CiUpdaterDebugArgument\s+-Port\s+\$debugPort[\s\S]*?Start-Process\s+`[\s\S]*?-ArgumentList\s+@\(\$debugArgument\)/.test(script)
      && /\$verificationDebugArgument\s*=\s*Get-CiUpdaterDebugArgument\s+-Port\s+\$verificationPort[\s\S]*?Start-Process\s+`[\s\S]*?-ArgumentList\s+@\(\$verificationDebugArgument\)/.test(script)
      && !/\$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS\s*=/.test(script),
    'Signed updater runner must launch base and verification apps with only the preserved CI debug-port argument',
  );
  const diagnosticReaderStart = script.indexOf('function Read-DiagnosticEvents {');
  const diagnosticReaderEnd = script.indexOf('\nfunction ', diagnosticReaderStart + 1);
  const diagnosticReader = diagnosticReaderStart >= 0 && diagnosticReaderEnd > diagnosticReaderStart
    ? script.slice(diagnosticReaderStart, diagnosticReaderEnd)
    : '';
  invariant(
    diagnosticReader.includes("'osg.previous.log'")
      && diagnosticReader.includes('$diagnosticLog')
      && diagnosticReader.includes('(8 * 1024 * 1024)')
      && !diagnosticReader.includes('-Tail'),
    'Signed updater runner must read both bounded rotating diagnostic files without tail-count baselines',
  );
  const instanceFunctionStart = script.indexOf('function Wait-ForApplicationInstance {');
  const instanceFunctionEnd = script.indexOf('\nfunction ', instanceFunctionStart + 1);
  const instanceFunction = instanceFunctionStart >= 0 && instanceFunctionEnd > instanceFunctionStart
    ? script.slice(instanceFunctionStart, instanceFunctionEnd)
    : '';
  invariant(
    instanceFunction.includes("$_.event -eq 'app.environment'")
      && instanceFunction.includes('$_.version -ceq $ExpectedVersion')
      && instanceFunction.includes("[string]$_.webviewDebug -ceq 'present'")
      && instanceFunction.includes('[string]$_.appInstanceId -notin $ExcludedInstanceIds')
      && instanceFunction.includes('$candidateInstanceIds.Count -gt 1')
      && instanceFunction.includes('$candidateInstanceIds.Count -eq 1')
      && instanceFunction.includes('Sort-Object -Unique')
      && instanceFunction.includes('webviewDebug=present')
      && !instanceFunction.includes("[string]$_.webviewDebug -in @('present', 'absent')"),
    'Signed updater runner must bind one new versioned UUIDv7 identity that confirms the preserved CI debug-port hook',
  );
  const evidenceRecordStart = script.indexOf('function ConvertTo-BoundedDiagnosticEvidenceRecord {');
  const evidenceRecordEnd = script.indexOf('\nfunction ', evidenceRecordStart + 1);
  const evidenceRecordFunction = evidenceRecordStart >= 0 && evidenceRecordEnd > evidenceRecordStart
    ? script.slice(evidenceRecordStart, evidenceRecordEnd)
    : '';
  const evidenceWriterStart = script.indexOf('function Write-BoundedDiagnosticEvidence {');
  const evidenceWriterEnd = script.indexOf('\nfunction ', evidenceWriterStart + 1);
  const evidenceWriterFunction = evidenceWriterStart >= 0 && evidenceWriterEnd > evidenceWriterStart
    ? script.slice(evidenceWriterStart, evidenceWriterEnd)
    : '';
  invariant(
    evidenceRecordFunction.includes("webviewDebug = if ([string]$Entry.event -notin @('app.environment', 'app-update.handoff'))")
      && evidenceRecordFunction.includes("$webviewDebug -in @('present', 'absent')")
      && evidenceRecordFunction.includes("'unknown'")
      && evidenceRecordFunction.includes("$version -match '^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$'")
      && evidenceRecordFunction.includes("appInstanceId = if ([string]$Entry.appInstanceId -match")
      && evidenceRecordFunction.includes('[pscustomobject][ordered]@{')
      && !evidenceRecordFunction.includes('$Entry | ConvertTo-Json'),
    'Signed updater runner must redact unknown diagnostic fields into a fixed evidence schema',
  );
  invariant(
    evidenceWriterFunction.includes('Read-DiagnosticEvents -IncludePrevious')
      && evidenceWriterFunction.includes("'app.environment'")
      && evidenceWriterFunction.includes('Select-Object -Last 256')
      && evidenceWriterFunction.includes('ConvertTo-BoundedDiagnosticEvidenceRecord -Entry $_')
      && evidenceWriterFunction.includes('[Text.Encoding]::UTF8.GetByteCount($encoded)')
      && evidenceWriterFunction.includes('$script:diagnosticEvidenceByteLimit')
      && evidenceWriterFunction.includes('[IO.File]::WriteAllText(')
      && !evidenceWriterFunction.includes('$ExpectedVersion')
      && !evidenceWriterFunction.includes('$evidenceInstanceIds')
      && !evidenceWriterFunction.includes('$_.version')
      && !evidenceWriterFunction.includes('$_.appInstanceId')
      && !evidenceWriterFunction.includes('$_ | ConvertTo-Json'),
    'Signed updater runner must retain bounded sanitized lifecycle evidence, including unknown relaunch candidates',
  );
  const finalizerStart = script.lastIndexOf('} finally {');
  const finalizer = finalizerStart >= 0 ? script.slice(finalizerStart) : '';
  const finalizationStepStart = script.indexOf('function Invoke-UpdaterFinalizationStep {');
  const finalizationStepEnd = script.indexOf('\nfunction ', finalizationStepStart + 1);
  const finalizationStep = finalizationStepStart >= 0 && finalizationStepEnd > finalizationStepStart
    ? script.slice(finalizationStepStart, finalizationStepEnd)
    : '';
  invariant(
    finalizer.includes('if (Test-Path -LiteralPath $diagnosticLog -PathType Leaf)')
      && finalizer.includes('Write-BoundedDiagnosticEvidence')
      && !finalizer.includes('$_ | ConvertTo-Json'),
    'Signed updater runner must write sanitized diagnostic evidence on success and failure',
  );
  invariant(
    finalizationStep.includes('try {')
      && finalizationStep.includes('& $Action')
      && finalizationStep.includes('} catch {')
      && finalizationStep.includes('if ($null -eq $script:finalizationFailure)')
      && finalizationStep.includes('$script:finalizationFailure = $_')
      && finalizationStep.includes('signed-updater.finalization-warning step=$Name')
      && finalizationStep.includes('-ErrorAction SilentlyContinue')
      && !finalizationStep.includes('throw'),
    'Signed updater runner must capture every finalization error without throwing from cleanup',
  );
  const outerCatchIndex = script.lastIndexOf('} catch {', finalizerStart);
  const outerCatch = outerCatchIndex >= 0
    ? script.slice(outerCatchIndex, finalizerStart + '} finally {'.length)
    : '';
  const primaryRethrowIndex = script.indexOf('if ($null -ne $primaryFailure)', finalizerStart);
  const finalizationRethrowIndex = script.indexOf(
    'if ($null -ne $finalizationFailure)',
    primaryRethrowIndex,
  );
  const requiredFinalizationSteps = [
    'diagnostic-evidence',
    'fixture-password',
    'updated-process',
    'verification-process',
    'base-process',
    'fixture-server',
    'certificate',
    'certificate-key',
  ];
  invariant(
    /}\s*catch\s*\{\s*\$primaryFailure\s*=\s*\$_\s*}\s*finally\s*\{/.test(outerCatch)
      && requiredFinalizationSteps.every((name) => (
        finalizer.includes(`Invoke-UpdaterFinalizationStep -Name '${name}' -Action {`)
      ))
      && primaryRethrowIndex > finalizerStart
      && finalizationRethrowIndex > primaryRethrowIndex
      && /if\s*\(\$null\s+-ne\s+\$primaryFailure\)\s*\{\s*throw\s+\$primaryFailure\s*}/
        .test(script.slice(primaryRethrowIndex, finalizationRethrowIndex))
      && /if\s*\(\$null\s+-ne\s+\$finalizationFailure\)\s*\{\s*throw\s+\$finalizationFailure\s*}/
        .test(script.slice(finalizationRethrowIndex))
      && finalizer.slice(0, primaryRethrowIndex - finalizerStart)
        .includes("Invoke-UpdaterFinalizationStep -Name 'diagnostic-evidence' -Action {")
      && !finalizer.slice(0, primaryRethrowIndex - finalizerStart)
        .includes('\n    throw '),
    'Signed updater runner must finish every guarded cleanup step and rethrow the primary failure before any finalization failure',
  );
  const settledFunctionStart = script.indexOf('function Wait-ForSettledUpdaterChecks {');
  const settledFunctionEnd = script.indexOf('\nfunction ', settledFunctionStart + 1);
  const settledFunction = settledFunctionStart >= 0 && settledFunctionEnd > settledFunctionStart
    ? script.slice(settledFunctionStart, settledFunctionEnd)
    : '';
  invariant(
    settledFunction.includes("-Name 'app-update.check_started'")
      && settledFunction.includes("-Name 'app-update.check_completed'")
      && settledFunction.includes('$_.version -ne $ExpectedVersion')
      && settledFunction.includes("$_.outcome -ne 'current'")
      && settledFunction.includes('$started.Count -ge $MinimumChecks')
      && settledFunction.includes('$completed.Count -eq $started.Count'),
    'Signed updater runner must prove startup and inspection update checks both completed on the exact app instance',
  );
  const readyFunctionStart = script.indexOf('function Wait-ForReadyApplicationWindow {');
  const readyFunctionEnd = script.indexOf('\nfunction ', readyFunctionStart + 1);
  const readyFunction = readyFunctionStart >= 0 && readyFunctionEnd > readyFunctionStart
    ? script.slice(readyFunctionStart, readyFunctionEnd)
    : '';
  invariant(
    /\$deadline\s*=\s*\(Get-Date\)\.AddMinutes\(2\)/.test(readyFunction)
      && /\$Process\.Refresh\(\)[\s\S]*?if\s*\(\$Process\.HasExited\)/.test(readyFunction)
      && /\$Process\.MainWindowHandle\s+-ne\s+\[IntPtr\]::Zero\s+-and\s+\$Process\.Responding/.test(readyFunction)
      && /\$inputIdle\s*=\s*\$Process\.WaitForInputIdle\(1000\)/.test(readyFunction)
      && /\$pageLoadEvents\s*=\s*Get-DiagnosticEventCount\s+-AppInstanceId\s+\$AppInstanceId\s+-Name\s+'app\.page_load_finished'/.test(readyFunction)
      && /if\s*\(\$readyEvents\s+-eq\s+1\s+`\s*-and\s+\$pageLoadEvents\s+-ge\s+1\s+`\s*-and\s+\$inputIdle\)\s*\{\s*return\s*\}/.test(readyFunction)
      && /while\s*\(\(Get-Date\)\s+-lt\s+\$deadline\)/.test(readyFunction),
    'Signed updater runner must wait for the selected process, diagnostic readiness, and a responsive idle window',
  );
  const gracefulFunctionStart = script.indexOf('function Stop-Gracefully {');
  const gracefulFunctionEnd = script.indexOf('\nfunction ', gracefulFunctionStart + 1);
  const gracefulFunction = gracefulFunctionStart >= 0 && gracefulFunctionEnd > gracefulFunctionStart
    ? script.slice(gracefulFunctionStart, gracefulFunctionEnd)
    : '';
  invariant(
    /\$Process\.Refresh\(\)/.test(gracefulFunction)
      && /if\s*\(\$Process\.HasExited\)\s*\{\s*throw/.test(gracefulFunction)
      && /\$Process\.MainWindowHandle\s+-eq\s+\[IntPtr\]::Zero\s+-or\s+-not\s+\$Process\.Responding/.test(gracefulFunction)
      && /\$closeEventsBefore\s*=\s*Get-DiagnosticEventCount\s+-AppInstanceId\s+\$AppInstanceId\s+-Name\s+'app\.close_requested'/.test(gracefulFunction)
      && /\$exitRequestedEventsBefore\s*=\s*Get-DiagnosticEventCount\s+-AppInstanceId\s+\$AppInstanceId\s+-Name\s+'app\.exit_requested'/.test(gracefulFunction)
      && /\$exitEventsBefore\s*=\s*Get-DiagnosticEventCount\s+-AppInstanceId\s+\$AppInstanceId\s+-Name\s+'app\.exit'/.test(gracefulFunction)
      && /\$closeAccepted\s*=\s*\$Process\.CloseMainWindow\(\)/.test(gracefulFunction)
      && /if\s*\(-not\s+\$closeAccepted\)\s*\{/.test(gracefulFunction)
      && /-Outcome\s+'request-rejected'/.test(gracefulFunction)
      && /if\s*\(-not\s+\$Process\.WaitForExit\(30000\)\)\s*\{/.test(gracefulFunction)
      && /-Outcome\s+'exit-timeout'/.test(gracefulFunction)
      && /\$cleanExit\s*=\s*\$Process\.ExitCode\s+-eq\s+0/.test(gracefulFunction)
      && /if\s*\(-not\s+\$cleanExit\)\s*\{\s*throw/.test(gracefulFunction)
      && /\$closeEventsAfter\s+-ne\s+\(\$closeEventsBefore\s+\+\s+1\)/.test(gracefulFunction)
      && /\$exitRequestedEventsAfter\s+-ne\s+\(\$exitRequestedEventsBefore\s+\+\s+1\)/.test(gracefulFunction)
      && /\$exitEventsAfter\s+-ne\s+\(\$exitEventsBefore\s+\+\s+1\)/.test(gracefulFunction)
      && /\$closeRecord\s*=\s*Write-CloseEvidence[\s\S]*?-Outcome\s+'exited'[\s\S]*?-CleanExit\s+\$cleanExit/.test(gracefulFunction)
      && /-AppInstanceId\s+\$AppInstanceId/.test(gracefulFunction)
      && /-Outcome\s+'exited'/.test(gracefulFunction)
      && !/-not\s+\$Process\.CloseMainWindow\(\)\s+-or\s+-not\s+\$Process\.WaitForExit\(30000\)/.test(script),
    'Signed updater runner must separate native close acceptance from the 30-second exit and diagnostic lifecycle proof',
  );
  const closeRequestIndex = gracefulFunction.indexOf('$closeAccepted = $Process.CloseMainWindow()');
  const closeRejectedIndex = gracefulFunction.indexOf('if (-not $closeAccepted)', closeRequestIndex);
  const closeTimeoutIndex = gracefulFunction.indexOf('if (-not $Process.WaitForExit(30000))', closeRejectedIndex);
  const firstProcessTreeIndex = gracefulFunction.indexOf(
    '$processTree = Get-BoundedProcessTreeSnapshot -Process $Process',
  );
  const firstFailureEvidenceIndex = gracefulFunction.indexOf('Write-CloseEvidence `', closeRejectedIndex);
  invariant(
    closeRequestIndex >= 0
      && closeRequestIndex < closeRejectedIndex
      && closeRejectedIndex < closeTimeoutIndex
      && firstFailureEvidenceIndex > closeRejectedIndex
      && firstFailureEvidenceIndex < firstProcessTreeIndex,
    'Signed updater runner must persist core close rejection before waiting for exit or scanning descendants',
  );
  const exitedRecordIndex = gracefulFunction.indexOf('$closeRecord = Write-CloseEvidence');
  const cleanExitAssertionIndex = gracefulFunction.indexOf('if (-not $cleanExit)', exitedRecordIndex);
  const closeDeltaAssertionIndex = gracefulFunction.indexOf(
    'if ($closeEventsAfter -ne ($closeEventsBefore + 1))',
    exitedRecordIndex,
  );
  const exitDeltaAssertionIndex = gracefulFunction.indexOf(
    'if ($exitRequestedEventsAfter -ne ($exitRequestedEventsBefore + 1)',
    exitedRecordIndex,
  );
  invariant(
    exitedRecordIndex >= 0
      && exitedRecordIndex < cleanExitAssertionIndex
      && exitedRecordIndex < closeDeltaAssertionIndex
      && exitedRecordIndex < exitDeltaAssertionIndex,
    'Signed updater runner must persist bounded exited evidence before enforcing exit-code and diagnostic deltas',
  );
  const updatedCandidateIndex = script.indexOf('$updatedCandidates = @(Get-Process');
  const updatedExactProcessIndex = script.indexOf(
    '$updatedProcessPath = [IO.Path]::GetFullPath($updatedProcess.Path)',
    updatedCandidateIndex,
  );
  const relaunchedIndex = script.indexOf(
    "Write-SmokePhase -Name 'updated-application-relaunched'",
    updatedExactProcessIndex,
  );
  const instanceWaitIndex = script.indexOf('$updatedInstanceId = Wait-ForApplicationInstance', relaunchedIndex);
  const readyWaitIndex = script.indexOf('Wait-ForReadyApplicationWindow `', instanceWaitIndex);
  const readyPhaseIndex = script.indexOf("Write-SmokePhase -Name 'updated-application-ready'", readyWaitIndex);
  const frontendInspectionIndex = script.indexOf('$relaunchFrontend = Invoke-UpdaterInspection', readyPhaseIndex);
  const settledCheckIndex = script.indexOf('Wait-ForSettledUpdaterChecks `', frontendInspectionIndex);
  const frontendReadyIndex = script.indexOf("Write-SmokePhase -Name 'updated-frontend-ready'", settledCheckIndex);
  const gracefulCloseIndex = script.indexOf('$updatedClose = Stop-Gracefully', frontendReadyIndex);
  const verificationLaunchIndex = script.indexOf('$verificationPort = Get-FreeLoopbackPort', gracefulCloseIndex);
  const readyInvocation = readyWaitIndex >= 0 && readyPhaseIndex > readyWaitIndex
    ? script.slice(readyWaitIndex, readyPhaseIndex)
    : '';
  const exactProcessInvocation = updatedExactProcessIndex >= 0 && relaunchedIndex > updatedExactProcessIndex
    ? script.slice(updatedExactProcessIndex, relaunchedIndex)
    : '';
  invariant(
    updatedCandidateIndex >= 0
      && script.slice(updatedCandidateIndex, updatedExactProcessIndex).includes('$updatedCandidates.Count -eq 1')
      && script.slice(updatedCandidateIndex, updatedExactProcessIndex).includes('$updatedCandidates.Count -gt 1')
      && updatedExactProcessIndex > updatedCandidateIndex
      && exactProcessInvocation.includes('$updatedProcessPath.Equals($executable, [StringComparison]::OrdinalIgnoreCase)')
      && exactProcessInvocation.includes("throw 'Signed NSIS updater relaunched an unexpected executable'")
      && relaunchedIndex > updatedExactProcessIndex
      && relaunchedIndex < instanceWaitIndex
      && instanceWaitIndex < readyWaitIndex
      && readyWaitIndex < readyPhaseIndex
      && readyPhaseIndex < frontendInspectionIndex
      && frontendInspectionIndex < settledCheckIndex
      && settledCheckIndex < frontendReadyIndex
      && frontendReadyIndex < gracefulCloseIndex
      && gracefulCloseIndex < verificationLaunchIndex
      && readyInvocation.includes('-Process $updatedProcess')
      && readyInvocation.includes('-AppInstanceId $updatedInstanceId')
      && script.slice(settledCheckIndex, frontendReadyIndex).includes('-MinimumChecks 2')
      && script.slice(settledCheckIndex, frontendReadyIndex).includes('-AppInstanceId $updatedInstanceId'),
    'Signed updater runner must bind the exact installed executable path, native window, and exact frontend before closing the relaunch or starting verification',
  );
  invariant(!/Cert:\\LocalMachine/i.test(script),
    'Signed updater runner must not modify the machine certificate store');
  invariant(!/(?:X509Store|Cert:\\|Invoke-WebRequest|Invoke-RestMethod)/i.test(script),
    'Signed updater runner must not mutate trust stores or bypass the real updater client');
}

function assertWorkflow(rootDirectory = REPOSITORY_ROOT) {
  const workflow = readText(rootDirectory, WORKFLOW_PATH);
  assertPinnedActions(workflow);
  assertWorkflowMatrix(workflow);
  assertWorkflowCommands(workflow);
  assertTauriNsisBootstrapScript(readText(rootDirectory, TAURI_NSIS_BOOTSTRAP_PATH));
  const signedUpdaterWrapper = workflowJobBlock(workflow, 'signed-updater-smoke');
  invariant(!workflow.replace(signedUpdaterWrapper, '').includes('ci-updater-fixture')
    && !/\$\{\{\s*secrets\./i.test(workflow.replace(signedUpdaterWrapper, '')),
  'Ordinary rewrite CI jobs must remain unsigned and updater-fixture-free');
  assertInstalledSmokeScript(readText(rootDirectory, 'scripts/test-installed-windows.ps1'));
  assertUpdaterSmokeWorkflow(readText(rootDirectory, UPDATER_SMOKE_WORKFLOW_PATH));
  assertUpdaterFixtureSource(rootDirectory);
  assertSignedUpdaterScript(readText(rootDirectory, 'scripts/test-signed-updater-windows.ps1'));
}

function normalizeDestination(destination) {
  invariant(typeof destination === 'string' && destination.length > 0, 'Resource destinations must be non-empty strings');
  const normalized = destination.replaceAll('\\', '/').replace(/^\.\//, '');
  invariant(!path.posix.isAbsolute(normalized), `Resource destination must be relative: ${destination}`);
  const components = normalized.split('/');
  invariant(
    components.every((component) => component && component !== '.' && component !== '..'),
    `Resource destination may not escape or contain empty components: ${destination}`,
  );
  return normalized;
}

function platformConfigName(target) {
  if (!target) {
    return undefined;
  }
  const entry = TARGETS[target];
  invariant(entry, `Unsupported release target ${JSON.stringify(target)}`);
  if (target.endsWith('windows-msvc')) {
    return 'tauri.windows.conf.json';
  }
  if (target.endsWith('apple-darwin')) {
    return 'tauri.macos.conf.json';
  }
  return 'tauri.linux.conf.json';
}

function collectResourceMappings(rootDirectory = REPOSITORY_ROOT, target) {
  const configDirectory = path.join(rootDirectory, TAURI_DIRECTORY);
  const baseConfig = readJson(rootDirectory, TAURI_CONFIG_PATH);
  const resourceObjects = [baseConfig.bundle && baseConfig.bundle.resources];
  const platformConfig = platformConfigName(target);
  if (platformConfig && fs.existsSync(path.join(configDirectory, platformConfig))) {
    const config = readJson(rootDirectory, `${TAURI_DIRECTORY}/${platformConfig}`);
    resourceObjects.push(config.bundle && config.bundle.resources);
  }

  const byDestination = new Map();
  for (const resources of resourceObjects) {
    if (resources === undefined) {
      continue;
    }
    invariant(
      resources && typeof resources === 'object' && !Array.isArray(resources),
      'Tauri bundle.resources must be an object mapping source files to stable destinations',
    );
    for (const [source, rawDestination] of Object.entries(resources)) {
      const destination = normalizeDestination(rawDestination);
      invariant(!byDestination.has(destination), `Duplicate Tauri resource destination: ${destination}`);
      const sourceAbsolute = path.resolve(configDirectory, source);
      const relativeSource = path.relative(rootDirectory, sourceAbsolute);
      invariant(
        relativeSource && !relativeSource.startsWith('..') && !path.isAbsolute(relativeSource),
        `Tauri resource source must stay inside the repository: ${source}`,
      );
      invariant(fs.existsSync(sourceAbsolute), `Tauri resource source does not exist: ${source}`);
      const sourceMetadata = fs.lstatSync(sourceAbsolute);
      invariant(!sourceMetadata.isSymbolicLink(), `Tauri resource source may not be a symlink: ${source}`);
      invariant(sourceMetadata.isFile(), `Tauri resource source must be a file: ${source}`);
      invariant(sourceMetadata.size > 0, `Tauri resource source is empty: ${source}`);
      byDestination.set(destination, {
        destination,
        source,
        sourceAbsolute,
        size: sourceMetadata.size,
      });
    }
  }
  return [...byDestination.values()];
}

function collectEmbeddedWorkers(rootDirectory = REPOSITORY_ROOT) {
  const sourceDirectory = path.join(rootDirectory, TAURI_DIRECTORY, 'src');
  const rustSources = walkFiles(sourceDirectory, (candidate) => candidate.endsWith('.rs'));
  const workers = [];
  for (const rustSource of rustSources) {
    const source = fs.readFileSync(rustSource, 'utf8');
    for (const match of source.matchAll(/include_bytes!\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!/_worker\.(?:py|mjs)$/i.test(match[1])) {
        continue;
      }
      const workerPath = path.resolve(path.dirname(rustSource), match[1]);
      invariant(fs.existsSync(workerPath), `Embedded worker source does not exist: ${match[1]}`);
      workers.push({
        name: path.basename(workerPath),
        sourceAbsolute: workerPath,
        rustSource: path.relative(rootDirectory, rustSource).replaceAll('\\', '/'),
      });
    }
  }
  return workers;
}

function assertWorkerResources(rootDirectory = REPOSITORY_ROOT, mappings = collectResourceMappings(rootDirectory)) {
  const attributesPath = path.join(rootDirectory, '.gitattributes');
  invariant(fs.existsSync(attributesPath), 'Packaged worker checkout rules require .gitattributes');
  const attributes = fs.readFileSync(attributesPath, 'utf8');
  for (const rule of ['*.mjs text eol=lf', '*.py text eol=lf']) {
    invariant(
      attributes.split(/\r?\n/).includes(rule),
      `Packaged worker checkout rules must include ${rule}`,
    );
  }
  const workers = collectEmbeddedWorkers(rootDirectory);
  const expectedWorkers = new Set([
    'osg_asr_worker.py',
    'osg_speech_worker.py',
    'osg_render_worker.mjs',
  ]);
  const discoveredWorkers = new Set(workers.map((worker) => worker.name));
  for (const expectedWorker of expectedWorkers) {
    invariant(discoveredWorkers.has(expectedWorker), `Desktop bootstrap must embed ${expectedWorker}`);
  }

  for (const worker of workers) {
    const mapping = mappings.find(
      (candidate) => path.resolve(candidate.sourceAbsolute) === path.resolve(worker.sourceAbsolute),
    );
    invariant(
      mapping,
      `${worker.rustSource} embeds ${worker.name}, but Tauri bundle.resources does not package the same file`,
    );
    invariant(
      mapping.destination === `workers/${worker.name}`,
      `${worker.name} must be packaged at workers/${worker.name}, received ${mapping.destination}`,
    );
  }
}

function assertProductionCsp(config) {
  const csp = config && config.app && config.app.security && config.app.security.csp;
  const connectSource = csp && csp['connect-src'];
  invariant(typeof connectSource === 'string', 'Tauri production CSP must declare connect-src as a string');
  const directives = connectSource.trim().split(/\s+/).filter(Boolean);
  invariant(directives.includes("'self'"), "Production connect-src must retain 'self'");
  invariant(directives.includes('ipc:'), 'Production connect-src must retain ipc:');
  const allowed = new Set(["'self'", 'ipc:', 'http://ipc.localhost', 'https://ipc.localhost']);
  const forbidden = directives.filter((directive) => !allowed.has(directive));
  invariant(
    forbidden.length === 0,
    `Production connect-src may contain only self/Tauri IPC endpoints; remove: ${forbidden.join(', ')}`,
  );
  const imageSource = csp && csp['img-src'];
  invariant(typeof imageSource === 'string', 'Tauri production CSP must declare img-src as a string');
  const imageDirectives = imageSource.trim().split(/\s+/).filter(Boolean);
  const allowedImages = new Set(["'self'", 'data:', 'blob:', 'http://127.0.0.1:*']);
  const forbiddenImages = imageDirectives.filter((directive) => !allowedImages.has(directive));
  invariant(
    imageDirectives.includes('http://127.0.0.1:*') && forbiddenImages.length === 0,
    `Production img-src may contain only local assets and tokenized loopback images; remove: ${forbiddenImages.join(', ')}`,
  );
}

function decodeUpdaterPublicKey(value) {
  invariant(
    typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    'Updater public key must be canonical base64 from the Tauri signer',
  );
  const decoded = Buffer.from(value, 'base64');
  invariant(
    decoded.length > 0 && decoded.toString('base64') === value,
    'Updater public key must be canonical base64 from the Tauri signer',
  );
  const minisign = decoded.toString('utf8');
  invariant(
    !minisign.includes('\uFFFD'),
    'Updater public key must decode to a UTF-8 minisign public key',
  );
  const lines = minisign.trim().split(/\r?\n/);
  invariant(
    lines.length === 2 && /^untrusted comment: .*minisign public key/i.test(lines[0]),
    'Updater public key must decode to the two-line minisign public-key format',
  );
  invariant(
    /^[A-Za-z0-9+/]{56}$/.test(lines[1]),
    'Updater public key must contain one exact minisign key line',
  );
  const keyBytes = Buffer.from(lines[1], 'base64');
  invariant(
    keyBytes.length === 42 && keyBytes[0] === 0x45 && keyBytes[1] === 0x64,
    'Updater public key must contain a valid Ed25519 minisign key envelope',
  );
  invariant(
    new Set(keyBytes.subarray(2)).size > 1,
    'Updater public key may not contain placeholder key material',
  );
  return value;
}

function assertNoGuestUpdaterPermissions(rootDirectory) {
  const capabilityDirectory = path.join(rootDirectory, TAURI_DIRECTORY, 'capabilities');
  const capabilityFiles = walkFiles(
    capabilityDirectory,
    (candidate) => candidate.endsWith('.json'),
  );
  invariant(capabilityFiles.length > 0, 'Tauri must declare at least one capability file');
  for (const capabilityFile of capabilityFiles) {
    const relativePath = path.relative(rootDirectory, capabilityFile).replaceAll('\\', '/');
    const capability = readJson(rootDirectory, relativePath);
    const permissions = capability && capability.permissions;
    invariant(Array.isArray(permissions), `${relativePath} must declare a permissions array`);
    const guestUpdaterPermissions = permissions.filter(
      (permission) => typeof permission === 'string' && /^updater(?::|$)/i.test(permission),
    );
    invariant(
      guestUpdaterPermissions.length === 0,
      `${relativePath} must not grant updater guest permissions: ${guestUpdaterPermissions.join(', ')}`,
    );
  }
}

function assertUpdaterReleaseConfiguration(rootDirectory = REPOSITORY_ROOT) {
  const config = readJson(rootDirectory, TAURI_CONFIG_PATH);
  invariant(
    config.bundle && config.bundle.createUpdaterArtifacts === true,
    'Tauri bundle.createUpdaterArtifacts must be true for signed v2 updater artifacts',
  );
  const updater = config.plugins && config.plugins.updater;
  invariant(updater && typeof updater === 'object' && !Array.isArray(updater),
    'Tauri must configure the signed updater plugin');
  invariant(
    updater.dangerousInsecureTransportProtocol !== true,
    'Tauri updater must never allow insecure transport in release packages',
  );
  invariant(
    Array.isArray(updater.endpoints) && updater.endpoints.length > 0,
    'Tauri updater must declare at least one HTTPS latest.json endpoint',
  );
  const endpoints = new Set();
  for (const rawEndpoint of updater.endpoints) {
    invariant(typeof rawEndpoint === 'string' && rawEndpoint.length <= 2_048,
      'Tauri updater endpoints must be bounded URL strings');
    invariant(!endpoints.has(rawEndpoint), `Tauri updater repeats endpoint ${rawEndpoint}`);
    endpoints.add(rawEndpoint);
    const substituted = rawEndpoint.replace(
      /\{\{(?:current_version|target|arch)}}/g,
      'release-value',
    );
    invariant(!substituted.includes('{{'), `Tauri updater endpoint has an unsupported variable: ${rawEndpoint}`);
    let endpoint;
    try {
      endpoint = new URL(substituted);
    } catch {
      throw new Error(`Tauri updater endpoint is invalid: ${rawEndpoint}`);
    }
    invariant(endpoint.protocol === 'https:', `Tauri updater endpoint must use HTTPS: ${rawEndpoint}`);
    invariant(!endpoint.username && !endpoint.password,
      `Tauri updater endpoint may not contain credentials: ${rawEndpoint}`);
    invariant(!endpoint.search && !endpoint.hash,
      `Tauri updater endpoint may not contain a query or fragment: ${rawEndpoint}`);
    invariant(endpoint.pathname.endsWith('/latest.json'),
      `Tauri updater endpoint must resolve to latest.json: ${rawEndpoint}`);
  }

  const keyPath = path.join(rootDirectory, UPDATER_PUBLIC_KEY_PATH);
  invariant(fs.existsSync(keyPath), `Updater public key is missing: ${UPDATER_PUBLIC_KEY_PATH}`);
  const keyMetadata = fs.lstatSync(keyPath);
  invariant(keyMetadata.isFile() && !keyMetadata.isSymbolicLink(),
    'Updater public key must be a regular repository file');
  const publicKey = readText(rootDirectory, UPDATER_PUBLIC_KEY_PATH).trim();
  invariant(publicKey !== 'UNCONFIGURED' && !/placeholder|changeme/i.test(publicKey),
    'Updater public key is still a placeholder');
  decodeUpdaterPublicKey(publicKey);
  invariant(
    updater.pubkey === '' || updater.pubkey === publicKey,
    'Tauri updater config public key must be empty for the reviewed Rust override or match it exactly',
  );
  assertNoGuestUpdaterPermissions(rootDirectory);
  return { endpointCount: endpoints.size };
}

function assertTauriConfiguration(rootDirectory = REPOSITORY_ROOT) {
  const config = readJson(rootDirectory, TAURI_CONFIG_PATH);
  invariant(config.bundle && config.bundle.active === true, 'Tauri bundle.active must remain true');
  invariant(config.bundle.targets === 'all', 'Tauri bundle.targets must remain all; CI supplies the host-specific subset');
  invariant(
    config.bundle.useLocalToolsDir === undefined || config.bundle.useLocalToolsDir === false,
    'Tauri bundle.useLocalToolsDir must remain false so verified Windows tools use the reviewed user-cache path',
  );
  invariant(
    typeof config.identifier === 'string' && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(config.identifier),
    'Tauri identifier must be a stable reverse-domain identifier',
  );
  assertProductionCsp(config);

  invariant(Array.isArray(config.bundle.icon) && config.bundle.icon.length > 0, 'Tauri bundle.icon must list release icons');
  for (const icon of config.bundle.icon) {
    invariant(typeof icon === 'string' && icon.length > 0, 'Tauri bundle icon entries must be paths');
    const iconPath = path.resolve(rootDirectory, TAURI_DIRECTORY, icon);
    invariant(fs.existsSync(iconPath), `Tauri release icon does not exist: ${icon}`);
    const metadata = fs.lstatSync(iconPath);
    invariant(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, `Tauri release icon is invalid: ${icon}`);
  }
  const mappings = collectResourceMappings(rootDirectory);
  assertWorkerResources(rootDirectory, mappings);
  return mappings;
}

function assertTauriProductionBuildContract(rootDirectory = REPOSITORY_ROOT) {
  const rootPackage = readJson(rootDirectory, 'package.json');
  const desktopPackage = readJson(rootDirectory, 'apps/desktop/package.json');
  invariant(
    rootPackage.scripts?.['tauri:build'] === 'npm --prefix apps/desktop run tauri:build --',
    'Root tauri:build must delegate to the guarded desktop production build script',
  );
  invariant(
    rootPackage.scripts?.build === 'npm run tauri:build',
    'Root build must use the guarded Tauri production build script',
  );
  invariant(
    desktopPackage.scripts?.['tauri:build'] === 'tauri build --features production',
    'Desktop tauri:build must enable the production custom-protocol feature',
  );

  const cargoToml = readText(rootDirectory, `${TAURI_DIRECTORY}/Cargo.toml`);
  const features = extractTomlSection(cargoToml, 'features');
  invariant(
    /^\s*default\s*=\s*\[\s*]\s*(?:#.*)?$/m.test(features),
    'Desktop Cargo default features must remain empty so development mode uses the dev URL',
  );
  invariant(
    /^\s*production\s*=\s*\[\s*["']tauri\/custom-protocol["']\s*]\s*(?:#.*)?$/m.test(features),
    'Desktop Cargo production feature must enable only tauri/custom-protocol',
  );

  const mainSource = readText(rootDirectory, `${TAURI_DIRECTORY}/src/main.rs`);
  invariant(
    /#\[cfg\(all\(not\(debug_assertions\),\s*not\(feature\s*=\s*["']production["']\)\)\)]\s*compile_error!\s*\(/m
      .test(mainSource),
    'Desktop main.rs must reject release builds that omit the production feature',
  );
  invariant(
    mainSource.includes('plain `cargo build --release` retains the development URL'),
    'Desktop release-build diagnostic must explain the retained development URL',
  );

  const commandsSource = readText(rootDirectory, `${TAURI_DIRECTORY}/src/commands.rs`);
  const selectMediaStart = commandsSource.indexOf('async fn select_media(');
  const selectMediaEnd = commandsSource.indexOf('\n}', selectMediaStart);
  const selectMedia = selectMediaStart >= 0 && selectMediaEnd > selectMediaStart
    ? commandsSource.slice(selectMediaStart, selectMediaEnd)
    : '';
  const fileDialogIndex = selectMedia.indexOf('.file()');
  const parentIndex = selectMedia.indexOf('.set_parent(&window)', fileDialogIndex);
  const titleIndex = selectMedia.indexOf('.set_title("Choose video or audio")', parentIndex);
  invariant(
    /\bwindow\s*:\s*WebviewWindow\b/.test(selectMedia)
      && fileDialogIndex >= 0
      && parentIndex > fileDialogIndex
      && titleIndex > parentIndex,
    'Desktop select_media must parent the native picker to the invoking WebviewWindow',
  );
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function assertImmutableSourceUrl(rawUrl, componentId) {
  let sourceUrl;
  try {
    sourceUrl = new URL(rawUrl);
  } catch {
    throw new Error(`Runtime manifest ${componentId} sourceUrl is invalid`);
  }
  invariant(sourceUrl.protocol === 'https:', `Runtime manifest ${componentId} sourceUrl must use HTTPS`);
  invariant(!sourceUrl.username && !sourceUrl.password, `Runtime manifest ${componentId} sourceUrl may not contain credentials`);
  invariant(!sourceUrl.hash && !sourceUrl.search, `Runtime manifest ${componentId} sourceUrl must be immutable and query-free`);
  invariant(!/(?:^|\/)latest(?:\/|$)/i.test(sourceUrl.pathname), `Runtime manifest ${componentId} sourceUrl may not use a latest alias`);
}


function assertPositiveInteger(value, label) {
  invariant(Number.isSafeInteger(value) && value > 0, `${label} must be a positive integer`);
}

function assertSha256(value, label) {
  invariant(/^[0-9a-f]{64}$/.test(value), `${label} must be a lowercase SHA-256 digest`);
}

function assertNativeToolNotice(notice, tool, index) {
  const label = `Native tool ${tool.id}.notices[${index}]`;
  invariant(notice && typeof notice === 'object' && !Array.isArray(notice),
    `${label} must be an object`);
  const installPath = assertSafeManifestPath(notice.installPath, `${label}.installPath`);
  invariant(installPath.startsWith('licenses/'), `${label} must install below licenses/`);
  assertImmutableSourceUrl(notice.sourceUrl, label);
  const source = new URL(notice.sourceUrl);
  invariant(source.hostname === 'raw.githubusercontent.com',
    `${label}.sourceUrl must use raw.githubusercontent.com`);
  invariant(source.pathname.includes(`/${tool.sourceRevision}/`),
    `${label}.sourceUrl must bind the reviewed source revision`);
  assertPositiveInteger(notice.sizeBytes, `${label}.sizeBytes`);
  assertSha256(notice.sha256, `${label}.sha256`);
}

function expectedNativeToolExecutable(toolId, target) {
  const suffix = target.endsWith('windows-msvc') ? '.exe' : '';
  return `bin/${toolId}${suffix}`;
}

function assertNativeToolRelease(release, tool, target, expectation) {
  const label = `Native tool ${tool.id} ${target}`;
  invariant(release && typeof release === 'object' && !Array.isArray(release),
    `${label} release must be an object`);
  invariant(release.version === expectation.version,
    `${label} must pin version ${expectation.version}`);
  invariant(release.distributionMode === 'direct-reviewed-source-download-only',
    `${label} must remain direct-reviewed-source-download-only`);

  const artifact = release.artifact;
  invariant(artifact && typeof artifact === 'object' && !Array.isArray(artifact),
    `${label}.artifact must be an object`);
  const asset = assertSafeManifestPath(artifact.asset, `${label}.artifact.asset`);
  invariant(!asset.includes('/'), `${label}.artifact.asset must be one file name`);
  invariant(['raw', 'zip'].includes(artifact.format),
    `${label}.artifact.format must be raw or zip`);
  assertImmutableSourceUrl(artifact.sourceUrl, label);
  const source = new URL(artifact.sourceUrl);
  invariant(source.hostname === 'github.com', `${label} must download from github.com`);
  invariant(source.pathname.startsWith(`/${expectation.repository}/releases/download/`),
    `${label} must download from the reviewed upstream repository`);
  invariant(
    source.pathname ===
      `/${expectation.repository}/releases/download/${expectation.releaseTag}/${encodeURIComponent(asset)}`,
    `${label} must download the exact reviewed release tag ${expectation.releaseTag}`,
  );
  invariant(decodeURIComponent(source.pathname.split('/').at(-1)) === asset,
    `${label}.artifact.asset must match its source URL`);
  assertPositiveInteger(artifact.sizeBytes, `${label}.artifact.sizeBytes`);
  assertSha256(artifact.sha256, `${label}.artifact.sha256`);

  invariant(Array.isArray(release.files) && release.files.length === 1,
    `${label} must inventory exactly one executable`);
  const [file] = release.files;
  const sourcePath = assertSafeManifestPath(file && file.sourcePath, `${label}.files[0].sourcePath`);
  const installPath = assertSafeManifestPath(file && file.installPath, `${label}.files[0].installPath`);
  invariant(file.role === expectation.role, `${label}.files[0].role is invalid`);
  invariant(installPath === expectedNativeToolExecutable(tool.id, target),
    `${label} executable install path is not the managed runtime path`);
  assertPositiveInteger(file.sizeBytes, `${label}.files[0].sizeBytes`);
  assertSha256(file.sha256, `${label}.files[0].sha256`);
  if (artifact.format === 'raw') {
    invariant(sourcePath === asset, `${label} raw artifact source path must match its asset`);
    invariant(file.sizeBytes === artifact.sizeBytes && file.sha256 === artifact.sha256,
      `${label} raw executable must match its downloaded artifact`);
  }
}

function assertNativeToolDelivery(rootDirectory, mappings = []) {
  const delivery = readJson(rootDirectory, NATIVE_TOOL_DELIVERY_PATH);
  const audit = readJson(rootDirectory, NATIVE_TOOL_AUDIT_PATH);
  invariant(delivery.schemaVersion === 1, 'Native-tool delivery must use schemaVersion 1');
  invariant(audit.schemaVersion === 1, 'Native-tool upstream audit must use schemaVersion 1');
  invariant(delivery.policy && delivery.policy.artifactDelivery === 'direct-reviewed-source-download-only',
    'Native-tool delivery must remain direct-reviewed-source-download-only');
  invariant(delivery.policy.bundledArtifacts === false,
    'Native-tool executables must not be bundled in the application');
  invariant(delivery.policy.selfUpdateAllowed === false,
    'Managed native tools must not self-update');

  const bundledTools = mappings.filter(({ destination }) =>
    /(?:^|\/)(?:ffmpeg|ffprobe|yt-dlp|deno)(?:\.exe)?$/i.test(destination));
  invariant(bundledTools.length === 0,
    `Native-tool executables must be installed from the reviewed catalog, not bundled: ${bundledTools.map(({ destination }) => destination).join(', ')}`);

  invariant(Array.isArray(delivery.tools), 'Native-tool delivery must contain tools');
  const ids = delivery.tools.map((tool) => tool && tool.id);
  invariant(new Set(ids).size === ids.length, 'Native-tool delivery IDs must be unique');
  invariant(ids.length === NATIVE_TOOL_IDS.length
    && NATIVE_TOOL_IDS.every((id) => ids.includes(id)),
  `Native-tool delivery must contain exactly: ${NATIVE_TOOL_IDS.join(', ')}`);

  const mediaTools = delivery.tools.find(({ id }) => id === 'media-tools');
  invariant(mediaTools.license === 'GPL-3.0-or-later',
    'Media-tool delivery must declare its GPL license floor');
  invariant(audit.ffmpeg && audit.ffmpeg.requiredEncoder === 'libx264'
    && audit.ffmpeg.deliveryPolicy === 'external-site-first'
    && Array.isArray(audit.ffmpeg.deliveryEnabledPlatforms)
    && audit.ffmpeg.deliveryEnabledPlatforms.length === 1
    && audit.ffmpeg.deliveryEnabledPlatforms[0] === 'windows-x86_64',
  'Native-tool audit must enable only the reviewed Windows FFmpeg direct download');
  invariant(audit.ffmpeg.ffprobeOnly && audit.ffmpeg.ffprobeOnly.deliveryEnabled === false,
    'Native-tool audit must not disguise the reviewed GPL ffprobe builds as LGPL delivery');
  invariant(Array.isArray(audit.ffmpeg.reviewedCandidates)
    && audit.ffmpeg.reviewedCandidates.length > 0
    && audit.ffmpeg.reviewedCandidates.every((candidate) =>
      candidate && candidate.status !== 'approved'
      && Object.values(candidate.platforms || {}).every((platform) =>
        platform.approvedForRedistribution === false)),
  'Every rejected FFmpeg candidate must remain explicitly unapproved');

  for (const target of Object.keys(ENGINE_PLATFORM_BY_TARGET)) {
    const platform = mediaTools.platforms && mediaTools.platforms[ENGINE_PLATFORM_BY_TARGET[target]];
    invariant(platform && Array.isArray(platform.releases),
      `Media-tool delivery is missing ${target}`);
    if (target === 'x86_64-pc-windows-msvc') {
      const approved = audit.ffmpeg.approvedDirectDownloads?.['windows-x86_64'];
      invariant(platform.blocker === null && platform.releases.length === 1,
        'Windows media-tool delivery must contain exactly one reviewed release');
      const release = platform.releases[0];
      invariant(approved && release.version === approved.version
        && release.artifact?.sourceUrl === approved.sourceUrl
        && release.artifact?.sizeBytes === approved.sizeBytes
        && release.artifact?.sha256 === approved.sha256
        && approved.sha256 === approved.publishedSha256
        && approved.sourceRevision === mediaTools.sourceRevision
        && approved.license === mediaTools.license
        && approved.libx264 === true && approved.nonfree === false,
      'Windows media-tool release differs from its upstream audit lock');
      invariant(release.distributionMode === 'direct-reviewed-source-download-only'
        && release.artifact.selectiveExtraction === true
        && release.files.length === 4
        && new Set(release.files.map(({ role }) => role).filter(Boolean)).size === 2,
      'Windows media-tool release must selectively install two executables and two notices');
    } else {
      invariant(platform.releases.length === 0,
        `Media-tool delivery for ${target} must remain disabled until its audit is replaced`);
      invariant(typeof platform.blocker === 'string' && platform.blocker.length >= 40,
        `Media-tool delivery for ${target} needs an exact blocker`);
    }
  }

  for (const toolId of ['yt-dlp', 'deno']) {
    const tool = delivery.tools.find(({ id }) => id === toolId);
    const expectation = NATIVE_TOOL_EXPECTATIONS[toolId];
    const audited = audit[expectation.revisionKey];
    invariant(tool.license === expectation.license,
      `Native tool ${toolId} has an unexpected license`);
    invariant(typeof tool.sourceRevision === 'string' && /^[0-9a-f]{40}$/.test(tool.sourceRevision),
      `Native tool ${toolId} must bind one source revision`);
    invariant(audited && audited.version === expectation.version
      && audited.revision === tool.sourceRevision
      && audited.releaseImmutable === true
      && audited.deliveryPolicy === 'direct-upstream-download-only',
    `Native tool ${toolId} differs from its upstream audit lock`);
    invariant(Array.isArray(tool.notices) && tool.notices.length === expectation.noticeCount,
      `Native tool ${toolId} has an incomplete notice inventory`);
    tool.notices.forEach((notice, index) => assertNativeToolNotice(notice, tool, index));
    const noticeHashes = new Set(tool.notices.map(({ sha256 }) => sha256));
    if (toolId === 'yt-dlp') {
      invariant(noticeHashes.has(audited.licenseSha256)
        && noticeHashes.has(audited.thirdPartyNoticesSha256),
      'yt-dlp notice hashes differ from the upstream audit lock');
    } else {
      invariant(noticeHashes.has(audited.licenseSha256),
        'Deno license hash differs from the upstream audit lock');
    }

    const platforms = tool.platforms;
    invariant(platforms && Object.keys(platforms).length === Object.keys(ENGINE_PLATFORM_BY_TARGET).length,
      `Native tool ${toolId} must cover exactly four target families`);
    for (const target of Object.keys(ENGINE_PLATFORM_BY_TARGET)) {
      const platform = platforms[ENGINE_PLATFORM_BY_TARGET[target]];
      invariant(platform && platform.blocker === null && Array.isArray(platform.releases)
        && platform.releases.length === 1,
      `Native tool ${toolId} must have one reviewed release for ${target}`);
      assertNativeToolRelease(platform.releases[0], tool, target, expectation);
    }
  }

  invariant(Array.isArray(audit.repositoryReleaseBlockers)
    && new Set(audit.repositoryReleaseBlockers).size === audit.repositoryReleaseBlockers.length
    && audit.repositoryReleaseBlockers.every((blocker) =>
      typeof blocker === 'string' && blocker.length >= 40),
  'Native-tool audit must list each repository release blocker exactly once');
  for (const command of [
    'native_tools_catalog',
    'native_tools_status',
    'native_tool_install',
    'native_tool_cancel',
  ]) {
    assertCommandWiring(rootDirectory, command);
  }
  return { audit, delivery, mediaTools };
}

function assertRequiredMediaToolDelivery(rootDirectory, target) {
  const delivery = readJson(rootDirectory, NATIVE_TOOL_DELIVERY_PATH);
  const mediaTools = delivery.tools && delivery.tools.find(({ id }) => id === 'media-tools');
  const platformKey = ENGINE_PLATFORM_BY_TARGET[target];
  invariant(platformKey, `Unsupported native-tool target ${JSON.stringify(target)}`);
  const platform = mediaTools && mediaTools.platforms && mediaTools.platforms[platformKey];
  invariant(platform && Array.isArray(platform.releases) && platform.releases.length > 0,
    `FFmpeg/ffprobe delivery is unavailable for ${target}: ${platform && platform.blocker
      ? platform.blocker
      : 'no reviewed media-tool release exists'}`);
}

function collectPromptDjFontReleasePolicyFailures(rootDirectory) {
  const fontRoot = path.join(rootDirectory, PROMPTDJ_FONT_DIRECTORY);
  const fontFiles = walkFiles(fontRoot, (candidate) => DISTRIBUTABLE_FONT_EXTENSION.test(candidate))
    .map((absolutePath) => path.relative(rootDirectory, absolutePath).replaceAll('\\', '/'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (fontFiles.length === 0) {
    return [];
  }

  const failures = [];
  const noticesPath = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
  const notices = fs.existsSync(noticesPath)
    ? fs.readFileSync(noticesPath, 'utf8')
    : '';
  const missingNotices = fontFiles.filter((relativePath) => {
    const fileName = path.posix.basename(relativePath);
    return !notices.includes(relativePath) && !notices.includes(fileName);
  });
  if (missingNotices.length > 0) {
    failures.push(
      `Bundled PromptDJ font assets are absent from THIRD_PARTY_NOTICES.md: ${missingNotices.join(', ')}`,
    );
  }
  return failures;
}

function assertRepositoryReleasePolicy(rootDirectory) {
  const audit = readJson(rootDirectory, NATIVE_TOOL_AUDIT_PATH);
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map((name) => path.join(rootDirectory, name))
    .find((candidate) => fs.existsSync(candidate));
  const notices = path.join(rootDirectory, 'THIRD_PARTY_NOTICES.md');
  const failures = new Set(Array.isArray(audit.repositoryReleaseBlockers)
    ? audit.repositoryReleaseBlockers
    : []);
  if (!license && ![...failures].some((failure) => /root LICENSE/i.test(failure))) {
    failures.add('The repository owner has not selected a root LICENSE.');
  }
  if (!fs.existsSync(notices)
      && ![...failures].some((failure) => /third-party notices/i.test(failure))) {
    failures.add('THIRD_PARTY_NOTICES.md is missing.');
  }
  for (const failure of collectPromptDjFontReleasePolicyFailures(rootDirectory)) {
    failures.add(failure);
  }
  invariant(failures.size === 0,
    `Repository licensing/notice policy is unresolved: ${[...failures].join('; ')}`);
}

function assertSafeManifestPath(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty path`);
  const normalized = value.replaceAll('\\', '/');
  invariant(
    !path.posix.isAbsolute(normalized) &&
      normalized.split('/').every((component) => component && component !== '.' && component !== '..'),
    `${label} must be a safe relative path`,
  );
  return normalized;
}

function assertDeliveryRelease(release, label, { requireModel, requireSourceUrl }) {
  invariant(release && typeof release === 'object' && !Array.isArray(release), `${label} must be an object`);
  invariant(
    typeof release.version === 'string' &&
      /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(release.version) &&
      !/latest/i.test(release.version),
    `${label} must pin an exact version`,
  );
  const asset = assertSafeManifestPath(release.asset, `${label}.asset`);
  invariant(
    release.manifest === undefined ? asset.endsWith('.zip') : asset.endsWith('.manifest.json'),
    `${label}.asset must be a content-addressed archive or remote manifest`,
  );
  invariant(/^[0-9a-f]{64}$/i.test(release.sha256), `${label}.sha256 must be a full SHA-256 digest`);
  invariant(
    asset.includes(release.sha256.slice(0, 16).toLowerCase()),
    `${label}.asset must include the first 16 archive-hash characters`,
  );
  invariant(
    Number.isSafeInteger(release.sizeBytes) && release.sizeBytes > 0,
    `${label}.sizeBytes must be a positive integer`,
  );
  invariant(
    Number.isSafeInteger(release.unpackedSizeBytes) && release.unpackedSizeBytes > 0,
    `${label}.unpackedSizeBytes must be a positive integer`,
  );
  assertSafeManifestPath(release.pythonRelativePath, `${label}.pythonRelativePath`);
  if (requireModel) {
    assertSafeManifestPath(release.modelRelativePath, `${label}.modelRelativePath`);
  }
  if (requireSourceUrl) {
    assertImmutableSourceUrl(release.sourceUrl, label);
  }
  if (release.manifest !== undefined) {
    const manifest = release.manifest;
    invariant(manifest && typeof manifest === 'object' && !Array.isArray(manifest),
      `${label}.manifest must be an object`);
    const manifestAsset = assertSafeManifestPath(manifest.asset, `${label}.manifest.asset`);
    invariant(!manifestAsset.includes('/') && manifestAsset.endsWith('.manifest.json'),
      `${label}.manifest.asset must be a content-addressed manifest file`);
    invariant(/^[0-9a-f]{64}$/.test(manifest.sha256),
      `${label}.manifest.sha256 must be a full lowercase SHA-256 digest`);
    invariant(manifestAsset.includes(manifest.sha256.slice(0, 16)),
      `${label}.manifest.asset must include its hash prefix`);
    invariant(Number.isSafeInteger(manifest.sizeBytes) && manifest.sizeBytes > 0,
      `${label}.manifest.sizeBytes must be positive`);
    invariant(Array.isArray(manifest.urls) && manifest.urls.length > 0 && manifest.urls.length <= 3,
      `${label}.manifest.urls must contain one to three sources`);
    invariant(Array.isArray(release.files) && release.files.length === 0,
      `${label}.files must stay empty when inventory is remotely hash-bound`);
    invariant(Array.isArray(release.sources) && release.sources.length > 0,
      `${label}.sources must inventory every downloadable payload`);
    let downloadBytes = manifest.sizeBytes;
    for (const [index, source] of release.sources.entries()) {
      const sourceLabel = `${label}.sources[${index}]`;
      invariant(source && typeof source === 'object' && !Array.isArray(source),
        `${sourceLabel} must be an object`);
      invariant(['zip', 'raw'].includes(source.kind), `${sourceLabel}.kind is unsupported`);
      const sourceAsset = assertSafeManifestPath(source.asset, `${sourceLabel}.asset`);
      invariant(!sourceAsset.includes('/'), `${sourceLabel}.asset must be one file name`);
      invariant(/^[0-9a-f]{64}$/.test(source.sha256),
        `${sourceLabel}.sha256 must be a full lowercase SHA-256 digest`);
      invariant(Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > 0,
        `${sourceLabel}.sizeBytes must be positive`);
      invariant(Array.isArray(source.urls) && source.urls.length > 0 && source.urls.length <= 3,
        `${sourceLabel}.urls must contain one to three sources`);
      for (const rawUrl of source.urls) {
        assertImmutableSourceUrl(rawUrl, sourceLabel);
        const url = new URL(rawUrl);
        invariant(decodeURIComponent(url.pathname.split('/').at(-1)) === sourceAsset,
          `${sourceLabel}.asset must match its source URL`);
        const pool = url.hostname === 'github.com'
          && url.pathname.startsWith('/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/');
        const huggingFace = url.hostname === 'huggingface.co'
          && /\/resolve\/[0-9a-f]{40}\//.test(url.pathname);
        invariant(pool || huggingFace,
          `${sourceLabel} must use the reviewed bundle pool or an immutable Hugging Face revision`);
      }
      downloadBytes += source.sizeBytes;
      invariant(Number.isSafeInteger(downloadBytes), `${label} download size overflows`);
    }
    for (const rawUrl of manifest.urls) {
      assertImmutableSourceUrl(rawUrl, `${label}.manifest`);
      const url = new URL(rawUrl);
      invariant(url.hostname === 'github.com'
        && url.pathname === `/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/${manifestAsset}`,
      `${label}.manifest must use the reviewed bundle pool`);
    }
    invariant(release.sizeBytes === downloadBytes,
      `${label}.sizeBytes must equal manifest plus source bytes`);
    return;
  }
  invariant(Array.isArray(release.files) && release.files.length > 0, `${label}.files must not be empty`);
  const roles = new Set();
  const filePaths = new Set();
  for (const [index, file] of release.files.entries()) {
    const fileLabel = `${label}.files[${index}]`;
    invariant(file && typeof file === 'object' && !Array.isArray(file), `${fileLabel} must be an object`);
    const filePath = assertSafeManifestPath(file.path, `${fileLabel}.path`);
    invariant(!filePaths.has(filePath), `${label} contains duplicate file path ${filePath}`);
    filePaths.add(filePath);
    invariant(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0, `${fileLabel}.sizeBytes must be positive`);
    invariant(/^[0-9a-f]{64}$/i.test(file.sha256), `${fileLabel}.sha256 must be a full SHA-256 digest`);
    invariant(['runtime', 'model', 'aligner', 'license'].includes(file.role), `${fileLabel}.role is unsupported`);
    roles.add(file.role);
  }
  invariant(roles.has('runtime'), `${label} must inventory its Python runtime`);
  invariant(roles.has('license'), `${label} must inventory license notices`);
  if (requireModel) {
    invariant(roles.has('model'), `${label} must inventory its model payload`);
  }
}

function assertDeliveryEntries(platform, collectionName, expectedIds, label, optionsForId) {
  const entries = platform && platform[collectionName];
  invariant(Array.isArray(entries), `${label} must contain ${collectionName}`);
  const ids = entries.map((entry) => entry && entry.id);
  invariant(new Set(ids).size === ids.length, `${label} ${collectionName} ids must be unique`);
  invariant(
    ids.length === expectedIds.length && ids.every((id) => expectedIds.includes(id)),
    `${label} ${collectionName} must be exactly: ${expectedIds.join(', ')}`,
  );
  const unavailable = [];
  for (const entry of entries) {
    if (!Array.isArray(entry.releases) || entry.releases.length === 0) {
      unavailable.push(entry.id);
      continue;
    }
    for (const [index, release] of entry.releases.entries()) {
      assertDeliveryRelease(
        release,
        `${label} ${entry.id}.releases[${index}]`,
        optionsForId(entry.id),
      );
    }
  }
  invariant(
    unavailable.length === 0,
    `${label} has no reviewed release for: ${unavailable.join(', ')}`,
  );
}

function assertBundledRenderRuntime(rootDirectory, target, release, mappings) {
  const prefix = `render-runtime/${target}/`;
  const expected = new Map([
    [release.manifest.path, release.manifest],
    ...release.files.map((file) => [file.path, file]),
  ]);
  invariant(
    expected.size === release.files.length + 1,
    `Remotion delivery ${target} manifest path must not duplicate a runtime file`,
  );
  const packagedRuntime = mappings.filter((mapping) => mapping.destination.startsWith(prefix));
  invariant(
    packagedRuntime.length === expected.size,
    `Remotion delivery ${target} must package exactly ${expected.size} reviewed runtime files below ${prefix}`,
  );
  for (const [relativePath, inventory] of expected) {
    const destination = `${prefix}${relativePath}`;
    const mapping = packagedRuntime.find((candidate) => candidate.destination === destination);
    invariant(mapping, `Remotion delivery ${target} does not package ${destination}`);
    invariant(
      mapping.size === inventory.sizeBytes,
      `Packaged Remotion runtime size differs from the catalog: ${destination}`,
    );
    invariant(
      sha256File(mapping.sourceAbsolute) === inventory.sha256,
      `Packaged Remotion runtime hash differs from the catalog: ${destination}`,
    );
  }

  const manifestMapping = packagedRuntime.find(
    (candidate) => candidate.destination === `${prefix}${release.manifest.path}`,
  );
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(manifestMapping.sourceAbsolute, 'utf8'));
  } catch {
    throw new Error(`Packaged Remotion runtime receipt is not valid JSON for ${target}`);
  }
  invariant(
    receipt && typeof receipt === 'object' && !Array.isArray(receipt) &&
      JSON.stringify(Object.keys(receipt).sort()) ===
        JSON.stringify(['files', 'remotionVersion', 'schemaVersion', 'target']),
    `Packaged Remotion runtime receipt has an unsupported schema for ${target}`,
  );
  invariant(receipt.schemaVersion === 1, `Packaged Remotion runtime receipt schema is invalid for ${target}`);
  invariant(receipt.target === target, `Packaged Remotion runtime receipt target does not match ${target}`);
  invariant(
    receipt.remotionVersion === REMOTION_VERSION,
    `Packaged Remotion runtime receipt must pin ${REMOTION_VERSION}`,
  );
  invariant(
    Array.isArray(receipt.files) && receipt.files.length === release.files.length,
    `Packaged Remotion runtime receipt inventory is incomplete for ${target}`,
  );
  const receiptFiles = new Map();
  for (const entry of receipt.files) {
    invariant(
      entry && typeof entry === 'object' && !Array.isArray(entry) &&
        JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify(['path', 'role', 'sha256', 'sizeBytes']),
      `Packaged Remotion runtime receipt file schema is invalid for ${target}`,
    );
    invariant(!receiptFiles.has(entry.path),
      `Packaged Remotion runtime receipt repeats ${entry.path}`);
    receiptFiles.set(entry.path, entry);
  }
  for (const file of release.files) {
    const receiptFile = receiptFiles.get(file.path);
    invariant(
      receiptFile &&
        receiptFile.role === file.role &&
        receiptFile.sizeBytes === file.sizeBytes &&
        receiptFile.sha256 === file.sha256,
      `Packaged Remotion runtime receipt differs from the catalog for ${file.path}`,
    );
  }
}

function assertRustCommandImplementation(rootDirectory, command) {
  const rustSources = [
    ...walkFiles(
      path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
    ...walkFiles(
      path.join(rootDirectory, 'crates/osg-engine-packages/src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
  ];
  const implementation = new RegExp(
    `\\b(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${escapeRegularExpression(command)}\\s*\\(`,
  );
  invariant(
    rustSources.some((sourcePath) => implementation.test(fs.readFileSync(sourcePath, 'utf8'))),
    `Desktop Rust sources do not implement managed-runtime command ${command}`,
  );
}

function assertManagedRenderRuntimeInstaller(rootDirectory, catalog) {
  const commands = catalog.commands;
  invariant(
    commands && typeof commands === 'object' && !Array.isArray(commands),
    'Remotion delivery catalog must declare managed installer commands',
  );
  for (const key of ['status', 'install', 'remove', 'cancel']) {
    const command = commands[key];
    invariant(typeof command === 'string', `Remotion delivery catalog commands.${key} is missing`);
    assertCommandWiring(rootDirectory, command);
    assertRustCommandImplementation(rootDirectory, command);
  }
  const rustSources = [
    ...walkFiles(
      path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
    ...walkFiles(
      path.join(rootDirectory, 'crates/osg-engine-packages/src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
  ];
  invariant(
    rustSources.some((sourcePath) =>
      /include_(?:str|bytes)!\s*\(\s*["'][^"']*remotion-runtime\.delivery\.json["']\s*\)/
        .test(fs.readFileSync(sourcePath, 'utf8')),
    ),
    'Managed Remotion installer must compile-bind remotion-runtime.delivery.json',
  );
}

function assertManagedRenderRuntimeInstallerV2(rootDirectory, catalog) {
  const expected = {
    status: 'render_package_status',
    install: 'render_package_install',
    remove: 'render_package_remove',
  };
  invariant(catalog.commands && typeof catalog.commands === 'object'
    && !Array.isArray(catalog.commands),
  'Remotion delivery catalog must declare managed installer commands');
  invariant(Object.keys(catalog.commands).length === Object.keys(expected).length,
    'Remotion delivery catalog has unexpected managed installer commands');
  for (const [key, command] of Object.entries(expected)) {
    invariant(catalog.commands[key] === command,
      `Remotion delivery catalog commands.${key} must be ${command}`);
    assertCommandWiring(rootDirectory, command);
    assertRustCommandImplementation(rootDirectory, command);
  }
  assertCommandWiring(rootDirectory, 'job_cancel');
  const rustSources = [
    ...walkFiles(
      path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
    ...walkFiles(
      path.join(rootDirectory, 'crates/osg-engine-packages/src'),
      (candidate) => candidate.endsWith('.rs'),
    ),
  ];
  invariant(
    rustSources.some((sourcePath) =>
      /include_(?:str|bytes)!\s*\(\s*["'][^"']*remotion-runtime\.delivery\.json["']\s*\)/
        .test(fs.readFileSync(sourcePath, 'utf8')),
    ),
    'Managed Remotion installer must compile-bind remotion-runtime.delivery.json',
  );
}

function assertRenderRuntimeDeliveryV2(rootDirectory, target, catalog) {
  invariant(catalog.protocolVersion === 1,
    'Remotion delivery catalog must use stdio protocolVersion 1');
  invariant(catalog.remotionVersion === REMOTION_VERSION,
    `Remotion delivery catalog must pin ${REMOTION_VERSION}`);
  const worker = catalog.worker;
  invariant(worker && worker.sourcePath === 'video-renderer/worker/osg_render_worker.mjs',
    'Remotion delivery catalog must bind the reviewed native render worker');
  const workerPath = path.join(rootDirectory, worker.sourcePath);
  invariant(fs.existsSync(workerPath), 'The reviewed native render worker is missing');
  assertPositiveInteger(worker.sizeBytes, 'Remotion delivery worker.sizeBytes');
  assertSha256(worker.sha256, 'Remotion delivery worker.sha256');
  invariant(fs.statSync(workerPath).size === worker.sizeBytes,
    'Native render worker size does not match the delivery catalog');
  invariant(sha256File(workerPath) === worker.sha256,
    'Native render worker hash does not match the delivery catalog');

  const platformKey = ENGINE_PLATFORM_BY_TARGET[target];
  invariant(platformKey, `Unsupported Remotion delivery target ${target}`);
  invariant(catalog.platforms && Object.keys(catalog.platforms).length === 4,
    'Remotion delivery catalog must declare exactly four supported platform records');
  for (const key of ['linux-x86_64', 'macos-aarch64', 'macos-x86_64', 'windows-x86_64']) {
    invariant(catalog.platforms[key] && Array.isArray(catalog.platforms[key].releases),
      `Remotion delivery catalog is missing platform ${key}`);
  }
  const releases = catalog.platforms[platformKey].releases;
  invariant(releases.length === 1,
    `Remotion delivery catalog ${platformKey} must contain exactly one reviewed runtime release`);
  const [release] = releases;
  const label = `Remotion delivery ${platformKey}`;
  invariant(release.version === REMOTION_VERSION,
    `${label}.version must be ${REMOTION_VERSION}`);
  invariant(release.sourceUrl === '', `${label}.sourceUrl must be empty for multi-source delivery`);
  assertPositiveInteger(release.sizeBytes, `${label}.sizeBytes`);
  assertPositiveInteger(release.unpackedSizeBytes, `${label}.unpackedSizeBytes`);
  assertSha256(release.sha256, `${label}.sha256`);
  invariant(release.pythonRelativePath === 'runtime/bin/node.exe',
    `${label}.pythonRelativePath must identify the managed Node executable`);
  invariant(release.modelRelativePath === null, `${label}.modelRelativePath must be null`);
  invariant(Array.isArray(release.files) && release.files.length === 0,
    `${label}.files must be supplied only by the hashed delivery manifest`);
  invariant(Array.isArray(release.sources) && release.sources.length > 0,
    `${label}.sources must not be empty`);

  const validateAsset = (asset, assetLabel, kindRequired = false) => {
    invariant(asset && typeof asset === 'object' && !Array.isArray(asset),
      `${assetLabel} must be an object`);
    const name = assertSafeManifestPath(asset.asset, `${assetLabel}.asset`);
    invariant(!name.includes('/'), `${assetLabel}.asset must be one file name`);
    assertPositiveInteger(asset.sizeBytes, `${assetLabel}.sizeBytes`);
    assertSha256(asset.sha256, `${assetLabel}.sha256`);
    invariant(name.toLowerCase().includes(asset.sha256.slice(0, 16)),
      `${assetLabel}.asset must be content-addressed by its SHA-256`);
    invariant(Array.isArray(asset.urls) && asset.urls.length > 0,
      `${assetLabel}.urls must not be empty`);
    for (const [index, url] of asset.urls.entries()) {
      assertImmutableSourceUrl(url, `${assetLabel}.urls[${index}]`);
      const parsed = new URL(url);
      invariant(parsed.hostname === 'github.com'
        && parsed.pathname.startsWith('/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/'),
      `${assetLabel} must use the reviewed bundle-pool fallback`);
      invariant(decodeURIComponent(parsed.pathname.split('/').at(-1)) === name,
        `${assetLabel}.asset must match its source URL`);
    }
    if (kindRequired) invariant(['zip', 'raw'].includes(asset.kind),
      `${assetLabel}.kind must be zip or raw`);
    return asset.sizeBytes;
  };
  const sourceBytes = release.sources.reduce((total, source, index) => (
    total + validateAsset(source, `${label}.sources[${index}]`, true)
  ), 0);
  const manifestBytes = validateAsset(release.manifest, `${label}.manifest`);
  invariant(release.asset === release.manifest.asset
    && release.sha256 === release.manifest.sha256,
  `${label} must bind its top-level identity to the delivery manifest`);
  invariant(release.sizeBytes === sourceBytes + manifestBytes,
    `${label}.sizeBytes must equal all source and manifest bytes`);
  assertManagedRenderRuntimeInstallerV2(rootDirectory, catalog);
}

function assertRenderRuntimeDelivery(rootDirectory, target, resourceMappings) {
  const catalog = readJson(rootDirectory, RENDER_DELIVERY_PATH);
  if (catalog.schemaVersion === 2) {
    assertRenderRuntimeDeliveryV2(rootDirectory, target, catalog);
    return;
  }
  invariant(catalog.schemaVersion === 1, 'Remotion delivery catalog must use schemaVersion 1');
  invariant(catalog.protocolVersion === 1, 'Remotion delivery catalog must use stdio protocolVersion 1');
  invariant(
    catalog.remotionVersion === REMOTION_VERSION,
    `Remotion delivery catalog must pin ${REMOTION_VERSION}`,
  );
  const worker = catalog.worker;
  invariant(worker && worker.sourcePath === 'video-renderer/worker/osg_render_worker.mjs',
    'Remotion delivery catalog must bind the reviewed native render worker');
  const workerPath = path.join(rootDirectory, worker.sourcePath);
  invariant(fs.existsSync(workerPath), 'The reviewed native render worker is missing');
  invariant(Number.isSafeInteger(worker.sizeBytes) && worker.sizeBytes > 0,
    'Remotion delivery worker sizeBytes must be positive');
  invariant(/^[0-9a-f]{64}$/.test(worker.sha256),
    'Remotion delivery worker sha256 must be a lowercase SHA-256 digest');
  invariant(fs.statSync(workerPath).size === worker.sizeBytes,
    'Native render worker size does not match the delivery catalog');
  invariant(sha256File(workerPath) === worker.sha256,
    'Native render worker hash does not match the delivery catalog');

  const platform = catalog.platforms && catalog.platforms[target];
  invariant(platform && Array.isArray(platform.releases),
    `Remotion delivery catalog is missing target ${target}`);
  invariant(platform.releases.length > 0,
    `Remotion delivery catalog ${target} has no reviewed runtime release`);
  invariant(platform.releases.length === 1,
    `Remotion delivery catalog ${target} must contain exactly one current runtime release`);

  const requiredRoles = new Set([
    'node', 'browser', 'rendererPackage', 'bundleIndex', 'binariesMarker',
    'fontManifest', 'notices',
  ]);
  const componentIds = new Set([
    'node', 'chromium', 'remotion', 'remotion-binaries', 'font-pack',
  ]);
  for (const [releaseIndex, release] of platform.releases.entries()) {
    const label = `Remotion delivery ${target}.releases[${releaseIndex}]`;
    invariant(release && typeof release === 'object' && !Array.isArray(release),
      `${label} must be an object`);
    invariant(release.target === target, `${label}.target must be ${target}`);
    invariant(release.remotionVersion === REMOTION_VERSION,
      `${label}.remotionVersion must be ${REMOTION_VERSION}`);
    invariant(typeof release.version === 'string' && EXACT_VERSION.test(release.version),
      `${label}.version must be an exact semantic version`);
    assertImmutableSourceUrl(release.sourceUrl, label);
    invariant(['zip', 'tar.gz', 'tar.xz'].includes(release.archiveFormat),
      `${label}.archiveFormat is unsupported`);
    invariant(Number.isSafeInteger(release.archiveSizeBytes) && release.archiveSizeBytes > 0,
      `${label}.archiveSizeBytes must be positive`);
    invariant(/^[0-9a-f]{64}$/i.test(release.archiveSha256),
      `${label}.archiveSha256 must be a full SHA-256 digest`);
    invariant(Number.isSafeInteger(release.unpackedSizeBytes) && release.unpackedSizeBytes > 0,
      `${label}.unpackedSizeBytes must be positive`);
    invariant(release.manifest && release.manifest.path === 'remotion-runtime.json',
      `${label}.manifest must inventory remotion-runtime.json`);
    invariant(Number.isSafeInteger(release.manifest.sizeBytes) && release.manifest.sizeBytes > 0,
      `${label}.manifest.sizeBytes must be positive`);
    invariant(/^[0-9a-f]{64}$/i.test(release.manifest.sha256),
      `${label}.manifest.sha256 must be a full SHA-256 digest`);

    invariant(Array.isArray(release.files) && release.files.length >= requiredRoles.size,
      `${label}.files must inventory the complete runtime`);
    const paths = new Set();
    const singletonRoles = new Set();
    for (const [fileIndex, file] of release.files.entries()) {
      const fileLabel = `${label}.files[${fileIndex}]`;
      const filePath = assertSafeManifestPath(file && file.path, `${fileLabel}.path`);
      invariant(!paths.has(filePath), `${label} repeats runtime path ${filePath}`);
      paths.add(filePath);
      invariant(requiredRoles.has(file.role) || file.role === 'payload',
        `${fileLabel}.role is unsupported`);
      if (file.role !== 'payload') {
        invariant(!singletonRoles.has(file.role), `${label} repeats role ${file.role}`);
        singletonRoles.add(file.role);
      }
      invariant(Number.isSafeInteger(file.sizeBytes) && file.sizeBytes > 0,
        `${fileLabel}.sizeBytes must be positive`);
      invariant(/^[0-9a-f]{64}$/i.test(file.sha256),
        `${fileLabel}.sha256 must be a full SHA-256 digest`);
      invariant(typeof file.executable === 'boolean', `${fileLabel}.executable must be boolean`);
      if (file.role === 'node' || file.role === 'browser') {
        invariant(file.executable, `${fileLabel} must be executable`);
      }
    }
    invariant([...requiredRoles].every((role) => singletonRoles.has(role)),
      `${label} is missing one or more required runtime roles`);
    invariant(release.files.some((file) => file.role === 'payload'),
      `${label} must inventory renderer/browser/font payload files`);

    invariant(Array.isArray(release.components), `${label}.components must be an array`);
    const observedComponents = new Set(release.components.map((component) => component && component.id));
    invariant(observedComponents.size === componentIds.size
      && [...componentIds].every((id) => observedComponents.has(id)),
    `${label}.components must be exactly: ${[...componentIds].join(', ')}`);
    for (const component of release.components) {
      const componentLabel = `${label}.components.${component.id}`;
      invariant(typeof component.version === 'string' && EXACT_VERSION.test(component.version),
        `${componentLabel}.version must be exact`);
      if (component.id === 'remotion' || component.id === 'remotion-binaries') {
        invariant(component.version === REMOTION_VERSION,
          `${componentLabel}.version must be ${REMOTION_VERSION}`);
      }
      assertImmutableSourceUrl(component.sourceUrl, componentLabel);
      invariant(component.license && typeof component.license.spdx === 'string'
        && component.license.spdx.trim().length > 0,
      `${componentLabel} must declare an SPDX license expression`);
      const noticePath = assertSafeManifestPath(
        component.license.noticePath,
        `${componentLabel}.license.noticePath`,
      );
      invariant(paths.has(noticePath),
        `${componentLabel}.license.noticePath is not in the runtime inventory`);
    }
  }

  let mappings = resourceMappings;
  let mappingError;
  if (mappings === undefined) {
    try {
      mappings = collectResourceMappings(rootDirectory, target);
    } catch (error) {
      mappings = [];
      mappingError = error;
    }
  }
  let bundledError;
  try {
    assertBundledRenderRuntime(rootDirectory, target, platform.releases[0], mappings);
  } catch (error) {
    bundledError = mappingError || error;
  }
  let installerError;
  try {
    assertManagedRenderRuntimeInstaller(rootDirectory, catalog);
  } catch (error) {
    installerError = error;
  }
  invariant(
    !bundledError || !installerError,
    `Remotion delivery ${target} has no packaged render-runtime resource tree/receipt or managed installer wiring: bundled=${bundledError?.message || 'passed'}; installer=${installerError?.message || 'passed'}`,
  );
}

function assertCommandWiring(rootDirectory, command) {
  invariant(/^[a-z][a-z0-9_]{2,63}$/.test(command), `Managed-runtime command is invalid: ${command}`);
  for (const relativePath of [
    'apps/desktop/src-tauri/build.rs',
    'apps/desktop/src-tauri/src/lib.rs',
    'apps/desktop/src-tauri/permissions/app.toml',
  ]) {
    const source = readText(rootDirectory, relativePath);
    invariant(
      new RegExp(`\\b${escapeRegularExpression(command)}\\b`).test(source),
      `${relativePath} does not wire managed-runtime command ${command}`,
    );
  }
}

function assertManagedEngineDelivery(rootDirectory, target) {
  const platformKey = ENGINE_PLATFORM_BY_TARGET[target];
  invariant(platformKey, `Unsupported managed-engine target ${JSON.stringify(target)}`);
  const failures = [];

  try {
    const asrCatalog = readJson(rootDirectory, ASR_DELIVERY_PATH);
    invariant([1, 2].includes(asrCatalog.schemaVersion), 'ASR delivery catalog must use schemaVersion 1 or 2');
    assertDeliveryEntries(
      asrCatalog.platforms && asrCatalog.platforms[platformKey],
      'engines',
      ASR_ENGINE_IDS,
      `ASR delivery catalog ${platformKey}`,
      () => ({ requireModel: true, requireSourceUrl: false }),
    );
    for (const command of [
      'engine_packages_status',
      'engine_package_install',
      'engine_package_remove',
    ]) {
      assertCommandWiring(rootDirectory, command);
    }
  } catch (error) {
    failures.push(error.message);
  }

  try {
    invariant(
      fs.existsSync(path.join(rootDirectory, SPEECH_DELIVERY_PATH)),
      `Speech delivery/install catalog is missing: ${SPEECH_DELIVERY_PATH}`,
    );
    const speechCatalog = readJson(rootDirectory, SPEECH_DELIVERY_PATH);
    invariant([1, 2].includes(speechCatalog.schemaVersion), 'Speech delivery catalog must use schemaVersion 1 or 2');
    assertDeliveryEntries(
      speechCatalog.platforms && speechCatalog.platforms[platformKey],
      'backends',
      SPEECH_BACKEND_IDS,
      `Speech delivery catalog ${platformKey}`,
      (backend) => ({
        requireModel: backend === 'f5-tts' || backend === 'chatterbox',
        requireSourceUrl: true,
      }),
    );
    const commands = speechCatalog.commands;
    invariant(commands && typeof commands === 'object', 'Speech delivery catalog must declare install coordination commands');
    for (const key of ['status', 'install', 'remove']) {
      invariant(typeof commands[key] === 'string', `Speech delivery catalog commands.${key} is missing`);
      assertCommandWiring(rootDirectory, commands[key]);
    }
  } catch (error) {
    failures.push(error.message);
  }

  invariant(
    failures.length === 0,
    `Managed engine delivery has ${failures.length} blocking violation(s): ${failures.join('; ')}`,
  );
}

const LOCAL_SERVICE_ENDPOINT = /(?:https?|wss?):\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){0,3}|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::(?:\d+|\$\{[^}]+}))?(?=[/?#'"`\s),;]|$)/i;

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  let quote = null;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '/' && next === '/') {
      const newline = source.indexOf('\n', index + 2);
      if (newline === -1) return -1;
      index = newline;
      continue;
    }
    if (character === '/' && next === '*') {
      const closing = source.indexOf('*/', index + 2);
      if (closing === -1) return -1;
      index = closing + 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function importsReviewedBrowserOnlyGuard(source, sourcePath, guardPath) {
  const guardImports = /import\s*\{[^}]*\bguardBrowserOnlyServiceOrigin\b[^}]*}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(guardImports)) {
    const moduleSpecifier = match[1];
    if (!moduleSpecifier.startsWith('.')) continue;
    const resolved = path.resolve(path.dirname(sourcePath), moduleSpecifier);
    const resolvedWithExtension = path.extname(resolved) ? resolved : `${resolved}.js`;
    if (path.normalize(resolvedWithExtension) === path.normalize(guardPath)) return true;
  }
  return false;
}

function maskGuardedBrowserServiceOrigins(source, sourcePath, guardPath) {
  if (!importsReviewedBrowserOnlyGuard(source, sourcePath, guardPath)) return source;

  const masked = [...source];
  const functionName = 'guardBrowserOnlyServiceOrigin';
  let cursor = 0;
  while (cursor < source.length) {
    const callStart = source.indexOf(functionName, cursor);
    if (callStart === -1) break;
    let opening = callStart + functionName.length;
    while (/\s/.test(source[opening] || '')) opening += 1;
    if (source[opening] !== '(') {
      cursor = opening;
      continue;
    }
    const closing = findClosingParenthesis(source, opening);
    if (closing === -1) break;
    const invocation = source.slice(callStart, closing + 1);
    if (LOCAL_SERVICE_ENDPOINT.test(invocation) && !/\bnativeRuntime\b/.test(invocation)) {
      for (let index = callStart; index <= closing; index += 1) masked[index] = ' ';
    }
    cursor = closing + 1;
  }
  return masked.join('');
}

function assertNoUnmanagedLocalServices(rootDirectory) {
  const reviewedGuardPath = path.join(rootDirectory, 'src/platform/browserOnlyService.js');
  const offenders = walkFiles(
    path.join(rootDirectory, 'src'),
    (candidate) => /\.(?:js|jsx|ts|tsx)$/.test(candidate) &&
      !/\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/.test(candidate),
    new Set(['__fixtures__', '__mocks__']),
  ).filter((candidate) => LOCAL_SERVICE_ENDPOINT.test(maskGuardedBrowserServiceOrigins(
    fs.readFileSync(candidate, 'utf8'),
    candidate,
    reviewedGuardPath,
  )));
  const displayed = offenders
    .slice(0, 12)
    .map((candidate) => path.relative(rootDirectory, candidate).replaceAll('\\', '/'));
  const omitted = offenders.length - displayed.length;
  invariant(
    offenders.length === 0,
    `Production frontend still contains unmanaged loopback service endpoints in ${offenders.length} file(s): ${displayed.join(', ')}${
      omitted > 0 ? `, and ${omitted} more` : ''
    }; migrate runtime I/O to native IPC or host-issued opaque media capabilities before release`,
  );
}

function assertNoMissingNativeCapabilities(rootDirectory) {
  const audit = assertLoopbackAuditManifest(rootDirectory);
  const blockers = audit.missingCapabilities.map((capability) => (
    `${capability.id} [${capability.sources.join(', ')}]: ${capability.requiredContract}`
  ));
  invariant(
    blockers.length === 0,
    `Production desktop still has ${blockers.length} missing native capability contract(s): ${blockers.join('; ')}`,
  );
}

function checkCompileReadiness(rootDirectory = REPOSITORY_ROOT) {
  const pins = assertPinnedToolchains(rootDirectory);
  assertLockfiles(rootDirectory);
  assertWorkflow(rootDirectory);
  const mappings = assertTauriConfiguration(rootDirectory);
  assertTauriProductionBuildContract(rootDirectory);
  assertNativeToolDelivery(rootDirectory, mappings);
  assertLoopbackAuditManifest(rootDirectory);
  return { ...pins, resourceCount: mappings.length };
}

function assertEffectiveToolchain(pins, actual) {
  invariant(
    actual.nodeVersion === pins.nodeVersion,
    `Effective Node is ${actual.nodeVersion}; expected pinned ${pins.nodeVersion}`,
  );
  const expectedNpm = pins.packageManager.replace(/^npm@/, '');
  invariant(
    actual.npmVersion === expectedNpm,
    `Effective npm is ${actual.npmVersion}; expected pinned ${expectedNpm}`,
  );
  invariant(
    actual.pythonVersion === pins.pythonVersion,
    `Effective Python is ${actual.pythonVersion}; expected pinned ${pins.pythonVersion}`,
  );
  invariant(
    actual.rustVersion === pins.rustVersion,
    `Effective rustc is ${actual.rustVersion}; expected pinned ${pins.rustVersion}`,
  );
}

function commandOutput(command, arguments_) {
  let executable = command;
  let effectiveArguments = arguments_;
  if (command === 'npm') {
    const nodeDirectory = path.dirname(process.execPath);
    const candidates = [
      process.env.npm_execpath,
      path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].filter(Boolean);
    const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
    invariant(npmCli, 'Could not locate npm-cli.js beside the active Node installation');
    executable = process.execPath;
    effectiveArguments = [npmCli, ...arguments_];
  }
  const result = childProcess.spawnSync(executable, effectiveArguments, {
    encoding: 'utf8',
    windowsHide: true,
  });
  invariant(!result.error, `Could not run ${command}: ${result.error && result.error.message}`);
  invariant(result.status === 0, `${command} failed while checking its effective version`);
  return (result.stdout || result.stderr).trim();
}

function checkHostToolchain(rootDirectory = REPOSITORY_ROOT) {
  const pins = assertPinnedToolchains(rootDirectory);
  const pythonOutput = commandOutput('python', ['--version']);
  const pythonMatch = pythonOutput.match(/^Python\s+(\d+\.\d+\.\d+)\b/);
  invariant(pythonMatch, `Could not parse Python version output: ${JSON.stringify(pythonOutput)}`);
  const rustOutput = commandOutput('rustc', ['--version']);
  const rustMatch = rustOutput.match(/^rustc\s+(\d+\.\d+\.\d+)\b/);
  invariant(rustMatch, `Could not parse rustc version output: ${JSON.stringify(rustOutput)}`);
  const actual = {
    nodeVersion: process.versions.node,
    npmVersion: commandOutput('npm', ['--version']),
    pythonVersion: pythonMatch[1],
    rustVersion: rustMatch[1],
  };
  assertEffectiveToolchain(pins, actual);
  return actual;
}

function checkRuntimePackageReadiness(rootDirectory, target) {
  invariant(target, 'Runtime-package readiness requires --target <Rust target triple>');
  const mappings = collectResourceMappings(rootDirectory, target);
  const failures = [];
  for (const check of [
    () => assertTauriProductionBuildContract(rootDirectory),
    () => assertWorkerResources(rootDirectory, mappings),
    () => assertNativeToolDelivery(rootDirectory, mappings),
    () => assertRequiredMediaToolDelivery(rootDirectory, target),
    () => assertRenderRuntimeDelivery(rootDirectory, target, mappings),
    () => assertManagedEngineDelivery(rootDirectory, target),
    () => assertUpdaterReleaseConfiguration(rootDirectory),
    () => assertRepositoryReleasePolicy(rootDirectory),
    () => assertNoUnmanagedLocalServices(rootDirectory),
    () => assertNoMissingNativeCapabilities(rootDirectory),
  ]) {
    try {
      check();
    } catch (error) {
      failures.push(error.message);
    }
  }
  invariant(
    failures.length === 0,
    `Runtime package has ${failures.length} blocking violation(s): ${failures.join('; ')}`,
  );
  return { resourceCount: mappings.length, target };
}

function parseArguments(arguments_) {
  let profile = 'compile';
  let target;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--profile') {
      profile = arguments_[index + 1];
      index += 1;
    } else if (argument === '--target') {
      target = arguments_[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }
  invariant(
    ['compile', 'host-toolchain', 'runtime-package'].includes(profile),
    `Unsupported readiness profile ${JSON.stringify(profile)}`,
  );
  return { profile, target };
}

function main() {
  const { profile, target } = parseArguments(process.argv.slice(2));
  if (profile === 'compile') {
    const report = checkCompileReadiness();
    console.log(
      `Compile readiness passed: Node ${report.nodeVersion}, ${report.packageManager}, Rust ${report.rustVersion}, Tauri CLI ${report.tauriCliVersion}, ${report.resourceCount} runtime resources.`,
    );
    return;
  }
  if (profile === 'host-toolchain') {
    const report = checkHostToolchain();
    console.log(
      `Effective toolchain passed: Node ${report.nodeVersion}, npm ${report.npmVersion}, Python ${report.pythonVersion}, Rust ${report.rustVersion}.`,
    );
    return;
  }
  const report = checkRuntimePackageReadiness(REPOSITORY_ROOT, target);
  console.log(`Runtime-package readiness passed for ${report.target}: ${report.resourceCount} validated resources.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    const profile = process.argv.includes('runtime-package')
      ? 'Runtime-package'
      : process.argv.includes('host-toolchain')
        ? 'Host-toolchain'
        : 'Compile';
    console.error(`${profile} readiness failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ACTION_PINS,
  RELEASE_MATRIX,
  TARGETS,
  assertPinnedActions,
  assertLockfiles,
  assertPinnedToolchains,
  assertProductionCsp,
  assertEffectiveToolchain,
  assertNativeToolDelivery,
  assertRequiredMediaToolDelivery,
  assertRepositoryReleasePolicy,
  assertRenderRuntimeDelivery,
  assertManagedEngineDelivery,
  assertUpdaterReleaseConfiguration,
  assertTauriProductionBuildContract,
  assertLoopbackAuditManifest,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
  assertInstalledSmokeScript,
  assertCiUpdaterFixtureHandoffSource,
  assertCiUpdaterFixtureDebugPortSource,
  assertUpdaterFixtureSource,
  assertUpdaterSmokeWorkflow,
  assertSignedUpdaterScript,
  assertTauriNsisBootstrapScript,
  assertWorkerResources,
  assertWorkflowCommands,
  assertWorkflowMatrix,
  checkCompileReadiness,
  checkHostToolchain,
  checkRuntimePackageReadiness,
  collectEmbeddedWorkers,
  collectPromptDjFontReleasePolicyFailures,
  collectResourceMappings,
  normalizeDestination,
  parseArguments,
  platformConfigName,
  sha256File,
};
