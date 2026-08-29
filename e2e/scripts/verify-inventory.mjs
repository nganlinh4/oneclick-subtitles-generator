// Derive inventory truth from authoritative latest-success pointers and immutable application
// provenance. Historical successes remain visible, but only a retained application built from the
// current clean Git commit/tree counts as current-HEAD proof.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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
  const byDigest = new Map();
  for (const applicationHash of directoryNames(applicationsRoot)) {
    const manifestPath = join(applicationsRoot, applicationHash, '.osg-application-manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    const binary = manifest.files?.find(
      (file) => file.path === (manifest.entrypoint ?? 'osg-desktop.exe'),
    );
    if (!binary?.sha256) continue;
    const applications = byDigest.get(binary.sha256) ?? [];
    applications.push({ applicationHash, source: manifest.source ?? null });
    byDigest.set(binary.sha256, applications);
  }
  return byDigest;
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
    pointer.workflow !== workflow
    || typeof pointer.attemptId !== 'string'
    || pointer.path !== `attempts/${pointer.attemptId}`
    || !/^[0-9a-f]{64}$/u.test(pointer.binarySha256 ?? '')
  ) {
    return { error: `"${workflow}" latest-success pointer has an invalid identity` };
  }
  return { pointer };
};

const bindLatestSuccess = ({ entry, evidenceRoot, applications, currentSource }) => {
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
    manifest.attempt?.id !== pointer.attemptId
    || manifest.provenance?.binary?.sha256 !== pointer.binarySha256
    || manifest.provenance?.source?.commit !== pointer.commit
  ) {
    return { error: `"${name}" latest-success pointer drifted from its immutable manifest` };
  }
  const staleBinding = (
    (entry.attemptId !== undefined && entry.attemptId !== pointer.attemptId)
    || (entry.binaryDigest !== undefined && entry.binaryDigest !== pointer.binarySha256)
  );
  const retained = applications.get(pointer.binarySha256) ?? [];
  const current = !currentSource.dirty && retained.some(({ source }) => (
    source?.dirty === false
    && source.commit === currentSource.commit
    && source.tree === currentSource.tree
  ));
  let classification = 'current-head';
  if (!current) {
    classification = retained.length === 0 ? 'historical-rotated' : 'historical-retained';
  }
  return {
    name,
    workflow,
    attemptId: pointer.attemptId,
    binaryDigest: pointer.binarySha256,
    staleBinding,
    classification,
  };
};

const verifyInventoryState = ({ inventory, evidenceRoot, applicationsRoot, currentSource }) => {
  const counts = {};
  const failures = [];
  const local = [];
  const external = [];
  const applications = readApplications(applicationsRoot);
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
    const result = bindLatestSuccess({ entry, evidenceRoot, applications, currentSource });
    if (result.error) failures.push(result.error);
    else local.push(result);
  }
  const classifications = Object.fromEntries([
    'current-head', 'historical-retained', 'historical-rotated',
  ].map((classification) => [
    classification,
    local.filter((entry) => entry.classification === classification).length,
  ]));
  return {
    counts,
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    applicationsRetained: directoryNames(applicationsRoot).length,
    currentSource,
    local,
    external,
    staleBindings: local.filter(({ staleBinding }) => staleBinding).map(({ name }) => name),
    classifications,
    failures,
  };
};

const renderReport = (report, { evidenceRoot, applicationsRoot }) => {
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
  lines.push('', report.failures.length === 0
    ? 'verify-inventory: authoritative latest-success bindings are internally consistent.'
    : `verify-inventory: ${report.failures.length} binding/ledger failure(s).`);
  lines.push(
    `verify-inventory: ${report.classifications['current-head']} current-HEAD local green(s); `
    + `${report.classifications['historical-retained']} retained historical and `
    + `${report.classifications['historical-rotated']} rotated historical.`,
  );
  return `${lines.join('\n')}\n`;
};

const main = () => {
  const inventoryPath = process.env.OSG_E2E_INVENTORY_PATH ?? DEFAULT_INVENTORY_PATH;
  const evidenceRoot = process.env.OSG_E2E_EVIDENCE_ROOT ?? DEFAULT_EVIDENCE_ROOT;
  const applicationsRoot = process.env.OSG_E2E_APPLICATIONS_ROOT ?? DEFAULT_APPLICATIONS_ROOT;
  const repositoryRoot = process.env.OSG_E2E_REPOSITORY_ROOT ?? DEFAULT_REPOSITORY_ROOT;
  const report = verifyInventoryState({
    inventory: readJson(inventoryPath),
    evidenceRoot,
    applicationsRoot,
    currentSource: readCurrentSource(repositoryRoot),
  });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(report, { evidenceRoot, applicationsRoot }));
  }
  if (report.failures.length > 0) process.exitCode = 1;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { readCurrentSource, renderReport, verifyInventoryState };
