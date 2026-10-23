// Bind an inventory entry to its workflow's latest-success pointer and attempt manifest:
// exact evidence source, application hash and staged-derivative identity.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const HASH_PATTERN = /^[0-9a-f]{40,64}$/u;
const ATTEMPT_ID_PATTERN = /^[0-9]{17}-[1-9][0-9]*-[0-9a-f]{8}$/u;
const EVIDENCE_PUBLISHER = 'osg-e2e-workflow-evidence';
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
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

const safeDerivativePath = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 260
  && !value.includes('\\')
  && !value.includes('\0')
  && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const derivativeIdentity = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('|') === 'sha256|size'
  && Number.isSafeInteger(value.size)
  && value.size >= 0
  && /^[0-9a-f]{64}$/u.test(value.sha256 ?? '')
    ? { size: value.size, sha256: value.sha256 }
    : null
);

const optionalApplicationDerivative = (value) => {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join('|')
      !== 'baseApplicationHash|delta|directories|files|kind|treeSha256'
    || value.kind !== 'staged-damage'
    || !/^[0-9a-f]{64}$/u.test(value.baseApplicationHash ?? '')
    || !/^[0-9a-f]{64}$/u.test(value.treeSha256 ?? '')
    || !Array.isArray(value.files)
    || value.files.length === 0
    || value.files.length > 128
  ) return undefined;
  if (
    !Array.isArray(value.directories)
    || value.directories.length > 64
    || !value.directories.every(safeDerivativePath)
    || value.directories.some((path, index) => index > 0 && value.directories[index - 1] >= path)
  ) return undefined;
  const files = value.files.map((entry) => {
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).sort().join('|') !== 'path|sha256|size'
      || !safeDerivativePath(entry.path)
    ) return null;
    const identity = derivativeIdentity({ size: entry.size, sha256: entry.sha256 });
    return identity === null ? null : { path: entry.path, ...identity };
  });
  const paths = files.map((entry) => entry?.path);
  if (
    files.some((entry) => entry === null)
    || paths.some((path, index) => index > 0 && paths[index - 1] >= path)
    || value.treeSha256 !== createHash('sha256')
      .update(`${JSON.stringify({ directories: value.directories, files })}\n`).digest('hex')
  ) return undefined;
  const delta = value.delta;
  const base = derivativeIdentity(delta?.base);
  const derived = delta?.derived === null ? null : derivativeIdentity(delta?.derived);
  if (
    delta === null
    || typeof delta !== 'object'
    || Array.isArray(delta)
    || Object.keys(delta).sort().join('|') !== 'base|change|derived|path'
    || !['changed', 'deleted'].includes(delta.change)
    || !safeDerivativePath(delta.path)
    || !delta.path.startsWith('ui-fonts/')
    || base === null
    || (delta.change === 'deleted' && delta.derived !== null)
    || (delta.change === 'changed' && (derived === null
      || (derived.size === base.size && derived.sha256 === base.sha256)))
    || (delta.change === 'changed') !== paths.includes(delta.path)
  ) return undefined;
  return { ...value, files, delta: { ...delta, base, derived } };
};

const derivativeMatchesBase = (derivative, application) => {
  if (derivative === null) return true;
  if (application === null || derivative.baseApplicationHash !== application.applicationHash) {
    return false;
  }
  if (JSON.stringify(derivative.directories) !== JSON.stringify(application.directories)) {
    return false;
  }
  const baseByPath = new Map(application.files.map((entry) => [entry.path, entry]));
  const derivedByPath = new Map(derivative.files.map((entry) => [entry.path, entry]));
  const changed = application.files.filter((entry) => {
    const next = derivedByPath.get(entry.path);
    return next !== undefined && (next.size !== entry.size || next.sha256 !== entry.sha256);
  });
  const deleted = application.files.filter(({ path }) => !derivedByPath.has(path));
  const added = derivative.files.filter(({ path }) => !baseByPath.has(path));
  if (added.length !== 0 || changed.length + deleted.length !== 1) return false;
  const base = changed[0] ?? deleted[0];
  const next = derivedByPath.get(base.path) ?? null;
  return derivative.delta.path === base.path
    && derivative.delta.change === (next === null ? 'deleted' : 'changed')
    && JSON.stringify(derivative.delta.base)
      === JSON.stringify({ size: base.size, sha256: base.sha256 })
    && JSON.stringify(derivative.delta.derived) === JSON.stringify(next === null
      ? null
      : { size: next.size, sha256: next.sha256 });
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

export const bindLatestSuccess = ({ entry, evidenceRoot, applicationStore, currentSource }) => {
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
  if (!derivativeMatchesBase(manifestApplicationDerivative, exactApplication)) {
    return { error: `"${name}" latest-success derivative inventory is not the exact base delta` };
  }
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
