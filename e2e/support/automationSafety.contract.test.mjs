// Launch routes and the canonical nonshipping E2E build.

import assert from 'node:assert/strict';
import test from 'node:test';

import { read, readSplitModule } from './repositorySources.js';

const CANONICAL_E2E_FRONTEND_BUILD = 'node scripts/build-e2e-frontend.js';
const CANONICAL_E2E_BUILD = 'node scripts/build-e2e-binary.js';

const assertFreshFrontendBeforeCargo = (build, source = read('scripts', 'build-e2e-binary.js')) => {
  assert.equal(build, CANONICAL_E2E_BUILD, (
    'the canonical E2E binary must use the exact frontend-then-Cargo command chain'
  ));
  const lease = source.indexOf('lease = acquireE2eLease(');
  const frontend = source.indexOf('const frontend = buildFrontend(', lease);
  const cargo = source.indexOf("command: 'cargo'", frontend);
  const publication = source.indexOf('const published = publishApplication(', cargo);
  const verification = source.indexOf('const application = verifyApplication(', publication);
  const release = source.indexOf('releaseE2eLease(', verification);
  assert.ok(
    lease >= 0
      && frontend > lease
      && cargo > frontend
      && publication > cargo
      && verification > publication
      && release > verification,
    'the canonical E2E binary must lease, build frontend, build Cargo, publish, verify, then release',
  );
  assert.match(source, /TAURI_CONFIG:\s*tauriOverride/u);
  // frontendDist must go through the shared override helper: Tauri parses an absolute Windows
  // path as a URL, which embeds nothing, so only the validated relative form is acceptable.
  assert.match(
    source,
    /frontendDist:\s*tauriFrontendDistOverride\(repository,\s*frontend\.snapshotRoot\)/u,
  );
  assert.match(source, /cacheRoot:\s*lease\.frontendCacheRoot/u);
  assert.match(source, /'--target-dir',\s*cargoTargetDir/u);
  assert.match(source, /applicationsCacheRoot:\s*lease\.appPublicationRoot/u);
  assert.match(source, /readAndVerifyE2eApplicationReceipt/u);
  assert.doesNotMatch(source, /target[/\\]e2e-automation/u);
};

const assertStableE2eFrontendBuild = (build, source = read('scripts', 'build-e2e-frontend.js')) => {
  assert.equal(build, CANONICAL_E2E_FRONTEND_BUILD, (
    'the E2E frontend must use the exact reproducible-metadata-then-Vite command chain'
  ));
  assert.match(source, /collectStrictReproducibleGitInfo/u);
  assert.match(source, /publishFrontendSnapshot/u);
  assert.match(source, /OSG_E2E_VERSION_MODULE/u);
  assert.doesNotMatch(source, /syncTreeContent|src[/\\]config[/\\]version\.js/u);
};

const assertCanonicalApplicationBinarySource = (source) => {
  assert.match(
    source,
    /export const E2E_APPLICATIONS_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e'\);/u,
  );
  assert.match(source, /readAndVerifyE2eApplicationReceipt\(\{\s*applicationsCacheRoot: E2E_APPLICATIONS_CACHE_ROOT,\s*\}\)/su);
  assert.match(source, /export const BUILT_APPLICATION_DIRECTORY = publicationAtModuleLoad\?\.applicationRoot[\s\S]*?UNPUBLISHED_APPLICATION_DIRECTORY/u);
  assert.match(source, /export const APPLICATION_BINARY = stagedApplicationOverride[\s\S]*?publicationAtModuleLoad\?\.binaryPath[\s\S]*?BUILT_APPLICATION_DIRECTORY/u);
  assert.match(source, /const current = readVerifiedCurrentPublishedApplication\(\);/u);
  assert.match(source, /readCleanGitSourceProvenance/u);
  assert.match(source, /source\.commit !== currentSource\.commit/u);
  assert.match(source, /source\.tree !== currentSource\.tree/u);
  assert.match(source, /assertApplicationLaunchSource\(binary\);/u);
  assert.match(source, /assertStagedApplicationBinary\(stagedApplicationOverride\)/u);
  assert.doesNotMatch(
    source,
    /REPOSITORY_ROOT[\s\S]{0,120}'target'[\s\S]{0,120}'e2e-automation'/u,
    'the hidden harness must not retain a repository-target binary fallback',
  );
};
test('every active E2E launch route reaches the guarded embedded-driver configuration', () => {
  const package_ = JSON.parse(read('e2e', 'package.json'));
  const rootPackage = JSON.parse(read('package.json'));
  const desktopPackage = JSON.parse(read('apps', 'desktop', 'package.json'));
  const scripts = Object.entries(package_.scripts);
  for (const [name, command] of [
    ...Object.entries(rootPackage.scripts),
    ...Object.entries(desktopPackage.scripts),
  ]) {
    assert.doesNotMatch(
      command,
      /test-installed-windows|test-signed-updater-windows|test-native-picker-evidence/u,
      `${name} exposes a CI-only interactive desktop smoke as a local package command`,
    );
  }
  for (const [name, command] of scripts) {
    assert.doesNotMatch(
      command,
      /diagnostics[\\/]direct-driver/u,
      `${name} resurrects the retired external-driver harness`,
    );
    assert.doesNotMatch(
      command,
      /\bwdio\s+run\b/u,
      `${name} bypasses the leased isolated parent runner`,
    );
  }
  assert.equal('probe:restore' in package_.scripts, false,
    'a stale nonexistent restore probe remained an advertised launch route');
  const defaultBuild = package_.scripts.test.indexOf('node ../scripts/build-e2e-binary.js');
  const defaultJourney = package_.scripts.test.indexOf(
    'node run-isolated.mjs journeys/startup.journey.js',
  );
  assert.ok(
    defaultBuild >= 0 && defaultJourney > defaultBuild,
    'the default real-binary test must publish an exact managed application before launching journeys',
  );

  const config = read('e2e', 'wdio.conf.js');
  assert.equal(
    config.match(/^\s*driverProvider:\s*'embedded'/gmu)?.length ?? 0,
    2,
    'both the launcher and worker must select the embedded provider',
  );
  assert.match(
    config,
    /'tauri:options':\s*\{[\s\S]*?driverProvider:\s*'embedded'[\s\S]*?\},\s*'wdio:tauriServiceOptions'/u,
  );
  assert.match(
    config,
    /'wdio:tauriServiceOptions':\s*\{[\s\S]*?driverProvider:\s*'embedded'[\s\S]*?embeddedPort:/u,
  );
  assert.match(config, /assertAutomationDialogGuard\(APPLICATION_BINARY\)/u);
  const receiptVerification = config.indexOf('readInheritedApplicationLease({');
  const leasedVerification = config.indexOf(
    'assertAutomationDialogGuard(APPLICATION_BINARY)',
    receiptVerification,
  );
  const applicationCapability = config.indexOf('application: APPLICATION_BINARY');
  assert.ok(
    receiptVerification >= 0
      && leasedVerification > receiptVerification
      && applicationCapability > leasedVerification,
    'the child must validate inherited immutable provenance before the service can spawn',
  );
  assert.match(config, /leasedPublication\.binaryPath, APPLICATION_BINARY/u);
  assert.match(config, /leasedPublication\.applicationRoot, BUILT_APPLICATION_DIRECTORY/u);
  assert.match(config, /basename\(leasedPublication\.applicationRoot\) !== leasedPublication\.applicationHash/u);
  assert.match(
    config,
    /readInheritedApplicationLease/u,
    'workers and private damaged-install copies must validate the outer-owned publication lease',
  );
  assert.doesNotMatch(
    config,
    /cachedRealVideo|cachedSourceSwitchVideo|verifiedLongSyntheticMedia|copyFileSync/u,
    'every WDIO config load, including damaged-install runs, must remain persistent-cache read-only',
  );
  assert.match(config, /process\.env\.OSG_E2E_MEDIA_SELECTION \?\? null/u);
  assert.match(
    config,
    /onComplete:[\s\S]*?downloadFixtureOrigin\.close\(\)/u,
    'launcher-owned network resources must remain live through session teardown',
  );
  assert.match(config, /Object\.assign\(process\.env,\s*isolationEnvironment\(runRoot\)\)/u);
  assert.match(config, /await waitForAutomationWindowIsolation\(\)/u);
  assert.match(
    config,
    /if \(!canReuseRunRoot\(\{ environment: process\.env, workerProcess: isWdioWorker \}\)\)[\s\S]*?throw new Error[\s\S]*?const runRoot = process\.env\.OSG_E2E_DATA_ROOT[\s\S]*?attachRunRootCaches\(\{ root: runRoot \}\)/u,
    'the child must refuse instead of creating an unleased run root',
  );

  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const maintenanceBatch = isolatedRunner.indexOf('createE2eCacheMaintenanceBatch()');
  const outerLease = isolatedRunner.indexOf('cacheMaintenance.withLeases(', maintenanceBatch);
  const outerVerify = isolatedRunner.indexOf('readVerifiedCurrentPublishedApplication()', outerLease);
  const supervisedLaunch = isolatedRunner.indexOf('runSupervisedSync({', outerVerify);
  const evidenceFinalization = isolatedRunner.indexOf('finalizeWorkflowEvidence({', supervisedLaunch);
  assert.ok(
    maintenanceBatch >= 0
      && outerLease > maintenanceBatch
      && outerVerify > outerLease
      && supervisedLaunch > outerVerify
      && evidenceFinalization > supervisedLaunch,
    'the batched runner must own app/staging/evidence leases through supervised WDIO and final evidence',
  );

  const multiProcessRunner = read('e2e', 'support', 'twoProcessScenario.js');
  assert.match(multiProcessRunner, /OSG_E2E_REUSE_ROOT:\s*'1'/u);
  assert.match(
    multiProcessRunner,
    /OSG_E2E_RUN_ROOT_AUTHORIZATION:\s*runRootAuthorization\(root\)/u,
  );

  for (const [runner, commandPattern] of [
    [isolatedRunner, /\[WDIO,\s*'run',\s*CONFIG,\s*'--spec'/u],
    [read('e2e', 'support', 'twoProcessScenario.js'), /\[WDIO,\s*'run',\s*'wdio\.conf\.js',\s*'--spec'/u],
    [read('e2e', 'scenarios', 'damagedFontPayload.mjs'), /\[WDIO,\s*'run',\s*'wdio\.conf\.js',\s*'--spec'/u],
  ]) {
    assert.match(runner, /runSupervisedSync\(\{/u, 'a child launch may outlive its lease owner');
    assert.match(runner, commandPattern, 'a child launch bypasses wdio.conf.js');
  }
  assert.match(
    read('e2e', 'scenarios', 'damagedFontPayload.mjs'),
    /withScenarioLeases\([\s\S]*?beginWorkflowEvidence\([\s\S]*?runSupervisedSync\([\s\S]*?finalizeWorkflowEvidence\(/u,
    'damaged-install app, staging, and evidence must remain leased through supervised finalization',
  );
  const twoProcessScenario = read('e2e', 'support', 'twoProcessScenario.js');
  assert.match(
    twoProcessScenario,
    /runScenarioAttemptWithEvidence[\s\S]*?resetWorkflowEvidence\(workflow, \{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?binaryPath: publication\.binaryPath[\s\S]*?withScenarioLeases[\s\S]*?runScenarioAttemptWithEvidence\(\{[\s\S]*?publication/u,
  );
  for (const [label, source, expected] of [
    ['two-process support', twoProcessScenario, 2],
    ['multi-window ASR', read('e2e', 'scenarios', 'multiWindowAsrPersistence.mjs'), 0],
    ['long-media recovery', read('e2e', 'scenarios', 'longMediaOperationRecovery.mjs'), 0],
  ]) {
    const resets = [...source.matchAll(/resetWorkflowEvidence\(workflow, \{([\s\S]*?)\}\)/gu)];
    assert.equal(resets.length, expected, `${label} has an unexpected evidence-reset surface`);
    for (const reset of resets) {
      assert.match(reset[1], /applicationHash: publication\.applicationHash/u, label);
      assert.match(reset[1], /binaryPath: publication\.binaryPath/u, label);
    }
  }
  assert.match(
    twoProcessScenario,
    /runScenarioAttemptWithEvidence[\s\S]*?resetWorkflowEvidence[\s\S]*?operation\(\)[\s\S]*?preserveRunRootEvidence[\s\S]*?finalizeWorkflowEvidence/u,
    'scenario evidence must begin before staging and preserve the root before finalization',
  );
  for (const file of ['multiWindowAsrPersistence.mjs', 'longMediaOperationRecovery.mjs']) {
    assert.match(
      read('e2e', 'scenarios', file),
      /runScenarioAttemptWithEvidence\(\{[\s\S]*?operation:\s*\(\)\s*=>[\s\S]*?copyFileSync/u,
      `${file} must begin its durable attempt before custom fixture staging`,
    );
  }
  assert.match(
    isolatedRunner,
    /beginWorkflowEvidence\(\{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?binaryPath: publication\.binaryPath/u,
  );
  const damagedFont = read('e2e', 'scenarios', 'damagedFontPayload.mjs');
  assert.match(
    damagedFont,
    /describeStagedApplicationDerivative\(\{[\s\S]*?expectedPath: damaged\.path,[\s\S]*?beginWorkflowEvidence\(\{[\s\S]*?applicationHash: publication\.applicationHash,[\s\S]*?applicationDerivative: derivative,[\s\S]*?binaryPath: binary/u,
  );
  for (const file of [
    'nativeToolsInstall.mjs',
    'settingsNarrationModelManagement.mjs',
    'settingsToolsRemoveAndFactoryReset.mjs',
    'multiWindowAsrPersistence.mjs',
    'longMediaOperationRecovery.mjs',
  ]) {
    const source = read('e2e', 'scenarios', file);
    const calls = [...source.matchAll(/runScenarioProcesses\(\{([\s\S]*?)\n\s*\}\);/gu)];
    assert.ok(calls.length > 0, `${file} has no supervised scenario call`);
    for (const call of calls) {
      assert.match(call[1], /\bpublication\b/u, `${file} dropped publication provenance`);
    }
  }

  const installedSmoke = read('scripts', 'test-installed-windows.ps1');
  const installerPackageReceipt = read('scripts', 'installer-package-receipt.js');
  const updaterSmoke = read('scripts', 'test-signed-updater-windows.ps1');
  assert.ok(
    installedSmoke.indexOf("if ($env:CI -ne 'true')")
      < installedSmoke.indexOf('Start-Process -FilePath $installer'),
    'the installed-app desktop smoke must refuse local execution before launching anything',
  );
  assert.match(installerPackageReceipt, /readCleanGitSourceProvenance\(\{ repositoryRoot \}\)/u);
  const installStart = installedSmoke.indexOf('$installed = Install-Application');
  const postInstallReceipt = installedSmoke.indexOf('if ($PublishPackageReceipt) {', installStart);
  const firstApplicationLaunch = installedSmoke.indexOf('$first = Start-And-WaitForReadiness');
  const preInstallConsumptionReceipt = installedSmoke.indexOf("} else {\n  $receiptJson = & node");
  const installerLaunch = installedSmoke.indexOf('Start-Process -FilePath $installer');
  const cleanPublicationOutputs = installedSmoke.indexOf(
    "throw 'Installer package receipt publication paths must be clean'",
  );
  const requiredSigningKey = installedSmoke.indexOf(
    "throw 'Installer package receipt publication requires the Tauri updater signing key'",
  );
  const postInstallReceiptFailure = installedSmoke.indexOf(
    "throw 'Installed application payload does not match the signed immutable installer package receipt'",
  );
  const signingKeyCapture = installedSmoke.indexOf(
    '$receiptSigningPrivateKey = $env:TAURI_SIGNING_PRIVATE_KEY',
  );
  const initialSigningEnvironmentClear = installedSmoke.indexOf(
    '\nClear-ReceiptSigningEnvironment\n', signingKeyCapture,
  );
  const publicationSigningRestore = installedSmoke.indexOf(
    '$env:TAURI_SIGNING_PRIVATE_KEY = $receiptSigningPrivateKey', postInstallReceipt,
  );
  const postPublicationSigningClear = installedSmoke.indexOf(
    '\n    Clear-ReceiptSigningEnvironment\n', publicationSigningRestore,
  );
  assert.ok(
    installedSmoke.indexOf('if ($PublishPackageReceipt)') >= 0
      && installerLaunch >= 0
      && installedSmoke.indexOf('if ($PublishPackageReceipt)') < installerLaunch
      && cleanPublicationOutputs >= 0
      && cleanPublicationOutputs < installerLaunch
      && requiredSigningKey >= 0
      && requiredSigningKey < installerLaunch,
    'receipt publication must require clean outputs and the updater signing key before installing',
  );
  assert.ok(
    signingKeyCapture >= 0
      && initialSigningEnvironmentClear > signingKeyCapture
      && initialSigningEnvironmentClear < installerLaunch
      && publicationSigningRestore > installStart
      && postPublicationSigningClear > publicationSigningRestore
      && postPublicationSigningClear < firstApplicationLaunch
      && installedSmoke.includes('Remove-Item Env:\\TAURI_SIGNING_PRIVATE_KEY_PASSWORD'),
    'the installer and application must never inherit the updater receipt-signing secret',
  );
  assert.ok(
    installStart >= 0
      && postInstallReceipt > installStart
      && installedSmoke.indexOf('--publish true', postInstallReceipt) > postInstallReceipt
      && firstApplicationLaunch > postInstallReceipt
      && postInstallReceiptFailure > postInstallReceipt
      && postInstallReceiptFailure < firstApplicationLaunch,
    'publication mode must inventory and authenticate the complete generated install before app launch',
  );
  assert.ok(
    preInstallConsumptionReceipt >= 0
      && preInstallConsumptionReceipt < installedSmoke.indexOf('Start-Process -FilePath $installer'),
    'consumption mode must authenticate the source-bound package receipt before installing',
  );
  assert.match(installedSmoke, /publisher = 'osg-installed-production-evidence'/u);
  assert.match(installedSmoke, /installerSha256 = \$installerSha256/u);
  assert.match(installedSmoke, /journeys = @\('installedGolden'\)/u);
  assert.ok(
    updaterSmoke.indexOf("$env:GITHUB_ACTIONS -ne 'true'")
      < updaterSmoke.indexOf('$server = Start-Process'),
    'the updater desktop smoke must refuse local execution before launching anything',
  );
});

test('the fast E2E profile has one canonical nonshipping build and cannot replace release', () => {
  const cargo = read('Cargo.toml');
  const desktopCargo = read('apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const rootPackage = JSON.parse(read('package.json'));
  const environment = readSplitModule('e2e', 'support', 'environment.js');
  const inventory = JSON.parse(read('e2e', 'inventory.json'));
  const releaseProfile = /\[profile\.release\]([\s\S]*?)(?=\n\[|$)/u.exec(cargo)?.[1] ?? '';
  const e2eProfile = /\[profile\.e2e\]([\s\S]*?)(?=\n\[|$)/u.exec(cargo)?.[1] ?? '';
  assert.match(releaseProfile, /codegen-units\s*=\s*1/u);
  assert.match(releaseProfile, /lto\s*=\s*"fat"/u);
  assert.match(releaseProfile, /opt-level\s*=\s*"z"/u);
  assert.match(e2eProfile, /inherits\s*=\s*"release"/u);
  assert.match(e2eProfile, /codegen-units\s*=\s*16/u);
  assert.match(e2eProfile, /incremental\s*=\s*true/u);
  assert.match(e2eProfile, /lto\s*=\s*false/u);
  assert.match(e2eProfile, /opt-level\s*=\s*2/u);
  assert.match(desktopCargo, /crate-type\s*=\s*\["rlib"\]/u);
  assert.doesNotMatch(desktopCargo, /crate-type\s*=\s*\[[^\]]*(?:staticlib|cdylib)/u);

  const build = rootPackage.scripts['build:e2e-binary'];
  const binaryBuilder = read('scripts', 'build-e2e-binary.js');
  assertFreshFrontendBeforeCargo(build);
  assert.equal(
    rootPackage.scripts['build:frontend:e2e'],
    undefined,
    'a frontend-only E2E command could publish bytes that no guarded binary consumes',
  );
  assertStableE2eFrontendBuild(CANONICAL_E2E_FRONTEND_BUILD);
  assert.equal(
    rootPackage.scripts['test:e2e-frontend-publication'],
    'node --test scripts/e2e-build-metadata.test.js scripts/e2e-frontend-snapshot.test.js '
      + 'scripts/build-e2e-frontend.test.js',
    'the immutable frontend publication regressions must remain directly runnable',
  );
  for (const required of [
    /'-p',\s*'osg-desktop'/u,
    /'--bin',\s*'osg-desktop'/u,
    /'--profile',\s*CARGO_PROFILE/u,
    /'--features',\s*'e2e-automation'/u,
    /'--target',\s*TARGET_TRIPLE/u,
    /'--target-dir',\s*cargoTargetDir/u,
    /'--jobs',\s*'1'/u,
    /'--locked'/u,
  ]) assert.match(binaryBuilder, required, `E2E build command is missing ${required}`);
  assert.doesNotMatch(binaryBuilder, /--release|profile\.release/u);
  assertCanonicalApplicationBinarySource(environment);
  const applicationLease = read('e2e', 'support', 'applicationLease.js');
  const evidenceLease = read('e2e', 'support', 'evidenceLease.js');
  const workflowEvidence = readSplitModule('e2e', 'support', 'workflowEvidence.js');
  const isolatedRunner = read('e2e', 'run-isolated.mjs');
  const staging = read('e2e', 'support', 'stageApplication.js');
  assert.match(applicationLease, /acquireManagedE2eLease/u);
  assert.match(applicationLease, /releaseManagedE2eLease/u);
  assert.match(applicationLease, /applicationsCacheRoot = E2E_APPLICATIONS_CACHE_ROOT/u);
  assert.match(applicationLease, /lease\.assetCacheRoot, E2E_ASSET_CACHE_ROOT/u);
  assert.match(applicationLease, /protectApplication:\s*true/u);
  assert.match(applicationLease, /protectE2e:\s*false/u);
  assert.match(staging, /applicationLease[\s\S]*?stagingLease[\s\S]*?readVerifiedPublishedApplication\(\)[\s\S]*?copyVerifiedTree[\s\S]*?readVerifiedPublishedApplication\(\)/u);
  assert.match(environment, /export const E2E_ASSET_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'assets', 'e2e'\);/u);
  assert.match(environment, /export const EVIDENCE_CACHE_ROOT = join\(DEVELOPMENT_CACHE_ROOT, 'evidence'\);/u);
  assert.match(workflowEvidence, /WORKFLOW_EVIDENCE_ROOT = evidenceRootForProcess\(\)/u);
  assert.match(workflowEvidence, /defaultEvidenceRoot = \(\) => join\(developmentCacheRoot\(\), 'evidence'\)/u);
  assert.match(workflowEvidence, /if \(requested === undefined\) return defaultEvidenceRoot\(\)/u);
  assert.doesNotMatch(workflowEvidence, /from '\.\.?\/environment\.js'/u);
  assert.match(evidenceLease, /'-Lane', 'evidence'/u);
  assert.match(evidenceLease, /'-LeaseOperation', 'Release'/u);
  assert.match(evidenceLease, /'-Action', 'Prune', '-Apply', '-Confirm:\$false', '-ProtectUnit', 'apps-e2e'/u);
  assert.match(
    isolatedRunner,
    /createE2eCacheMaintenanceBatch\(\)[\s\S]*?cacheMaintenance\.withLeases\([\s\S]*?beginWorkflowEvidence\([\s\S]*?runSupervisedSync\([\s\S]*?finalizeWorkflowEvidence\(/u,
    'the runner must retain every cache lease from provenance through supervised evidence finalization',
  );
  // Lease nesting and prune ordering are behaviour, proven by support/cacheMaintenance.test.mjs.
  for (const child of [
    'native-tools', 'engine-packages', 'real-media', 'source-switch-media',
    'four-window-asr-media',
  ]) {
    assert.match(
      environment,
      new RegExp(`E2E_ASSET_CACHE_ROOT,\\s*'${child}'`, 'u'),
      `${child} is not rooted in the managed external asset lane`,
    );
  }
  assert.doesNotMatch(
    environment,
    /REPOSITORY_ROOT,\s*'target',\s*'e2e-(?:native-tools|engine-packages|real-media|source-switch-media|asr-media)'/u,
  );
  assert.doesNotMatch(workflowEvidence, /REPOSITORY_ROOT,\s*'target',\s*'workflow-evidence'/u);
  assert.equal(
    inventory.binary.e2e,
    'npm run build:e2e-binary publishes the guarded nonshipping E2E application into the managed '
      + 'external cache; every launch holds the apps/e2e cache lease while re-verifying '
      + 'receipts/current.json, its immutable manifest, exact inventory and every file digest, '
      + 'with no repository-target fallback',
  );

  for (const workflow of ['rewrite-ci.yml', 'updater-smoke.yml']) {
    assert.doesNotMatch(
      read('.github', 'workflows', workflow),
      /e2e-automation|--profile e2e/u,
      `${workflow} substituted the hidden-test profile for a release build`,
    );
  }
});

test('the canonical E2E command rejects stale or post-Cargo frontend builds', () => {
  assert.doesNotThrow(() => assertFreshFrontendBeforeCargo(
    CANONICAL_E2E_BUILD,
  ));
  for (const weakened of [
    'cargo build --profile e2e',
    'cargo build --profile e2e && npm run build:frontend:e2e',
    'npm run build:vite && cargo build --profile e2e',
  ]) {
    assert.throws(() => assertFreshFrontendBeforeCargo(weakened), /exact frontend-then-Cargo/u);
  }
  assert.doesNotThrow(() => assertStableE2eFrontendBuild(
    CANONICAL_E2E_FRONTEND_BUILD,
  ));
  for (const weakened of [
    'npm run build:vite',
    'npm run generate:version && npm run build:vite',
    'npm run build:vite && npm run generate:version -- --reproducible',
  ]) {
    assert.throws(() => assertStableE2eFrontendBuild(weakened), /exact reproducible-metadata/u);
  }
  assert.throws(() => assertFreshFrontendBeforeCargo(
    `echo ${CANONICAL_E2E_BUILD} && cargo build`,
  ), /exact frontend-then-Cargo/u);
  const environment = readSplitModule('e2e', 'support', 'environment.js');
  assert.throws(() => assertCanonicalApplicationBinarySource(environment.replace(
    'publicationAtModuleLoad?.binaryPath',
    "join(REPOSITORY_ROOT, 'target', 'release', 'osg-desktop.exe')",
  )), /APPLICATION_BINARY/u);
});
