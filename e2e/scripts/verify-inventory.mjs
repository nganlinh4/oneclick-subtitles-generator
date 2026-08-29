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
const HASH_PATTERN = /^[0-9a-f]{40,64}$/u;
const ATTEMPT_ID_PATTERN = /^[0-9]{17}-[1-9][0-9]*-[0-9a-f]{8}$/u;
const EVIDENCE_PUBLISHER = 'osg-e2e-workflow-evidence';
const INSTALLED_EVIDENCE_PUBLISHER = 'osg-installed-production-evidence';
const FORBIDDEN_SUITE_SNAPSHOTS = [
  'asOf', 'applicationsStore', 'olderBinariesStillCitedByGreenEvidence',
  'generatedStatusCounts',
];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const directoryNames = (root) => (
  existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    : []
);

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
      byHash.set(applicationHash, {
        applicationHash,
        binarySha256: application.binarySha256,
        source: application.sourceProvenance,
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

const validGitObject = (value) => HASH_PATTERN.test(value ?? '');

const evidenceSource = (source, { allowMissingTree }) => {
  if (
    source === null
    || typeof source !== 'object'
    || !validGitObject(source.commit)
    || typeof source.dirty !== 'boolean'
    || (!allowMissingTree && !validGitObject(source.tree))
    || (source.tree !== undefined && !validGitObject(source.tree))
  ) return null;
  return {
    commit: source.commit,
    tree: source.tree ?? null,
    dirty: source.dirty,
  };
};

const optionalApplicationHash = (value) => {
  if (value === undefined || value === null) return null;
  return /^[0-9a-f]{64}$/u.test(value) ? value : undefined;
};

const optionalApplicationDerivative = (value) => {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|')
      !== 'baseApplicationHash|changedPaths|deletedPaths|kind|treeSha256'
    || value.kind !== 'staged-damage'
    || !/^[0-9a-f]{64}$/u.test(value.baseApplicationHash ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.treeSha256 ?? '')
    || !Array.isArray(value.changedPaths)
    || !Array.isArray(value.deletedPaths)
    || value.changedPaths.length + value.deletedPaths.length !== 1
    || [...value.changedPaths, ...value.deletedPaths].some((path) => (
      typeof path !== 'string' || !path.startsWith('ui-fonts/') || path.includes('..')
    ))
  ) return undefined;
  return value;
};

const exactLatestPointer = ({ evidenceRoot, workflow }) => {
  const pointerPath = join(evidenceRoot, workflow, 'latest-success.json');
  if (!existsSync(pointerPath)) {
    return { error: `"${workflow}" has no latest-success.json pointer` };
  }
  let pointer;
  try {
    pointer = readJson(pointerPath);
  } catch (error) {
    return { error: `"${workflow}" latest-success pointer is invalid JSON: ${error.message}` };
  }
  if (
    pointer.schemaVersion !== 1
    || pointer.workflow !== workflow
    || !ATTEMPT_ID_PATTERN.test(pointer.attemptId ?? '')
    || pointer.path !== `attempts/${pointer.attemptId}`
    || !/^[0-9a-f]{64}$/u.test(pointer.binarySha256 ?? '')
    || optionalApplicationHash(pointer.applicationHash) === undefined
    || optionalApplicationDerivative(pointer.applicationDerivative) === undefined
    || evidenceSource(pointer, { allowMissingTree: true }) === null
  ) {
    return { error: `"${workflow}" latest-success pointer has an invalid identity` };
  }
  return { pointer };
};

const bindLatestSuccess = ({ entry, evidenceRoot, applicationStore, currentSource }) => {
  const { name, evidenceWorkflow: workflow } = entry;
  if (!workflow) return { error: `"${name}" is green but has no evidenceWorkflow` };
  const pointerResult = exactLatestPointer({ evidenceRoot, workflow });
  if (pointerResult.error) return { error: `"${name}" ${pointerResult.error}` };
  const { pointer } = pointerResult;
  const manifestPath = join(evidenceRoot, workflow, pointer.path, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { error: `"${name}" latest-success attempt ${pointer.attemptId} is missing` };
  }
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch (error) {
    return { error: `"${name}" latest-success manifest is invalid JSON: ${error.message}` };
  }
  if (manifest.attempt?.outcome !== 'pass') {
    return { error: `"${name}" latest-success attempt is not a pass` };
  }
  if (
    manifest.schemaVersion !== 2
    || manifest.publisher !== EVIDENCE_PUBLISHER
    || manifest.workflow !== workflow
  ) {
    return { error: `"${name}" latest-success manifest has an invalid publisher identity` };
  }
  const pointerSource = evidenceSource(pointer, { allowMissingTree: true });
  const manifestSource = evidenceSource(manifest.provenance?.source, { allowMissingTree: true });
  const pointerApplicationHash = optionalApplicationHash(pointer.applicationHash);
  const manifestApplicationHash = optionalApplicationHash(manifest.provenance?.applicationHash);
  const pointerApplicationDerivative = optionalApplicationDerivative(
    pointer.applicationDerivative,
  );
  const manifestApplicationDerivative = optionalApplicationDerivative(
    manifest.provenance?.applicationDerivative,
  );
  if (manifestSource === null) {
    return { error: `"${name}" latest-success manifest has invalid source provenance` };
  }
  if (manifestApplicationHash === undefined) {
    return { error: `"${name}" latest-success manifest has an invalid application hash` };
  }
  if (manifestApplicationDerivative === undefined) {
    return { error: `"${name}" latest-success manifest has an invalid application derivative` };
  }
  if (
    manifestApplicationDerivative !== null
    && manifestApplicationDerivative.baseApplicationHash !== manifestApplicationHash
  ) {
    return { error: `"${name}" latest-success derivative is not bound to its base application` };
  }
  if (
    manifest.attempt?.id !== pointer.attemptId
    || manifest.provenance?.binary?.sha256 !== pointer.binarySha256
    || manifestSource.commit !== pointerSource.commit
    || manifestSource.tree !== pointerSource.tree
    || manifestSource.dirty !== pointerSource.dirty
    || manifestApplicationHash !== pointerApplicationHash
    || JSON.stringify(manifestApplicationDerivative)
      !== JSON.stringify(pointerApplicationDerivative)
  ) {
    return { error: `"${name}" latest-success pointer drifted from its immutable manifest` };
  }
  const staleBinding = (
    (entry.attemptId !== undefined && entry.attemptId !== pointer.attemptId)
    || (entry.binaryDigest !== undefined && entry.binaryDigest !== pointer.binarySha256)
    || (entry.applicationHash !== undefined && entry.applicationHash !== pointerApplicationHash)
  );
  const exactApplication = manifestApplicationHash === null
    ? null
    : applicationStore.byHash.get(manifestApplicationHash) ?? null;
  const exactCurrentEvidence = !currentSource.dirty
    && manifestSource.dirty === false
    && manifestSource.commit === currentSource.commit
    && manifestSource.tree === currentSource.tree;
  const exactApplicationRetained = exactApplication !== null
    && exactApplication.binarySha256 === pointer.binarySha256
  const exactCurrentApplication = exactApplicationRetained
    && exactApplication.source?.dirty === false
    && exactApplication.source.commit === currentSource.commit
    && exactApplication.source.tree === currentSource.tree;
  const current = exactCurrentEvidence && exactCurrentApplication;
  let classification = 'current-head';
  if (!current) {
    classification = exactApplicationRetained ? 'historical-retained' : 'historical-rotated';
  }
  return {
    name,
    workflow,
    attemptId: pointer.attemptId,
    binaryDigest: pointer.binarySha256,
    applicationHash: manifestApplicationHash,
    applicationDerivative: manifestApplicationDerivative,
    evidenceSource: manifestSource,
    staleBinding,
    classification,
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
    '-- generated status counts --',
  ];
  for (const status of Object.keys(report.counts).sort()) {
    lines.push(`  ${status.padEnd(20)} ${report.counts[status]}`);
  }
  lines.push(`  ${'total'.padEnd(20)} ${report.total}`, '');
  lines.push('-- authoritative local green classification --');
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
