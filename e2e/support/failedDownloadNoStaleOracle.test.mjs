/* global structuredClone */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  assertFailedDownloadLeavesOnlyHistory,
  assertNoVisibleOrPlayableMedia,
  staleMediaViolations,
} from './failedDownloadNoStaleOracle.js';

const job = (id, state, progress = 10_000) => ({ id, state, progress_basis_points: progress });
const baseline = () => ({
  projects: [{ id: 'project-a' }],
  media: [{ id: 'media-a' }],
  links: [{ project_id: 'project-a', media_id: 'media-a' }],
  jobs: [job('job-a', 'succeeded')],
  artifacts: [{ id: 'artifact-a' }],
  managedArtifacts: [{ id: 'artifact-a' }, { id: 'waveform-a' }],
  cacheEntries: [{ artifact_id: 'waveform-a' }],
  mediaArtifacts: [{ media_id: 'media-a', artifact_id: 'artifact-a' }],
  jobClaims: [{ media_id: 'media-a', artifact_id: 'artifact-a', job_id: 'job-a' }],
  alias: { activeCacheId: 'cache-a', entries: [{ cacheId: 'cache-a' }] },
  workspace: {
    initialized: true,
    current: { cacheId: 'cache-a', projectId: 'project-a', mediaId: 'media-a' },
  },
  managedDisk: [{ path: 'a.mp4', sha256: 'a'.repeat(64) }],
  scratch: [],
});

const failed = () => ({
  ...structuredClone(baseline()),
  jobs: [...baseline().jobs, job('job-c', 'failed', 1_200)],
  workspace: { initialized: true, current: null },
});

test('the failure oracle accepts one failed job and an otherwise byte-identical historical A', () => {
  assert.equal(assertFailedDownloadLeavesOnlyHistory(baseline(), failed()).id, 'job-c');
});

test('the failure oracle rejects every durable residue class and a non-terminal job', () => {
  for (const key of [
    'projects', 'media', 'links', 'artifacts', 'managedArtifacts', 'cacheEntries',
    'mediaArtifacts', 'jobClaims',
  ]) {
    const changed = failed();
    changed[key].push({ unexpected: key });
    assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), changed),
      new RegExp(`durable ${key}`, 'u'), key);
  }

  const changedAlias = failed();
  changedAlias.alias.activeCacheId = 'cache-c';
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), changedAlias),
    /durable alias/u);

  const changedBytes = failed();
  changedBytes.managedDisk[0].sha256 = 'c'.repeat(64);
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), changedBytes),
    /artifact bytes/u);

  const scratch = failed();
  scratch.scratch = ['partial-c.mp4'];
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), scratch), /scratch/u);

  const active = failed();
  active.workspace.current = { cacheId: 'cache-a' };
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), active),
    /active-workspace/u);

  const succeeded = failed();
  succeeded.jobs[1].state = 'succeeded';
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), succeeded),
    /terminal-failed/u);

  const completeProgress = failed();
  completeProgress.jobs[1].progress_basis_points = 10_000;
  assert.throws(() => assertFailedDownloadLeavesOnlyHistory(baseline(), completeProgress),
    /complete progress/u);
});

const prior = Object.freeze({
  sourceUrl: 'https://a',
  fileUrl: 'asset://a',
  fileName: 'a.mp4',
  session: { assetId: 'asset-a' },
  videoSrc: 'asset://a',
});
const withdrawn = () => ({
  sourceUrl: null,
  fileUrl: null,
  fileName: '',
  session: null,
  mediaElements: [],
  inlineErrors: [],
});

test('the visible oracle rejects stale identity through every independent surface', () => {
  assertNoVisibleOrPlayableMedia(withdrawn(), prior);
  const mutations = [
    (state) => { state.sourceUrl = prior.sourceUrl; },
    (state) => { state.fileUrl = prior.fileUrl; },
    (state) => { state.fileName = prior.fileName; },
    (state) => { state.session = prior.session; },
    (state) => { state.mediaElements.push({ currentSrc: prior.videoSrc, src: prior.videoSrc }); },
    (state) => { state.inlineErrors.push('Download failed inline'); },
  ];
  for (const mutate of mutations) {
    const state = withdrawn();
    mutate(state);
    assert.throws(() => assertNoVisibleOrPlayableMedia(state, prior));
  }
  assert.deepEqual(staleMediaViolations(withdrawn(), prior), []);
});
