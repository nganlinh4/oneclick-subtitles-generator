'use strict';

// Pinned Node/npm/Python/Rust/Tauri toolchains, the reviewed React pair, and locked dependency graphs.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  EXACT_VERSION,
  REPOSITORY_ROOT,
  extractTomlSection,
  extractTomlString,
  invariant,
  readJson,
  readText,
  toRepositoryPath,
  walkFiles,
} = require('./shared');

const PYTHON_VERSION = '3.12.10';
const REACT_VERSION = '18.3.1';
const SEVEN_ZIP_PACKAGE = '7zip-bin-full';
const SEVEN_ZIP_VERSION = '26.2.1';
const SEVEN_ZIP_RESOLVED =
  'https://registry.npmjs.org/7zip-bin-full/-/7zip-bin-full-26.2.1.tgz';
const SEVEN_ZIP_INTEGRITY =
  'sha512-h1DE4G8WEJ3/LI4HTcuOpouP7cy9JGqYfZm5fzLhdzw8jI3wFyA9RFu5MP+ICzelKEYmWweRWApEvVWKmJIdVQ==';

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
  const promptDjPackage = readJson(rootDirectory, 'promptdj-midi/package.json');
  for (const [relativePath, packageManifest] of [
    ['package.json', rootPackage],
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

function isSha512Integrity(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  return Buffer.from(value.slice('sha512-'.length), 'base64').length === 64;
}

function assertLockfiles(rootDirectory = REPOSITORY_ROOT) {
  // `.claude` holds agent scratch state and transient git worktrees, which carry their own copies
  // of every lockfile. Walking into it made this gate's verdict depend on whether an unrelated
  // worktree happened to exist at that moment: the same commit passed alone and failed while a
  // parallel lane was open. A release gate must describe the repository, not its neighbours.
  const ignoredLockDirectories = new Set(['.git', '.claude', 'node_modules', 'target']);
  const npmLocks = walkFiles(
    rootDirectory,
    (candidate) => path.basename(candidate) === 'package-lock.json',
    ignoredLockDirectories,
  ).map((candidate) => toRepositoryPath(rootDirectory, candidate)).sort();
  // `e2e` is a test harness, not part of any shipped artefact: it drives the built binary from
  // outside and nothing in the bundle resolves against it. It is listed so an unexpected FOURTH
  // lockfile still fails, which is the point of pinning the set.
  invariant(
    JSON.stringify(npmLocks) === JSON.stringify([
      'apps/desktop/package-lock.json',
      'e2e/package-lock.json',
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
  for (const workspacePath of ['promptdj-midi']) {
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
  ).map((candidate) => toRepositoryPath(rootDirectory, candidate)).sort();
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
    .map((candidate) => toRepositoryPath(rootDirectory, candidate));
  invariant(
    nestedLocks.length === 0,
    `Workspace members must use the root Cargo.lock; remove: ${nestedLocks.join(', ')}`,
  );
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

module.exports = {
  PYTHON_VERSION,
  assertEffectiveToolchain,
  assertLockfiles,
  assertPinnedToolchains,
  checkHostToolchain,
};
