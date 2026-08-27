import { strict as assert } from 'node:assert';
import { relative, resolve, sep } from 'node:path';

import {
  downloadDurabilityState,
  downloadScratchFiles,
  managedArtifactFiles,
  sha256File,
} from './downloadJourneyOracle.js';
import { withDatabase } from './database.js';

const STABLE_LEDGER_KEYS = Object.freeze([
  'projects',
  'media',
  'links',
  'artifacts',
  'managedArtifacts',
  'cacheEntries',
  'mediaArtifacts',
  'jobClaims',
  'alias',
]);

const activeWorkspaceState = (runRoot) => withDatabase(runRoot, (database) => {
  const rows = database.prepare(
    "SELECT key, value_json FROM app_settings WHERE scope = 'active_workspace'"
      + " AND key IN ('current', 'initialized') ORDER BY key",
  ).all();
  const values = new Map(rows.map(({ key, value_json: value }) => [key, JSON.parse(value)]));
  return Object.freeze({
    initialized: values.get('initialized') === true,
    current: values.get('current') ?? null,
  });
});

const managedDiskState = (runRoot) => {
  const root = resolve(runRoot, 'data', 'artifacts');
  return managedArtifactFiles(runRoot).map((path) => ({
    path: relative(root, path).split(sep).join('/'),
    sha256: sha256File(path),
  }));
};

/** Independent SQLite + filesystem state used by the failed-download customer journey. */
export const failedDownloadDurabilityState = (runRoot) => Object.freeze({
  ...downloadDurabilityState(runRoot),
  workspace: activeWorkspaceState(runRoot),
  managedDisk: managedDiskState(runRoot),
  scratch: downloadScratchFiles(runRoot),
});

/**
 * The failed request may add one terminal job. It may not add, remove, rename, or re-own any
 * project/media/artifact/cache row, and it may not leave the prior source selected natively.
 */
export const assertFailedDownloadLeavesOnlyHistory = (before, after) => {
  for (const key of STABLE_LEDGER_KEYS) {
    if (key === 'alias') continue;
    assert.deepEqual(after[key], before[key], `failed download mutated durable ${key}`);
  }
  // The alias claim pins BINDING identity. `lastOpenedAt` is open-bookkeeping any legitimate
  // resolve advances (a 64ms drift between two touches failed a correct run), so it is compared
  // for monotonicity only while every identity field must match exactly.
  const withoutOpenTimes = (alias) => (alias === null ? null : {
    ...alias,
    entries: (alias.entries ?? []).map(({ lastOpenedAt, ...entry }) => entry),
  });
  assert.deepEqual(withoutOpenTimes(after.alias), withoutOpenTimes(before.alias),
    'failed download mutated durable alias');
  for (const entry of after.alias?.entries ?? []) {
    const prior = (before.alias?.entries ?? []).find(({ cacheId }) => cacheId === entry.cacheId);
    if (!Number.isFinite(prior?.lastOpenedAt) || !Number.isFinite(entry.lastOpenedAt)) continue;
    assert.ok(entry.lastOpenedAt >= prior.lastOpenedAt,
      `alias entry ${entry.cacheId} moved its lastOpenedAt backwards`);
  }
  assert.deepEqual(after.managedDisk, before.managedDisk,
    'failed download changed the managed artifact bytes on disk');
  assert.deepEqual(after.scratch, [], 'failed download left scratch media bytes');

  assert.equal(before.projects.length, 1, 'the success baseline must contain one historical project');
  assert.equal(before.media.length, 1, 'the success baseline must contain one historical media asset');
  assert.equal(before.artifacts.length, 1,
    'the success baseline must contain one historical downloaded-media artifact');
  assert.equal(before.jobs.length, 1, 'the success baseline must contain one successful download job');
  assert.equal(before.jobs[0].state, 'succeeded');

  const beforeJobIds = new Set(before.jobs.map(({ id }) => id));
  const addedJobs = after.jobs.filter(({ id }) => !beforeJobIds.has(id));
  assert.equal(addedJobs.length, 1, 'the failed request did not create exactly one owned native job');
  assert.equal(addedJobs[0].state, 'failed', 'the failed request job is not terminal-failed');
  assert.ok(addedJobs[0].progress_basis_points < 10_000,
    'a failed transfer claimed complete progress');

  assert.deepEqual(before.workspace.current === null, false,
    'source A was not the authoritative active workspace before replacement');
  assert.deepEqual(after.workspace, { initialized: true, current: null },
    'failed source C left an authoritative active-workspace pointer');
  return addedJobs[0];
};

const normalizedMediaSource = (entry) => entry.currentSrc || entry.src || '';

/** Return bounded reasons why a formerly active source is still customer-visible or playable. */
export const staleMediaViolations = (state, prior) => {
  const violations = [];
  if (state.sourceUrl !== null) violations.push(`sourceUrl:${state.sourceUrl === prior.sourceUrl ? 'A' : 'other'}`);
  if (state.fileUrl !== null) violations.push(`fileUrl:${state.fileUrl === prior.fileUrl ? 'A' : 'other'}`);
  if (state.session !== null) violations.push(
    `session:${state.session?.assetId === prior.session?.assetId ? 'A' : 'other'}`,
  );
  if (state.fileName !== '') violations.push(`fileName:${state.fileName === prior.fileName ? 'A' : 'other'}`);
  for (const [index, entry] of state.mediaElements.entries()) {
    const source = normalizedMediaSource(entry);
    if (source !== '') {
      violations.push(`media[${index}]:${source === prior.videoSrc ? 'A' : 'other'}`);
    }
  }
  return violations;
};

export const assertNoVisibleOrPlayableMedia = (state, prior) => {
  assert.deepEqual(staleMediaViolations(state, prior), [],
    'a failed replacement exposed visible or playable media');
  assert.deepEqual(state.inlineErrors, [], 'download failure leaked into an inline error surface');
};
