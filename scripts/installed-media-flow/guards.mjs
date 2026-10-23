// Acceptance guards for the installed media flow: the exact native media, subtitle, tool, and job
// state, attributable downloads, and identity preservation while a replacement is staged.

import {
  EXPECTED_FIXTURE_BYTES,
  EXPECTED_FIXTURE_SHA256,
  EXPECTED_NATIVE_TOOL_IDS,
  EXPECTED_NATIVE_TOOL_LABELS,
  PLAYBACK_URL,
  UUID_V4,
  UUID_V7,
  hasExactKeys,
  invariant,
} from './shared.mjs';

const isSafeToolVersion = (value) => typeof value === 'string'
  && value.length >= 1 && value.length <= 128
  && ![...value].some((character) => {
    const point = character.codePointAt(0);
    return point <= 31 || (point >= 127 && point <= 159);
  });

const normalizeFlowGuard = ({
  priorAssetId = null,
  baselineDownloadJobIds = [],
} = {}) => {
  invariant(priorAssetId === null || UUID_V7.test(priorAssetId),
    'Installed media-flow prior asset identity is invalid');
  invariant(Array.isArray(baselineDownloadJobIds)
    && baselineDownloadJobIds.length <= 4_096
    && baselineDownloadJobIds.every((id) => UUID_V7.test(id))
    && new Set(baselineDownloadJobIds).size === baselineDownloadJobIds.length,
  'Installed media-flow download baseline is invalid');
  return { priorAssetId, baselineDownloadJobIds };
};

export function collectDownloadJobIds(value) {
  invariant(Array.isArray(value?.jobs) && value.jobs.length <= 4_096,
    'Installed media flow returned an invalid job list');
  const jobs = value.jobs.filter((job) => job?.kind === 'downloadMedia');
  invariant(jobs.every((job) => UUID_V7.test(job?.id ?? '')),
    'Installed media flow returned an invalid download job identity');
  const ids = jobs.map((job) => job.id);
  invariant(new Set(ids).size === ids.length,
    'Installed media flow returned duplicate download jobs');
  return ids;
}

export const newDownloadJobs = (value, baselineDownloadJobIds) => {
  const baseline = new Set(baselineDownloadJobIds);
  collectDownloadJobIds(value);
  return value.jobs.filter((job) => (
    job?.kind === 'downloadMedia' && !baseline.has(job.id)
  ));
};

export const hasCompletedReplacementForImport = (value, { priorAssetId, baselineDownloadJobIds }) => {
  const downloads = newDownloadJobs(value, baselineDownloadJobIds);
  return priorAssetId !== null && downloads.length === 1 && downloads[0].state === 'succeeded'
    && UUID_V7.test(value?.assetId ?? '') && value.assetId !== priorAssetId
    && value.workspace?.mediaId === value.assetId
    && value.session?.media?.id === value.assetId
    && value.video?.readyState >= 1
    && value.currentFileUrl === value.session?.playback?.playbackUrl
    && value.video?.currentSrc === value.currentFileUrl;
};


export function summarizeMediaFlowFailure(value) {
  const jobs = Array.isArray(value?.jobs) ? value.jobs : [];
  const tools = Array.isArray(value?.tools?.tools) ? value.tools.tools : [];
  return Object.freeze({
    assetId: UUID_V7.test(value?.assetId ?? '') ? value.assetId : null,
    errorToastCount: Array.isArray(value?.errorToastMessages)
      ? Math.min(value.errorToastMessages.length, 4)
      : 0,
    failedJobCount: jobs.filter((job) => job?.state === 'failed').length,
    jobCount: Math.min(jobs.length, 16),
    toolCount: Math.min(tools.length, 3),
  });
}

export function assertMediaFlowState(value, guardOptions) {
  const guard = normalizeFlowGuard(guardOptions);
  invariant(hasExactKeys(value, [
    'assetId', 'currentFileName', 'currentFileUrl', 'errorToastMessages', 'jobs', 'session',
    'subtitleMarkerVisible', 'tools', 'uploadedSrtInfo', 'video', 'workspace',
  ]), 'Installed media flow returned an invalid result shape');
  invariant(UUID_V7.test(value.assetId ?? ''), 'Installed media flow did not publish a UUIDv7 asset');
  invariant(guard.priorAssetId === null || value.assetId !== guard.priorAssetId,
    'Installed media flow retained the prior native asset');
  const playback = typeof value.currentFileUrl === 'string'
    ? PLAYBACK_URL.exec(value.currentFileUrl)
    : null;
  invariant(playback !== null && Number(playback[1]) >= 1 && Number(playback[1]) <= 65_535,
    'Installed media flow did not publish an opaque loopback capability');
  invariant(typeof value.currentFileName === 'string' && value.currentFileName.endsWith('.mp4'),
    'Installed media flow did not retain an MP4 display name');
  invariant(hasExactKeys(value.video, [
    'currentSrc', 'duration', 'height', 'paused', 'readyState', 'width',
  ])
    && value.video.currentSrc === value.currentFileUrl
    && Number.isFinite(value.video.duration)
    && value.video.duration >= 3.9 && value.video.duration <= 4.1
    && Number.isInteger(value.video.readyState) && value.video.readyState >= 1
    && value.video.width === 640
    && value.video.height === 360,
  'Installed media element did not decode the downloaded video metadata');
  invariant(hasExactKeys(value.workspace, [
    'schemaVersion', 'cacheId', 'projectId', 'mediaId', 'trackId', 'projectStateVersion',
  ]) && value.workspace.schemaVersion === 1
    && UUID_V7.test(value.workspace.projectId ?? '')
    && value.workspace.mediaId === value.assetId
    && typeof value.workspace.cacheId === 'string' && value.workspace.cacheId.length > 0
    && value.workspace.cacheId.length <= 8192,
  'Installed media flow has no exact native workspace owner');
  invariant(value.subtitleMarkerVisible === true
    && hasExactKeys(value.uploadedSrtInfo, ['cacheId', 'fileName', 'v'])
    && value.uploadedSrtInfo.v === 2
    && value.uploadedSrtInfo.cacheId === value.workspace.cacheId
    && value.uploadedSrtInfo.fileName === 'osg-installed-media-smoke.srt',
  'Installed media flow lost the uploaded SRT state or rendered marker');
  invariant(Array.isArray(value.errorToastMessages) && value.errorToastMessages.length === 0,
    'Installed media flow displayed an error toast');
  invariant(hasExactKeys(value.session, ['media', 'playback', 'subtitleTrack'])
    && hasExactKeys(value.session.media, [
      'displayName', 'extension', 'id', 'kind', 'sizeBytes',
    ])
    && value.session.media.id === value.assetId
    && value.session.media.displayName === value.currentFileName
    && value.session.media.extension === 'mp4'
    && value.session?.media?.kind === 'video'
    && value.session.media.sizeBytes === EXPECTED_FIXTURE_BYTES
    && hasExactKeys(value.session.playback, [
      'byteLength', 'id', 'mimeType', 'playbackUrl',
    ])
    && UUID_V4.test(value.session.playback.id ?? '')
    && playback[2].toLowerCase() === value.session.playback.id.toLowerCase()
    && value.session.playback.playbackUrl === value.currentFileUrl
    && value.session.playback.mimeType === 'video/mp4'
    && value.session.playback.byteLength === EXPECTED_FIXTURE_BYTES
    && value.session.subtitleTrack === null,
  'Installed native session and visible media capability diverged');
  const installedToolIds = Array.isArray(value.tools?.tools)
    ? value.tools.tools.map((tool) => tool?.id).sort()
    : [];
  invariant(hasExactKeys(value.tools, ['schemaVersion', 'tools'])
    && value.tools.schemaVersion === 1
    && installedToolIds.length === EXPECTED_NATIVE_TOOL_IDS.length
    && installedToolIds.every((id, index) => id === EXPECTED_NATIVE_TOOL_IDS[index])
    && value.tools.tools.every((tool) => hasExactKeys(tool, [
      'activeRuntime', 'availableInstalledBytes', 'availableVersion', 'deliveryAvailable',
      'downloadBytes', 'id', 'installed', 'installedBytes', 'label', 'operation',
      'pendingRemoval', 'restartRequired', 'state', 'version',
    ])
      && tool.label === EXPECTED_NATIVE_TOOL_LABELS[tool.id]
      && tool.deliveryAvailable === true
      && tool.state === 'installed'
      && tool.installed === true
      && isSafeToolVersion(tool.version)
      && tool.availableVersion === tool.version
      && Number.isSafeInteger(tool.installedBytes) && tool.installedBytes > 0
      && Number.isSafeInteger(tool.downloadBytes) && tool.downloadBytes > 0
      && Number.isSafeInteger(tool.availableInstalledBytes)
      && tool.availableInstalledBytes > 0
      && tool.installedBytes === tool.availableInstalledBytes
      && tool.activeRuntime === true
      && tool.pendingRemoval === false
      && tool.restartRequired === false
      && tool.operation === null),
  'Installed native tools were not immediately active after parallel on-demand installation');
  const attributableDownloads = newDownloadJobs(value, guard.baselineDownloadJobIds);
  invariant(attributableDownloads.length === 1
    && attributableDownloads[0].state === 'succeeded'
    && attributableDownloads[0].progress?.basisPoints === 10_000
    && !value.jobs.some((job) => job.kind === 'renderVideo'),
  'Installed button flow did not finish one newly attributable download-only job');
  return value;
}

export function assertMediaFlowResult(value, guardOptions) {
  invariant(hasExactKeys(value, [
    'assetId', 'currentFileName', 'currentFileUrl', 'errorToastMessages', 'jobs', 'session',
    'playbackBytes', 'subtitleMarkerVisible', 'tools', 'uploadedSrtInfo', 'video', 'workspace',
  ]), 'Installed media flow returned an invalid result shape');
  const { playbackBytes, ...state } = value;
  assertMediaFlowState(state, guardOptions);
  invariant(hasExactKeys(playbackBytes, ['byteLength', 'sha256'])
    && playbackBytes.byteLength === EXPECTED_FIXTURE_BYTES
    && playbackBytes.sha256 === EXPECTED_FIXTURE_SHA256,
  'Installed media flow did not publish the reviewed fixture bytes');
  return value;
}

export function hasMediaFlowStarted(value, guardOptions) {
  const guard = normalizeFlowGuard(guardOptions);
  if (Array.isArray(value?.errorToastMessages) && value.errorToastMessages.length > 0) {
    throw new Error(
      `Installed media flow failed in the application: ${JSON.stringify(
        summarizeMediaFlowFailure(value),
      )}`,
    );
  }
  if (Array.isArray(value?.jobs)) {
    const baseline = new Set(guard.baselineDownloadJobIds);
    if (value.jobs.some((job) => (
      job?.kind === 'downloadMedia'
        && UUID_V7.test(job?.id ?? '')
        && !baseline.has(job.id)
    ))) return true;
  }
  return guard.priorAssetId === null
    && guard.baselineDownloadJobIds.length === 0
    && Array.isArray(value?.tools?.tools) && value.tools.tools.some((tool) => (
      tool.installed === true || tool.operation !== null || tool.state !== 'missing'
    ));
}

export function assertStagedReplacementPreservesActiveMedia(before, after, priorAssetId) {
  invariant(UUID_V7.test(priorAssetId ?? ''),
    'Installed media-flow staged replacement identity is invalid');
  invariant(before?.assetId === priorAssetId
    && before?.session?.media?.id === priorAssetId
    && before?.workspace?.mediaId === priorAssetId,
  'Installed media flow did not begin from one coherent prior asset');
  invariant(after?.assetId === before.assetId
    && after?.currentFileName === before.currentFileName
    && after?.currentFileUrl === before.currentFileUrl
    && after?.session?.media?.id === before.session.media.id
    && after?.session?.playback?.id === before.session.playback?.id
    && after?.workspace?.cacheId === before.workspace?.cacheId
    && after?.workspace?.projectId === before.workspace?.projectId
    && after?.uploadedSrtInfo?.cacheId === before.uploadedSrtInfo?.cacheId
    && after?.uploadedSrtInfo?.fileName === before.uploadedSrtInfo?.fileName
    && after?.subtitleMarkerVisible === before.subtitleMarkerVisible,
  'Staging replacement media mutated the active media or subtitle identity');
  return after;
}

export function assertFirstMediaDocumentPreserved(before, after) {
  const documentId = before?.uploadedSrtInfo?.cacheId;
  invariant(typeof documentId === 'string' && /^subtitle-document:[0-9a-f-]{36}$/.test(documentId),
    'First media attachment must start from a durable subtitle document');
  invariant(after?.workspace?.cacheId === documentId
    && after?.uploadedSrtInfo?.cacheId === documentId,
  'First media attachment replaced the imported subtitle document');
}
