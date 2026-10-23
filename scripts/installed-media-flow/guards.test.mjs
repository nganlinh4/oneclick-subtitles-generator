import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFirstMediaDocumentPreserved,
  assertMediaFlowResult,
  assertStagedReplacementPreservesActiveMedia,
  collectDownloadJobIds,
  hasCompletedReplacementForImport,
  hasMediaFlowStarted,
} from './guards.mjs';
import {
  DOWNLOAD_JOB_A,
  DOWNLOAD_JOB_B,
  PRIOR_ASSET_ID,
  TOOL,
  validResult,
} from './test-fixtures.mjs';

test('first media attachment retains the durable imported subtitle document', () => {
  const cacheId = 'subtitle-document:019ff572-2131-7ba1-9e9c-5a29894963bf';
  const before = { uploadedSrtInfo: { cacheId } };
  const after = { workspace: { cacheId }, uploadedSrtInfo: { cacheId } };
  assert.doesNotThrow(() => assertFirstMediaDocumentPreserved(before, after));
  assert.throws(() => assertFirstMediaDocumentPreserved({ uploadedSrtInfo: { cacheId: null } }, after));
  assert.throws(() => assertFirstMediaDocumentPreserved(before, { ...after, workspace: { cacheId: 'different' } }));
  assert.throws(() => assertFirstMediaDocumentPreserved(before, { ...after, uploadedSrtInfo: { cacheId: 'different' } }));
});

test('accepts the complete native media, subtitle, tool, and job result', () => {
  assert.equal(assertMediaFlowResult(validResult()).video.width, 640);
  assert.deepEqual(collectDownloadJobIds(validResult()), [DOWNLOAD_JOB_A]);
});

test('replacement imports require completed download and matching native and visible B', () => {
  const guard = { priorAssetId: PRIOR_ASSET_ID, baselineDownloadJobIds: [] };
  assert.equal(hasCompletedReplacementForImport(validResult(), guard), true);
  assert.equal(hasCompletedReplacementForImport(validResult(), {
    ...guard, baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), false);
  for (const mutate of [
    (value) => { value.assetId = PRIOR_ASSET_ID; },
    (value) => { value.jobs[0].state = 'running'; },
    (value) => { value.workspace.mediaId = PRIOR_ASSET_ID; },
    (value) => { value.session.media.id = PRIOR_ASSET_ID; },
    (value) => { value.video.readyState = 0; },
    (value) => { value.video.currentSrc = 'stale'; },
  ]) {
    const value = validResult();
    mutate(value);
    assert.equal(hasCompletedReplacementForImport(value, guard), false);
  }
});

test('requires a replaced asset and exactly one successful download created after baseline', () => {
  const staleAsset = validResult();
  assert.throws(() => assertMediaFlowResult(staleAsset, {
    priorAssetId: staleAsset.assetId,
    baselineDownloadJobIds: [],
  }), /retained the prior native asset/);

  const historicalOnly = validResult();
  assert.throws(() => assertMediaFlowResult(historicalOnly, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), /newly attributable/);

  const newlyDownloaded = validResult();
  newlyDownloaded.jobs.unshift({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'succeeded',
    progress: { basisPoints: 10_000 },
  });
  assert.equal(assertMediaFlowResult(newlyDownloaded, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), newlyDownloaded);

  const failedNewDownload = validResult();
  failedNewDownload.jobs.push({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'failed',
    progress: { basisPoints: 10_000 },
  });
  assert.throws(() => assertMediaFlowResult(failedNewDownload, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), /newly attributable/);
});

test('rejects subtitle-only, inactive-tool, and accidental render false positives', () => {
  const missingVideo = validResult();
  missingVideo.video = null;
  assert.throws(() => assertMediaFlowResult(missingVideo), /media element/);

  const inactive = validResult();
  inactive.tools.tools[1].activeRuntime = false;
  assert.throws(() => assertMediaFlowResult(inactive), /immediately active/);

  const duplicatedTool = validResult();
  duplicatedTool.tools.tools = [
    TOOL('deno', '2.9.5'),
    TOOL('deno', '2.9.5'),
    TOOL('deno', '2.9.5'),
  ];
  assert.throws(() => assertMediaFlowResult(duplicatedTool), /immediately active/);

  const missingTool = validResult();
  missingTool.tools.tools.pop();
  assert.throws(() => assertMediaFlowResult(missingTool), /immediately active/);

  const extraTool = validResult();
  extraTool.tools.tools.push(TOOL('unreviewed-tool', '1.0.0'));
  assert.throws(() => assertMediaFlowResult(extraTool), /immediately active/);

  for (const mutation of [
    (result) => { result.tools.schemaVersion = 2; },
    (result) => { result.tools.extra = true; },
    (result) => { result.tools.tools[0].extra = true; },
    (result) => { delete result.tools.tools[0].downloadBytes; },
    (result) => { result.tools.tools[0].label = 'Wrong label'; },
    (result) => { result.tools.tools[0].availableVersion = 'different'; },
    (result) => { result.tools.tools[0].installedBytes = 0; },
    (result) => { result.tools.tools[0].installedBytes = 1; },
    (result) => { result.tools.tools[0].downloadBytes = 0; },
    (result) => { result.tools.tools[0].availableInstalledBytes = 0; },
  ]) {
    const malformedTools = validResult();
    mutation(malformedTools);
    assert.throws(() => assertMediaFlowResult(malformedTools), /immediately active/);
  }

  const stalePlayback = validResult();
  stalePlayback.session.playback.id = '11111111-2222-4333-8444-555555555556';
  assert.throws(() => assertMediaFlowResult(stalePlayback), /native session/);

  const wrongPlaybackVersion = validResult();
  wrongPlaybackVersion.session.playback.id = '01111111-2222-7333-8444-555555555555';
  wrongPlaybackVersion.currentFileUrl = wrongPlaybackVersion.currentFileUrl.replace(
    '01111111-2222-4333-8444-555555555555',
    wrongPlaybackVersion.session.playback.id,
  );
  wrongPlaybackVersion.video.currentSrc = wrongPlaybackVersion.currentFileUrl;
  wrongPlaybackVersion.session.playback.playbackUrl = wrongPlaybackVersion.currentFileUrl;
  assert.throws(() => assertMediaFlowResult(wrongPlaybackVersion), /native session/);

  for (const mutation of [
    (result) => { result.session.playback.mimeType = 'video/webm'; },
    (result) => { result.session.playback.byteLength = 1; },
    (result) => { result.session.media.sizeBytes = 1; },
    (result) => { result.session.media.extra = true; },
    (result) => { result.session.subtitleTrack = {}; },
  ]) {
    const malformedSession = validResult();
    mutation(malformedSession);
    assert.throws(() => assertMediaFlowResult(malformedSession), /native session/);
  }

  const render = validResult();
  render.jobs.push({ kind: 'renderVideo', state: 'succeeded', progress: { basisPoints: 10_000 } });
  assert.throws(() => assertMediaFlowResult(render), /download-only job/);

  const applicationFailure = validResult();
  applicationFailure.errorToastMessages = ['Sanitized download failure'];
  assert.throws(() => assertMediaFlowResult(applicationFailure), /error toast/);

  for (const mutation of [
    (result) => { result.uploadedSrtInfo.v = 1; },
    (result) => { result.uploadedSrtInfo.cacheId = PRIOR_ASSET_ID; },
    (result) => { result.workspace.cacheId = 'another-project'; },
    (result) => { result.workspace.mediaId = PRIOR_ASSET_ID; },
    (result) => { result.uploadedSrtInfo.extra = true; },
  ]) {
    const malformedProvenance = validResult();
    mutation(malformedProvenance);
    assert.throws(() => assertMediaFlowResult(malformedProvenance), /uploaded SRT state|native workspace owner/);
  }

  const substitutedMedia = validResult();
  substitutedMedia.playbackBytes.sha256 = 'b'.repeat(64);
  assert.throws(() => assertMediaFlowResult(substitutedMedia), /reviewed fixture bytes/);
});

test('rejects every staged replacement mutation before native activation succeeds', () => {
  const before = validResult();
  before.assetId = PRIOR_ASSET_ID;
  before.session.media.id = PRIOR_ASSET_ID;
  before.workspace.mediaId = PRIOR_ASSET_ID;
  const unchanged = structuredClone(before);
  assert.equal(
    assertStagedReplacementPreservesActiveMedia(before, unchanged, PRIOR_ASSET_ID),
    unchanged,
  );

  for (const [label, mutate] of [
    ['asset', (value) => { value.assetId = validResult().assetId; }],
    ['playback', (value) => { value.currentFileUrl += '&replacement=1'; }],
    ['session', (value) => { value.session.media.id = validResult().assetId; }],
    ['subtitle', (value) => { value.uploadedSrtInfo.cacheId = null; }],
    ['marker', (value) => { value.subtitleMarkerVisible = false; }],
  ]) {
    const mutated = structuredClone(before);
    mutate(mutated);
    assert.throws(
      () => assertStagedReplacementPreservesActiveMedia(before, mutated, PRIOR_ASSET_ID),
      /mutated the active media or subtitle identity/,
      label,
    );
  }
});

test('staging preserves a local project that has no inherited subtitle upload', () => {
  const before = validResult();
  before.assetId = PRIOR_ASSET_ID;
  before.session.media.id = PRIOR_ASSET_ID;
  before.workspace.mediaId = PRIOR_ASSET_ID;
  before.uploadedSrtInfo = null;
  before.subtitleMarkerVisible = false;
  const unchanged = structuredClone(before);
  assert.equal(assertStagedReplacementPreservesActiveMedia(before, unchanged, PRIOR_ASSET_ID), unchanged);
  const contaminated = structuredClone(before);
  contaminated.uploadedSrtInfo = validResult().uploadedSrtInfo;
  assert.throws(() => assertStagedReplacementPreservesActiveMedia(before, contaminated, PRIOR_ASSET_ID),
    /mutated the active media or subtitle identity/);
});

test('requires immediate native activity after the real media action', () => {
  assert.equal(hasMediaFlowStarted(validResult()), true);
  const inactive = validResult();
  inactive.jobs = [];
  inactive.tools.tools = inactive.tools.tools.map((tool) => ({
    ...tool,
    installed: false,
    operation: null,
    state: 'missing',
  }));
  assert.equal(hasMediaFlowStarted(inactive), false);
  inactive.errorToastMessages = ['Sanitized failure'];
  assert.throws(() => hasMediaFlowStarted(inactive), /failed in the application/);

  const historical = validResult();
  assert.equal(hasMediaFlowStarted(historical, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), false);
  historical.jobs.push({
    id: DOWNLOAD_JOB_B,
    kind: 'downloadMedia',
    state: 'running',
    progress: { basisPoints: 0 },
  });
  assert.equal(hasMediaFlowStarted(historical, {
    priorAssetId: PRIOR_ASSET_ID,
    baselineDownloadJobIds: [DOWNLOAD_JOB_A],
  }), true);
});
