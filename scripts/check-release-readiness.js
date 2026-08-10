#!/usr/bin/env node

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = '.github/workflows/rewrite-ci.yml';
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
const DISTRIBUTABLE_FONT_EXTENSION = /\.(?:eot|otf|ttf|woff2?)$/i;

const ACTION_PINS = Object.freeze({
  'actions/checkout': 'de0fac2e4500dabe0009e67214ff5f5447ce83dd',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/setup-python': 'a309ff8b426b58ec0e2a45f0f869d46889d02405',
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

function assertWorkflowToolchainPins(workflow) {
  const checkout = `actions/checkout@${ACTION_PINS['actions/checkout']}`;
  const setupNode = `actions/setup-node@${ACTION_PINS['actions/setup-node']}`;
  const setupPython = `actions/setup-python@${ACTION_PINS['actions/setup-python']}`;
  for (const jobName of ['invariants', 'native-matrix']) {
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
    'npm ci --ignore-scripts',
    'npm --prefix apps/desktop ci --ignore-scripts',
    'rustup target add "${{ matrix.rust-target }}"',
    'cargo fetch --locked --target "${{ matrix.rust-target }}"',
    'cargo clippy --workspace --all-targets --all-features --locked --target "${{ matrix.rust-target }}" -- -D warnings',
    'cargo test --workspace --all-features --locked --target "${{ matrix.rust-target }}"',
    'node scripts/check-release-readiness.js --profile compile',
    'node scripts/check-release-readiness.js --profile host-toolchain',
    'node scripts/check-release-readiness.js --profile runtime-package --target "${{ matrix.rust-target }}"',
    'node scripts/check-release-artifacts.js --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
    'node --test scripts/frozen-css-compatibility.test.mjs scripts/check-frozen-css-output.test.mjs',
    'npm run build:frontend',
    'node scripts/check-frozen-css-output.mjs',
    'build --no-bundle --ci --target "${{ matrix.rust-target }}" -- --locked',
    'bundle --ci --no-sign --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
  ];
  for (const fragment of requiredFragments) {
    invariant(workflow.includes(fragment), `The workflow is missing required locked gate: ${fragment}`);
  }
  assertWorkflowToolchainPins(workflow);

  for (const manualCommand of [
    'node scripts/check-release-readiness.js --profile runtime-package --target "${{ matrix.rust-target }}"',
    'npm --prefix apps/desktop run tauri -- bundle --ci --no-sign --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
    'node scripts/check-release-artifacts.js --target "${{ matrix.rust-target }}" --bundles "${{ matrix.bundles }}"',
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
  invariant(!/\$\{\{\s*secrets\./i.test(workflow), 'Unsigned CI must not depend on repository secrets');
  invariant(
    !/(?:TAURI_SIGNING_PRIVATE_KEY|APPLE_CERTIFICATE|APPLE_SIGNING_IDENTITY|CSC_LINK|WIN_CSC_LINK|WINDOWS_CERTIFICATE)/i.test(workflow),
    'Unsigned CI must not configure code-signing credentials',
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

function assertWorkflow(rootDirectory = REPOSITORY_ROOT) {
  const workflow = readText(rootDirectory, WORKFLOW_PATH);
  assertPinnedActions(workflow);
  assertWorkflowMatrix(workflow);
  assertWorkflowCommands(workflow);
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
  invariant(release.distributionMode === 'direct-upstream-download-only',
    `${label} must remain direct-upstream-download-only`);

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
  invariant(delivery.policy && delivery.policy.artifactDelivery === 'direct-upstream-download-only',
    'Native-tool delivery must remain direct-upstream-download-only');
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
  invariant(mediaTools.license === 'GPL-2.0-or-later',
    'Media-tool delivery must declare its GPL license floor');
  invariant(audit.ffmpeg && audit.ffmpeg.requiredEncoder === 'libx264'
    && audit.ffmpeg.deliveryEnabled === false,
  'Native-tool audit must keep the required libx264 FFmpeg delivery disabled');
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
    invariant(platform.releases.length === 0,
      `Media-tool delivery for ${target} must remain disabled until its audit is replaced`);
    invariant(typeof platform.blocker === 'string' && platform.blocker.length >= 40,
      `Media-tool delivery for ${target} needs an exact blocker`);
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
  const productSansFiles = fontFiles.filter((relativePath) =>
    /(?:^|\/)Product Sans(?: [^/]*)?\.(?:otf|ttf|woff2?)$/i.test(relativePath));
  if (productSansFiles.length > 0) {
    failures.push(
      `PromptDJ bundles proprietary Product Sans font assets without reviewed redistribution authorization: ${productSansFiles.join(', ')}`,
    );
  }

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
  invariant(asset.endsWith('.zip'), `${label}.asset must be a content-addressed zip archive`);
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
  const rustSources = walkFiles(
    path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
    (candidate) => candidate.endsWith('.rs'),
  );
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
  const rustSources = walkFiles(
    path.join(rootDirectory, TAURI_DIRECTORY, 'src'),
    (candidate) => candidate.endsWith('.rs'),
  );
  invariant(
    rustSources.some((sourcePath) =>
      /include_(?:str|bytes)!\s*\(\s*["'][^"']*remotion-runtime\.delivery\.json["']\s*\)/
        .test(fs.readFileSync(sourcePath, 'utf8')),
    ),
    'Managed Remotion installer must compile-bind remotion-runtime.delivery.json',
  );
}

function assertRenderRuntimeDelivery(rootDirectory, target, resourceMappings) {
  const catalog = readJson(rootDirectory, RENDER_DELIVERY_PATH);
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
    invariant(asrCatalog.schemaVersion === 1, 'ASR delivery catalog must use schemaVersion 1');
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
    invariant(speechCatalog.schemaVersion === 1, 'Speech delivery catalog must use schemaVersion 1');
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
  assertLoopbackAuditManifest,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
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
