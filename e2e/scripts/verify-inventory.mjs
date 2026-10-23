// Derive inventory truth from authoritative latest-success pointers and immutable application
// provenance. Historical successes remain visible, but only the exact retained application hash
// named by evidence and built from the current clean Git commit/tree counts as current-HEAD proof.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { bindLatestSuccess, HASH_PATTERN, readJson } from './inventoryEvidenceBinding.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { readAndVerifyPublishedE2eApplication } = require(
  '../../scripts/e2e-application-publication.js',
);
const { readAndVerifyInstallerPackageReceipt } = require(
  '../../scripts/installer-package-receipt.js',
);
const DEFAULT_INVENTORY_PATH = join(HERE, '..', 'inventory.json');
const DEFAULT_REPOSITORY_ROOT = resolve(HERE, '..', '..');
const DEVELOPMENT_CACHE_ROOT = process.env.OSG_DEV_CACHE_ROOT
  ?? join(process.env.LOCALAPPDATA ?? '', 'OSG-Development', 'cache');
const DEFAULT_EVIDENCE_ROOT = process.env.OSG_E2E_EVIDENCE_ROOT
  ?? join(DEVELOPMENT_CACHE_ROOT, 'evidence');
const DEFAULT_APPLICATIONS_ROOT = process.env.OSG_E2E_APPLICATIONS_ROOT
  ?? join(DEVELOPMENT_CACHE_ROOT, 'apps', 'e2e', 'applications');
const EXTERNAL_EVIDENCE_RUNS_AGAINST = new Set(['installed-production-binary']);
const INSTALLED_EVIDENCE_PUBLISHER = 'osg-installed-production-evidence';
const FORBIDDEN_SUITE_SNAPSHOTS = [
  'asOf', 'applicationsStore', 'olderBinariesStillCitedByGreenEvidence',
  'generatedStatusCounts',
];

const readCurrentSource = (repositoryRoot = DEFAULT_REPOSITORY_ROOT) => {
  const git = (...args) => String(execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  })).trim();
  const commit = git('rev-parse', '--verify', 'HEAD');
  const tree = git('rev-parse', '--verify', 'HEAD^{tree}');
  const dirty = git('status', '--porcelain=v1', '--untracked-files=all') !== '';
  if (!HASH_PATTERN.test(commit) || !HASH_PATTERN.test(tree)) {
    throw new Error('current Git source identity is malformed');
  }
  return Object.freeze({ commit, tree, dirty });
};

const readApplications = (applicationsRoot) => {
  const byHash = new Map();
  const failures = [];
  const entries = existsSync(applicationsRoot)
    ? readdirSync(applicationsRoot, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    const applicationHash = entry.name;
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(applicationHash)) {
      failures.push(`applications store contains an unrecognized entry: ${applicationHash}`);
      continue;
    }
    try {
      const application = readAndVerifyPublishedE2eApplication({
        applicationsRoot,
        applicationHash,
      });
      const manifestBytes = readFileSync(application.manifestPath);
      const manifest = JSON.parse(manifestBytes);
      const files = [
        ...manifest.files,
        {
          path: '.osg-application-manifest.json',
          size: manifestBytes.byteLength,
          sha256: createHash('sha256').update(manifestBytes).digest('hex'),
        },
      ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
      byHash.set(applicationHash, {
        applicationHash,
        binarySha256: application.binarySha256,
        source: application.sourceProvenance,
        directories: manifest.directories,
        files,
      });
    } catch (error) {
      failures.push(`retained application ${applicationHash} is invalid: ${error.message}`);
      continue;
    }
  }
  return {
    byHash,
    failures,
    retained: entries.filter((entry) => entry.isDirectory()).length,
  };
};

const installedClosureFailures = ({
  currentSource,
  installedEntries,
  installedProof,
  installerSha256,
  installedPackageReceipt = null,
}) => {
  if (installedEntries.length === 0) return [];
  const blockers = [];
  if (currentSource.dirty) blockers.push('current source worktree is dirty');
  for (const entry of installedEntries) {
    if (entry.status !== 'green') {
      blockers.push(`"${entry.name}" has status ${entry.status}, not green`);
    }
  }
  const requiredJourneys = installedEntries
    .filter(({ status }) => status === 'green')
    .map(({ name }) => name)
    .sort();
  const exactProof = installedProof !== null
    && installedProof?.schemaVersion === 1
    && installedProof?.publisher === INSTALLED_EVIDENCE_PUBLISHER
    && installedProof?.outcome === 'pass'
    && installedProof?.source?.dirty === false
    && installedProof?.source?.commit === currentSource.commit
    && installedProof?.source?.tree === currentSource.tree
    && /^[0-9a-f]{64}$/u.test(installedProof?.installerSha256 ?? '')
    && installedProof.installerSha256 === installerSha256
    && installedPackageReceipt !== null
    && installedProof.packageReceiptSha256 === installedPackageReceipt.receiptSha256
    && /^[0-9a-f]{64}$/u.test(installedProof.packageReceiptSignatureSha256 ?? '')
    && installedProof.packageReceiptSignatureSha256
      === installedPackageReceipt.receiptSignatureSha256
    && installedProof.applicationHash === installedPackageReceipt.applicationHash
    && installedProof.payloadExecutableSha256 === installedPackageReceipt.payloadExecutableSha256
    && installedProof.executableSha256 === installedPackageReceipt.payloadExecutableSha256
    && installedPackageReceipt.source.commit === currentSource.commit
    && installedPackageReceipt.source.tree === currentSource.tree
    && installedPackageReceipt.installerSha256 === installerSha256
    && Array.isArray(installedProof.journeys)
    && JSON.stringify([...installedProof.journeys].sort())
      === JSON.stringify(requiredJourneys);
  if (!exactProof) {
    blockers.push(
      'installed-production closure requires a passing current-source proof bound to the exact '
      + 'installer SHA-256 and complete external journey set',
    );
  }
  return blockers;
};

const verifyInventoryState = ({
  inventory,
  evidenceRoot,
  applicationsRoot,
  currentSource,
  installedProof = null,
  installerSha256 = null,
  installedPackageReceipt = null,
}) => {
  const counts = {};
  const failures = [];
  const local = [];
  const external = [];
  const applicationStore = readApplications(applicationsRoot);
  failures.push(...applicationStore.failures);
  const staleSuiteFields = FORBIDDEN_SUITE_SNAPSHOTS.filter(
    (field) => Object.hasOwn(inventory.suiteRun ?? {}, field),
  );
  if (staleSuiteFields.length > 0) {
    failures.push(
      `suiteRun contains hand-maintained generated fields: ${staleSuiteFields.join(', ')}`,
    );
  }
  for (const entry of inventory.journeys ?? []) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    if (entry.status !== 'green') continue;
    if (/never executed against the real binary|node --test only/iu.test(entry.note ?? '')) {
      failures.push(
        `"${entry.name}" is green but its own note says it has no real-binary execution`,
      );
      continue;
    }
    if (EXTERNAL_EVIDENCE_RUNS_AGAINST.has(entry.runsAgainst)) {
      external.push(entry.name);
      continue;
    }
    const result = bindLatestSuccess({ entry, evidenceRoot, applicationStore, currentSource });
    if (result.error) failures.push(result.error);
    else local.push(result);
  }
  const classifications = Object.fromEntries([
    'current-head', 'historical-retained', 'historical-rotated',
  ].map((classification) => [
    classification,
    local.filter((entry) => entry.classification === classification).length,
  ]));
  const localByName = new Map(local.map((entry) => [entry.name, entry]));
  const localClosureBlockers = [];
  if (currentSource.dirty) {
    localClosureBlockers.push('current source worktree is dirty');
  }
  for (const entry of inventory.journeys ?? []) {
    if (EXTERNAL_EVIDENCE_RUNS_AGAINST.has(entry.runsAgainst)) continue;
    if (entry.status !== 'green') {
      localClosureBlockers.push(`"${entry.name}" has status ${entry.status}, not green`);
    } else if (localByName.get(entry.name)?.classification !== 'current-head') {
      localClosureBlockers.push(`"${entry.name}" lacks exact current-HEAD proof`);
    }
  }
  const installedEntries = (inventory.journeys ?? []).filter(
    ({ runsAgainst }) => EXTERNAL_EVIDENCE_RUNS_AGAINST.has(runsAgainst),
  );
  const installedClosureBlockers = installedClosureFailures({
    currentSource,
    installedEntries,
    installedProof,
    installerSha256,
    installedPackageReceipt,
  });
  return {
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    applicationsRetained: applicationStore.retained,
    currentSource,
    local,
    external,
    staleBindings: local.filter(({ staleBinding }) => staleBinding).map(({ name }) => name),
    classifications,
    failures,
    closureBlockers: localClosureBlockers,
    localClosureBlockers,
    installedClosureBlockers,
    externalPolicy: (
      'excluded from local current-source closure; installed closure requires a separate '
      + 'current-source proof bound to the exact installer digest'
    ),
  };
};

const renderReport = (report, {
  evidenceRoot,
  applicationsRoot,
  requireCurrent = false,
  requireInstalled = false,
}) => {
  const lines = [
    '=== e2e/inventory.json verification ===',
    '',
    `evidence root:      ${evidenceRoot}`,
    `applications root:  ${applicationsRoot}`,
    `current source:     ${report.currentSource.commit} tree ${report.currentSource.tree}`,
    `worktree clean:     ${!report.currentSource.dirty}`,
    `applications retained: ${report.applicationsRetained}`,
    '',
    '-- declared historical ledger counts (not current-source proof) --',
  ];
  for (const status of Object.keys(report.counts).sort()) {
    lines.push(`  ${status.padEnd(20)} ${report.counts[status]}`);
  }
  lines.push(`  ${'total'.padEnd(20)} ${report.total}`, '');
  lines.push('-- authoritative evidence freshness for declared green entries --');
  for (const classification of Object.keys(report.classifications)) {
    lines.push(`  ${classification.padEnd(20)} ${report.classifications[classification]}`);
  }
  lines.push('');
  for (const entry of report.local) {
    const marker = entry.classification === 'current-head' ? 'OK ' : 'HIST';
    lines.push(`  ${marker} ${entry.name} (${entry.classification})`);
  }
  if (report.staleBindings.length > 0) {
    lines.push(
      '',
      `-- stale hand bindings ignored in favour of latest-success: ${report.staleBindings.length} --`,
    );
    for (const name of report.staleBindings) lines.push(`  STALE ${name}`);
  }
  if (report.external.length > 0) {
    lines.push('', `-- external green claims not locally verifiable: ${report.external.length} --`);
    for (const name of report.external) lines.push(`  -- ${name}`);
  }
  if (report.failures.length > 0) {
    lines.push('', `-- binding/ledger failures: ${report.failures.length} --`);
    for (const failure of report.failures) lines.push(`  FAIL ${failure}`);
  }
  if (requireCurrent && report.localClosureBlockers.length > 0) {
    lines.push('', `-- local current-source blockers: ${report.localClosureBlockers.length} --`);
    for (const blocker of report.localClosureBlockers) lines.push(`  BLOCK ${blocker}`);
  }
  if (requireInstalled && report.installedClosureBlockers.length > 0) {
    lines.push('', `-- installed-production blockers: ${report.installedClosureBlockers.length} --`);
    for (const blocker of report.installedClosureBlockers) lines.push(`  BLOCK ${blocker}`);
  }
  lines.push('', report.failures.length === 0
    ? 'verify-inventory: authoritative latest-success bindings are internally consistent.'
    : `verify-inventory: ${report.failures.length} binding/ledger failure(s).`);
  lines.push(
    `verify-inventory: ${report.classifications['current-head']} current-HEAD local green(s); `
    + `${report.classifications['historical-retained']} retained historical and `
    + `${report.classifications['historical-rotated']} rotated historical.`,
  );
  if (requireCurrent) {
    lines.push(report.localClosureBlockers.length === 0 && report.failures.length === 0
      ? 'verify-inventory: exact local current-source closure satisfied.'
      : 'verify-inventory: exact local current-source closure NOT satisfied.');
  }
  if (requireInstalled) {
    lines.push(report.installedClosureBlockers.length === 0 && report.failures.length === 0
      ? 'verify-inventory: exact installed-production closure satisfied.'
      : 'verify-inventory: exact installed-production closure NOT satisfied.');
  }
  return `${lines.join('\n')}\n`;
};

const verificationExitCode = (report, {
  requireCurrent = false,
  requireInstalled = false,
} = {}) => (
  report.failures.length > 0
    || (requireCurrent && report.localClosureBlockers.length > 0)
    || (requireInstalled && report.installedClosureBlockers.length > 0)
    ? 1
    : 0
);

const main = () => {
  const arguments_ = process.argv.slice(2);
  const unknown = arguments_.filter(
    (argument) => !['--json', '--require-current', '--require-installed'].includes(argument),
  );
  if (unknown.length > 0 || new Set(arguments_).size !== arguments_.length) {
    throw new Error(
      'usage: verify-inventory.mjs [--json] [--require-current] [--require-installed]',
    );
  }
  const requireCurrent = arguments_.includes('--require-current');
  const requireInstalled = arguments_.includes('--require-installed');
  const inventoryPath = process.env.OSG_E2E_INVENTORY_PATH ?? DEFAULT_INVENTORY_PATH;
  const evidenceRoot = process.env.OSG_E2E_EVIDENCE_ROOT ?? DEFAULT_EVIDENCE_ROOT;
  const applicationsRoot = process.env.OSG_E2E_APPLICATIONS_ROOT ?? DEFAULT_APPLICATIONS_ROOT;
  const repositoryRoot = process.env.OSG_E2E_REPOSITORY_ROOT ?? DEFAULT_REPOSITORY_ROOT;
  const installedProofPath = process.env.OSG_E2E_INSTALLED_PROOF_PATH;
  const installerPath = process.env.OSG_E2E_INSTALLER_PATH;
  const packageReceiptPath = process.env.OSG_E2E_INSTALLER_RECEIPT_PATH;
  const installedProof = requireInstalled && installedProofPath !== undefined
    ? readJson(installedProofPath)
    : null;
  const installerSha256 = requireInstalled && installerPath !== undefined && existsSync(installerPath)
    ? createHash('sha256').update(readFileSync(installerPath)).digest('hex')
    : null;
  const installedPackageReceipt = requireInstalled
    && packageReceiptPath !== undefined
    && installerPath !== undefined
    ? readAndVerifyInstallerPackageReceipt({ receiptPath: packageReceiptPath, installerPath })
    : null;
  const report = verifyInventoryState({
    inventory: readJson(inventoryPath),
    evidenceRoot,
    applicationsRoot,
    currentSource: readCurrentSource(repositoryRoot),
    installedProof,
    installerSha256,
    installedPackageReceipt,
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(report, {
      evidenceRoot,
      applicationsRoot,
      requireCurrent,
      requireInstalled,
    }));
  }
  process.exitCode = verificationExitCode(report, { requireCurrent, requireInstalled });
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { readCurrentSource, renderReport, verificationExitCode, verifyInventoryState };
