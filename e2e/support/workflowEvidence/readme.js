// Human-readable README indexes for each workflow and for the evidence root.

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { attemptRecords } from './attempts.js';
import { atomicWriteFile, readJson } from './files.js';
import { WORKFLOW_EVIDENCE_ROOT, workflowEvidenceDirectory } from './paths.js';

export const refreshWorkflowReadme = (workflow) => {
  const root = workflowEvidenceDirectory(workflow);
  mkdirSync(root, { recursive: true });
  const latest = readJson(join(root, 'latest-success.json'));
  const legacy = readJson(join(root, 'manifest.json'));
  const attempts = attemptRecords(workflow);
  const lines = [
    `# ${workflow}`,
    '',
    latest
      ? `Latest successful evidence: [${latest.attemptId}](${latest.path.replaceAll('\\', '/')}/README.md)`
      : 'Latest successful evidence: **none yet**',
    '',
    'Retention keeps the three newest attempts plus the latest successful proof. A failed attempt '
      + 'never replaces that pointer.',
    '',
  ];
  if (legacy?.schemaVersion === 1) {
    lines.push(
      '## Pre-provenance evidence',
      '',
      'This evidence predates run results and binary hashes, so it is preserved but not promoted as an attested success.',
      '',
    );
    for (const step of legacy.steps ?? []) {
      lines.push(`- [${step.step}](${step.screenshot}) — ${step.description}`);
    }
    lines.push('');
  }
  lines.push('## Attempts', '');
  if (attempts.length === 0) lines.push('- None', '');
  for (const { manifest } of attempts) {
    const { attempt } = manifest;
    lines.push(
      `- [${attempt.id}](attempts/${attempt.id}/README.md) — **${attempt.outcome}**, `
      + `iteration ${attempt.iteration}, ${attempt.startedAt}`,
    );
  }
  atomicWriteFile(join(root, 'README.md'), `${lines.join('\n')}\n`);
};

export const refreshRootReadme = () => {
  mkdirSync(WORKFLOW_EVIDENCE_ROOT, { recursive: true });
  const workflows = readdirSync(WORKFLOW_EVIDENCE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(WORKFLOW_EVIDENCE_ROOT, entry.name, 'README.md')))
    .map((entry) => {
      const latest = readJson(join(WORKFLOW_EVIDENCE_ROOT, entry.name, 'latest-success.json'));
      const attempts = attemptRecords(entry.name);
      return {
        name: entry.name,
        latest: latest?.attemptId ?? null,
        attempts: attempts.length,
        failures: attempts.filter(({ manifest }) => manifest.attempt.outcome === 'fail').length,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const lines = [
    '# Real workflow screenshots',
    '',
    'Each workflow contains immutable real-binary attempts and an atomically promoted latest success.',
    '',
    ...workflows.map(({ attempts, failures, latest, name }) => (
      `- [${name}](${name}/README.md) — ${attempts} attempt(s), ${failures} failed, `
      + `latest success ${latest ?? 'none'}`
    )),
    '',
  ];
  atomicWriteFile(join(WORKFLOW_EVIDENCE_ROOT, 'README.md'), lines.join('\n'));
};

/**
 * Rebuild the generated top-level browser from whatever attempts and latest-success pointers are
 * actually on disk right now. `beginWorkflowEvidence` and `finalizeWorkflowEvidence` already call
 * this after every attempt, but that update is not atomic with the manifest write it follows: a
 * process killed between the two (or by an external retention/cleanup operation) can leave a
 * truthful manifest behind a stale index for a workflow that never runs again this session. The
 * isolated runner calls this once before and once after every suite invocation so the index is
 * never more than one crashed attempt away from the truth, and never depends on that workflow
 * being retried to self-heal.
 */
export const refreshWorkflowEvidenceIndex = () => refreshRootReadme();
