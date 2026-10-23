// Attempt manifest shape, ownership checks and the per-attempt README text.

import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { assertOrdinaryPath, atomicSidecarsForTarget, readJson } from './files.js';
import { ATTEMPT_ID_PATTERN, EVIDENCE_PUBLISHER } from './paths.js';

export const newAttemptId = () => {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').toLowerCase();
  return `${timestamp}-${process.pid}-${randomBytes(4).toString('hex')}`;
};

export const initialManifest = ({ attemptId, iteration, journey, provenance, startedAt, workflow }) => ({
  schemaVersion: 2,
  publisher: EVIDENCE_PUBLISHER,
  workflow,
  attempt: {
    id: attemptId,
    journey,
    iteration,
    startedAt,
    endedAt: null,
    outcome: 'running',
    exitStatus: null,
    signal: null,
    failure: null,
  },
  provenance,
  steps: [],
  artifacts: [],
  diagnostics: [],
});

export const manifestHasOwnedIdentity = (manifest, workflow, attemptId) => (
  manifest?.schemaVersion === 2
    && manifest?.publisher === EVIDENCE_PUBLISHER
    && manifest?.workflow === workflow
    && manifest?.attempt?.id === attemptId
);

export const recoverAttemptManifestSidecar = ({ workflow, attemptId, directory }) => {
  const path = join(directory, 'manifest.json');
  const [sidecar] = atomicSidecarsForTarget(path);
  if (sidecar === undefined) return false;
  let replacement = null;
  try {
    replacement = JSON.parse(readFileSync(sidecar, 'utf8'));
  } catch {
    // A valid published manifest proves this exact directory is ours, so an incomplete exact
    // sidecar is a recoverable interrupted write rather than foreign evidence.
    if (existsSync(path)) {
      const current = readJson(path);
      assert.ok(manifestHasOwnedIdentity(current, workflow, attemptId),
        `evidence attempt ${attemptId} has an invalid manifest and sidecar`);
      rmSync(sidecar);
      return true;
    }
    throw new Error(`evidence attempt ${attemptId} has only an incomplete manifest sidecar`);
  }
  assert.ok(manifestHasOwnedIdentity(replacement, workflow, attemptId),
    `evidence attempt ${attemptId} has a foreign manifest sidecar`);
  // The destination is the prior durable version; a surviving valid sidecar is necessarily the
  // later complete write because every writer clears older exact sidecars before creating one.
  renameSync(sidecar, path);
  return true;
};

export const assertOwnedAttemptManifest = ({ workflow, attemptId, directory }) => {
  assert.match(attemptId, ATTEMPT_ID_PATTERN, 'evidence attempts contain an unknown entry name');
  assertOrdinaryPath(directory, 'directory', `evidence attempt ${attemptId}`);
  const manifestPath = join(directory, 'manifest.json');
  assertOrdinaryPath(manifestPath, 'file', `evidence attempt ${attemptId} manifest`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`evidence attempt ${attemptId} has an unreadable manifest`, { cause: error });
  }
  assert.equal(manifest?.schemaVersion, 2, `evidence attempt ${attemptId} has an unknown schema`);
  assert.equal(
    manifest?.publisher,
    EVIDENCE_PUBLISHER,
    `evidence attempt ${attemptId} is not publisher-owned`,
  );
  assert.equal(manifest?.workflow, workflow, `evidence attempt ${attemptId} changed workflow`);
  assert.equal(manifest?.attempt?.id, attemptId, `evidence attempt ${attemptId} changed identity`);
  assert.ok(
    manifest.attempt.outcome === 'running'
      || manifest.attempt.outcome === 'pass'
      || manifest.attempt.outcome === 'fail',
    `evidence attempt ${attemptId} has an unknown outcome`,
  );
  assert.doesNotThrow(
    () => new Date(manifest.attempt.startedAt).toISOString(),
    `evidence attempt ${attemptId} has an invalid start time`,
  );
  return { directory, manifest };
};

export const safeManifestRelativePath = (value, label) => {
  assert.equal(typeof value, 'string', `${label} is not a path`);
  assert.ok(value.length > 0 && value.length <= 260, `${label} is not bounded`);
  assert.equal(isAbsolute(value), false, `${label} is absolute`);
  const parts = value.split(/[\\/]+/u);
  assert.equal(parts.some(part => part === '' || part === '.' || part === '..'), false,
    `${label} contains traversal`);
  return parts.join('/');
};

export const ownedAttemptFiles = (manifest) => {
  const files = new Set(['manifest.json', 'README.md']);
  for (const [collection, label] of [
    [manifest.steps, 'screenshot'],
    [manifest.artifacts, 'artifact'],
    [manifest.diagnostics, 'diagnostic'],
  ]) {
    assert.ok(Array.isArray(collection), `evidence ${label} inventory is not an array`);
    for (const record of collection) {
      files.add(safeManifestRelativePath(record?.[label === 'screenshot' ? 'screenshot' : 'file'],
        `evidence ${label}`));
    }
  }
  return files;
};

export const serializedManifest = manifest => `${JSON.stringify(manifest, null, 2)}\n`;
export const attemptReadmeContents = (manifest) => {
  const lines = [
    `# ${manifest.workflow} — ${manifest.attempt.id}`,
    '',
    `- Result: **${manifest.attempt.outcome}**`,
    `- Journey: \`${manifest.attempt.journey}\``,
    `- Iteration: ${manifest.attempt.iteration}`,
    `- Started: ${manifest.attempt.startedAt}`,
    `- Ended: ${manifest.attempt.endedAt ?? 'running'}`,
    `- Commit: \`${manifest.provenance.source.commit}\`${manifest.provenance.source.dirty ? ' (dirty)' : ''}`,
    `- Tree: \`${manifest.provenance.source.tree}\``,
    `- Application: \`${manifest.provenance.applicationHash ?? 'legacy/unbound'}\``,
    `- Application derivative: \`${manifest.provenance.applicationDerivative === null
      || manifest.provenance.applicationDerivative === undefined
      ? 'none'
      : `${manifest.provenance.applicationDerivative.kind}: ${manifest.provenance.applicationDerivative.description}`}\``,
    `- Binary: \`${manifest.provenance.binary.path}\``,
    `- Binary SHA-256: \`${manifest.provenance.binary.sha256 ?? 'unavailable'}\``,
    '',
    'PNGs are ordered customer-visible checkpoints from this exact real-binary attempt.',
    '',
  ];
  for (const step of manifest.steps) {
    lines.push(`## ${step.step}`, '', step.description, '', `![${step.step}](${step.screenshot})`, '');
  }
  if (manifest.artifacts.length > 0) {
    lines.push('## Independent artifacts', '');
    for (const artifact of manifest.artifacts) {
      lines.push(`- [${artifact.name}](${artifact.file}) — ${artifact.description}`);
    }
    lines.push('');
  }
  if (manifest.diagnostics.length > 0) {
    lines.push('## Bounded failure diagnostics', '');
    for (const diagnostic of manifest.diagnostics) {
      lines.push(`- [${diagnostic.name}](${diagnostic.file}) — ${diagnostic.description}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};
