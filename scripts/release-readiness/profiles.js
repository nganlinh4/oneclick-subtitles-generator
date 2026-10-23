'use strict';

// The three readiness profiles: `compile` (source/repository invariants), `host-toolchain`
// (effective tool versions), and the stricter target-specific `runtime-package`.

const { REPOSITORY_ROOT, invariant } = require('./shared');
const { assertManagedEngineDelivery } = require('./engine-delivery');
const { assertHarnessSeamsAreCompiledOut } = require('./harness-seams');
const { assertNoLegacyRendererResidue } = require('./legacy-residue');
const { assertRepositoryReleasePolicy } = require('./licensing');
const {
  assertLoopbackAuditManifest,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
} = require('./loopback-transport');
const { assertNativeToolDelivery, assertRequiredMediaToolDelivery } = require('./native-tools');
const {
  assertTauriConfiguration,
  assertTauriProductionBuildContract,
  assertWorkerResources,
  collectResourceMappings,
} = require('./tauri-config');
const { assertLockfiles, assertPinnedToolchains } = require('./toolchains');
const { assertUpdaterFixtureIsolation, assertUpdaterReleaseConfiguration } = require('./updater');
const { assertWorkflow } = require('./workflows');

const PROFILES = Object.freeze(['compile', 'host-toolchain', 'runtime-package']);

function checkCompileReadiness(rootDirectory = REPOSITORY_ROOT) {
  const pins = assertPinnedToolchains(rootDirectory);
  assertLockfiles(rootDirectory);
  assertWorkflow(rootDirectory);
  invariant(assertHarnessSeamsAreCompiledOut(rootDirectory) > 0,
    'The harness seam guard found nothing to check');
  assertUpdaterFixtureIsolation(rootDirectory);
  const mappings = assertTauriConfiguration(rootDirectory);
  assertTauriProductionBuildContract(rootDirectory);
  assertNativeToolDelivery(rootDirectory, mappings);
  assertLoopbackAuditManifest(rootDirectory);
  assertNoLegacyRendererResidue(rootDirectory);
  return { ...pins, resourceCount: mappings.length };
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
  invariant(PROFILES.includes(profile), `Unsupported readiness profile ${JSON.stringify(profile)}`);
  return { profile, target };
}

module.exports = {
  checkCompileReadiness,
  checkRuntimePackageReadiness,
  parseArguments,
};
