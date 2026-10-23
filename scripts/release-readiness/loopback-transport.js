'use strict';

// Loopback transport policy: the production frontend reaches no unmanaged localhost service, the
// native-only transport audit names its compiled-artifact gate, and no native capability is missing.

const fs = require('node:fs');
const path = require('node:path');

const { invariant, readJson, readText, toRepositoryPath, walkFiles } = require('./shared');

const LOOPBACK_AUDIT_PATH = 'scripts/production-loopback-audit.json';

function assertLoopbackAuditManifest(rootDirectory) {
  const audit = readJson(rootDirectory, LOOPBACK_AUDIT_PATH);
  invariant(audit.schemaVersion === 2, 'Production transport audit must use schemaVersion 2');
  invariant(audit.productionPolicy === 'native-only',
    'Production transport audit must enforce the native-only policy');
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

const LOCAL_SERVICE_ENDPOINT = /(?:https?|wss?):\/\/(?:localhost|0\.0\.0\.0|127(?:\.\d{1,3}){0,3}|\[(?:::1|0:0:0:0:0:0:0:1)\])(?::(?:\d+|\$\{[^}]+}))?(?=[/?#'"`\s),;]|$)/i;

const TEST_FILE = /\.(?:test|spec)\.(?:js|jsx|ts|tsx)$/;
// Shared test-only modules (`fooTestFixtures.js`, `fooTestHarness.js`): exempt from the scan only
// because no production module may import them, which assertNoProductionTestSupportImports checks.
const TEST_SUPPORT_FILE = /(?:TestFixtures|TestHarness)\.(?:js|jsx|ts|tsx)$/;
const TEST_SUPPORT_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"][^'"]*(?:TestFixtures|TestHarness)(?:\.(?:js|jsx|ts|tsx))?['"]/;

const productionSourceFiles = (rootDirectory) => walkFiles(
  path.join(rootDirectory, 'src'),
  (candidate) => /\.(?:js|jsx|ts|tsx)$/.test(candidate)
    && !TEST_FILE.test(candidate)
    && !TEST_SUPPORT_FILE.test(candidate),
  new Set(['__fixtures__', '__mocks__']),
);

function assertNoProductionTestSupportImports(rootDirectory) {
  const importers = productionSourceFiles(rootDirectory)
    .filter((candidate) => TEST_SUPPORT_IMPORT.test(fs.readFileSync(candidate, 'utf8')))
    .map((candidate) => toRepositoryPath(rootDirectory, candidate));
  invariant(
    importers.length === 0,
    `Production frontend imports test-only support modules: ${importers.join(', ')}`,
  );
}

function assertNoUnmanagedLocalServices(rootDirectory) {
  assertNoProductionTestSupportImports(rootDirectory);
  const offenders = productionSourceFiles(rootDirectory).filter((candidate) => (
    LOCAL_SERVICE_ENDPOINT.test(fs.readFileSync(candidate, 'utf8'))
  ));
  const displayed = offenders
    .slice(0, 12)
    .map((candidate) => toRepositoryPath(rootDirectory, candidate));
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

module.exports = {
  assertLoopbackAuditManifest,
  assertNoMissingNativeCapabilities,
  assertNoUnmanagedLocalServices,
};
