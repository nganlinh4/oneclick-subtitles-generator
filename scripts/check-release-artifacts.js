#!/usr/bin/env node

// Validate built native release artifacts: layout, magic, architecture, packaged resources, and the
// updater signature. The per-format checks live in scripts/release-artifacts/.

const fs = require('node:fs');
const path = require('node:path');

const { REPOSITORY_ROOT, TARGETS } = require('./release-readiness/shared');
const { collectResourceMappings } = require('./release-readiness/tauri-config');
const {
  applicationBinaryBaseName,
  assertArtifactArchitecture,
  assertArtifactMagic,
  assertLinuxMainExecutableArchitecture,
  assertWindowsMainExecutableArchitecture,
  readElfArchitecture,
  readMachCpuTypes,
  readPeMachine,
  walkRegularFiles,
} = require('./release-artifacts/binary-format');
const { BUNDLE_LAYOUTS, TARGET_BUNDLES, invariant } = require('./release-artifacts/bundles');
const {
  assertExactResourceCopies,
  assertResourceCopiesBySuffix,
  assertSevenZipFormatSupport,
  inspectAppImagePackage,
  inspectDebianPackage,
  inspectDmgPackage,
  inspectMacApplication,
  inspectNsisPackage,
  pathEndsWith,
} = require('./release-artifacts/package-inspection');
const {
  assertUpdaterSignature,
  assertUpdaterSignatureMode,
  verifyUpdaterSignature,
} = require('./release-artifacts/updater-signature');

function parseArguments(arguments_) {
  let target;
  let bundles;
  let targetDirectory = 'target';
  let allowUnsigned = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--target') {
      target = arguments_[index + 1];
      index += 1;
    } else if (argument === '--bundles') {
      bundles = arguments_[index + 1];
      index += 1;
    } else if (argument === '--target-dir') {
      targetDirectory = arguments_[index + 1];
      index += 1;
    } else if (argument === '--allow-unsigned-branch-build') {
      allowUnsigned = true;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}`);
    }
  }

  invariant(target && TARGETS[target], 'Artifact validation requires a supported --target triple');
  invariant(typeof bundles === 'string' && bundles.trim(), 'Artifact validation requires --bundles');
  invariant(typeof targetDirectory === 'string' && targetDirectory.trim(), '--target-dir must be non-empty');
  const bundleNames = bundles
    .split(/[\s,]+/)
    .map((bundle) => bundle.toLowerCase())
    .filter(Boolean);
  invariant(bundleNames.length > 0, '--bundles must contain at least one bundle type');
  invariant(new Set(bundleNames).size === bundleNames.length, '--bundles may not contain duplicates');
  const supportedBundles = TARGET_BUNDLES[target];
  for (const bundle of bundleNames) {
    invariant(BUNDLE_LAYOUTS[bundle], `Unsupported bundle type ${JSON.stringify(bundle)}`);
    invariant(supportedBundles.has(bundle), `${bundle} is not a native bundle for ${target}`);
  }
  return { allowUnsigned, bundleNames, target, targetDirectory };
}

function listMatchingArtifacts(bundleRoot, bundleName) {
  const layout = BUNDLE_LAYOUTS[bundleName];
  const directory = path.join(bundleRoot, layout.directory);
  invariant(fs.existsSync(directory), `Tauri did not create ${path.relative(REPOSITORY_ROOT, directory)}`);
  const artifacts = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.toLowerCase().endsWith(layout.extension.toLowerCase()))
    .filter((entry) => (layout.kind === 'file' ? entry.isFile() : entry.isDirectory()))
    .map((entry) => path.join(directory, entry.name));
  invariant(artifacts.length > 0, `Tauri did not create a ${bundleName} artifact in ${directory}`);
  return artifacts;
}

function assertSafeArtifact(artifact, kind, target) {
  const metadata = fs.lstatSync(artifact);
  invariant(!metadata.isSymbolicLink(), `Release artifact may not be a symlink: ${artifact}`);
  if (kind === 'file') {
    invariant(metadata.isFile() && metadata.size > 0, `Release artifact is empty or invalid: ${artifact}`);
    assertArtifactMagic(artifact, metadata.size);
    assertArtifactArchitecture(artifact, target);
    if (path.extname(artifact).toLowerCase() === '.appimage' && process.platform !== 'win32') {
      invariant((metadata.mode & 0o111) !== 0, `AppImage is not executable: ${artifact}`);
    }
    return;
  }
  invariant(metadata.isDirectory(), `Release application bundle is invalid: ${artifact}`);
  const files = walkRegularFiles(artifact);
  invariant(files.length > 0, `Release application bundle is empty: ${artifact}`);
}


function validateReleaseArtifacts({
  allowUnsigned = false,
  rootDirectory = REPOSITORY_ROOT,
  target,
  bundleNames,
  targetDirectory = 'target',
}) {
  invariant(TARGETS[target], `Unsupported release target ${JSON.stringify(target)}`);
  const bundleRoot = path.resolve(rootDirectory, targetDirectory, target, 'release', 'bundle');
  const relativeBundleRoot = path.relative(rootDirectory, bundleRoot);
  invariant(
    relativeBundleRoot && !relativeBundleRoot.startsWith('..') && !path.isAbsolute(relativeBundleRoot),
    'The artifact target directory must stay inside the repository',
  );
  const mappings = collectResourceMappings(rootDirectory, target);
  let artifactCount = 0;
  for (const bundleName of bundleNames) {
    invariant(TARGET_BUNDLES[target].has(bundleName), `${bundleName} is not a native bundle for ${target}`);
    const layout = BUNDLE_LAYOUTS[bundleName];
    const artifacts = listMatchingArtifacts(bundleRoot, bundleName);
    artifactCount += artifacts.length;
    for (const artifact of artifacts) {
      assertSafeArtifact(artifact, layout.kind, target);
      if (bundleName === 'app') {
        inspectMacApplication(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'deb') {
        inspectDebianPackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'appimage') {
        inspectAppImagePackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'dmg') {
        inspectDmgPackage(artifact, mappings, target, rootDirectory);
      } else if (bundleName === 'nsis') {
        inspectNsisPackage(artifact, mappings, target, rootDirectory);
        assertUpdaterSignatureMode(artifact, { allowUnsigned, rootDirectory });
      }
    }
  }
  return { artifactCount, bundleRoot, resourceCount: mappings.length };
}

function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  const report = validateReleaseArtifacts(arguments_);
  console.log(
    `Release artifacts passed for ${arguments_.target}: ${report.artifactCount} artifacts, ${report.resourceCount} packaged resources.`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Release artifact validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  BUNDLE_LAYOUTS,
  TARGET_BUNDLES,
  applicationBinaryBaseName,
  assertLinuxMainExecutableArchitecture,
  assertArtifactMagic,
  assertArtifactArchitecture,
  assertUpdaterSignatureMode,
  assertUpdaterSignature,
  assertExactResourceCopies,
  assertResourceCopiesBySuffix,
  assertSafeArtifact,
  assertSevenZipFormatSupport,
  assertWindowsMainExecutableArchitecture,
  inspectAppImagePackage,
  inspectDmgPackage,
  inspectMacApplication,
  inspectNsisPackage,
  parseArguments,
  pathEndsWith,
  readElfArchitecture,
  readMachCpuTypes,
  readPeMachine,
  validateReleaseArtifacts,
  verifyUpdaterSignature,
};
