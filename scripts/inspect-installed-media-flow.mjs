import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';

// Public video sites reject shared GitHub-runner addresses unpredictably. This repository-owned,
// content-hash-named 4-second MP4 is hosted beside the managed development bundles so the clean
// installed-EXE smoke exercises the same all-sites yt-dlp/FFmpeg publication path deterministically.
// YouTube and other site-specific extractors remain separate real-network acceptance items.
const MEDIA_URL = 'https://github.com/nganlinh4/oneclick-subtitles-generator/releases/download/osg-runtime-bundles-v1/osg-installed-media-smoke-v1-aecf6c8ef3977cd4.mp4';
const SUBTITLE_MARKER = 'OSG installed media smoke';
const EXPECTED_FIXTURE_BYTES = 366_888;
const EXPECTED_FIXTURE_SHA256 = 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db';
const EXPECTED_NATIVE_TOOL_IDS = Object.freeze(['deno', 'media-tools', 'yt-dlp']);
const EXPECTED_NATIVE_TOOL_LABELS = Object.freeze({
  deno: 'Deno',
  'media-tools': 'FFmpeg and FFprobe',
  'yt-dlp': 'yt-dlp',
});
const CAPABILITY_READ_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const REVIEWED_TIMEOUT_FAILURE_CODES = Object.freeze([
  'url-tab-timeout',
  'url-stage-timeout',
  'srt-readiness-timeout',
  'download-start-timeout',
  'terminal-state-timeout',
]);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const isInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
};

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-media-flow.mjs --port PORT --srt PATH --screenshot PATH '
        + '--media-phase initial|reactivation '
        + '[--prior-asset-id UUID]');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const requiredKeys = ['--port', '--srt', '--screenshot', '--media-phase'];
  const acceptedKeys = new Set([...requiredKeys, '--prior-asset-id']);
  invariant((values.size === 4 || values.size === 5)
    && requiredKeys.every((key) => values.has(key))
    && [...values.keys()].every((key) => acceptedKeys.has(key)),
  'Only reviewed installed media-flow arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  invariant(typeof environment.RUNNER_TEMP === 'string' && environment.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP is required for the installed media-flow smoke');
  const runnerTemp = fs.realpathSync(environment.RUNNER_TEMP);
  const srt = fs.realpathSync(values.get('--srt'));
  const screenshot = path.resolve(values.get('--screenshot'));
  invariant(isInside(srt, runnerTemp), 'SRT fixture must stay inside RUNNER_TEMP');
  invariant(isInside(screenshot, runnerTemp), 'Screenshot must stay inside RUNNER_TEMP');
  const stats = fs.statSync(srt);
  invariant(stats.isFile() && stats.size > 0 && stats.size <= 64 * 1_024,
    'SRT fixture must be a bounded regular file');
  invariant(path.extname(srt).toLowerCase() === '.srt', 'SRT fixture must use the .srt extension');
  invariant(!fs.existsSync(screenshot), 'Installed media-flow screenshot path must be clean');
  const priorAssetId = values.get('--prior-asset-id') ?? null;
  invariant(priorAssetId === null || UUID_V7.test(priorAssetId),
    'Prior installed media asset identity is invalid');
  const mediaPhase = values.get('--media-phase');
  mediaPreferencesForPhase(mediaPhase);
  invariant((mediaPhase === 'initial' && priorAssetId === null)
    || (mediaPhase === 'reactivation' && priorAssetId !== null),
  'Installed media-flow phase and prior asset are inconsistent');
  return Object.freeze({ port, srt, screenshot, priorAssetId, mediaPhase });
}

export function mediaPreferencesForPhase(mediaPhase) {
  if (mediaPhase === 'initial') {
    return Object.freeze({ autoImport: 'true', preferredLanguages: '["en"]' });
  }
  if (mediaPhase === 'reactivation') {
    return Object.freeze({ autoImport: 'false', preferredLanguages: '["en"]' });
  }
  throw new Error('Installed media-flow phase is invalid');
}

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

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

const newDownloadJobs = (value, baselineDownloadJobIds) => {
  const baseline = new Set(baselineDownloadJobIds);
  collectDownloadJobIds(value);
  return value.jobs.filter((job) => (
    job?.kind === 'downloadMedia' && !baseline.has(job.id)
  ));
};

export function sanitizeInspectorError(error, fallback = 'Installed media flow failed') {
  const raw = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : fallback;
  const sanitized = raw
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, '<redacted-url>')
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\\\\|file:(?:\/\/)?|\/(?:Users|home|tmp|var|private|mnt|opt|Volumes)(?:\/|$))[^'"]*\1/giu,
      '<redacted-path>')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|file:(?:\/\/)?)[^\s"'<>]+/giu, '<redacted-path>')
    .replace(/\/(?:Users|home|tmp|var|private|mnt|opt|Volumes)(?:\/[^\s"'<>]*)?/gu,
      '<redacted-path>')
    .replace(/\b(?:127\.0\.0\.1|localhost)\b/giu, '<redacted-host>')
    .replace(/\b(?:currentFileUrl|playbackUrl|token)\b/giu, 'capability')
    .replace(/\b[0-9a-f]{64}\b/giu, '<redacted-capability>')
    .slice(0, 2_048);
  return sanitized.length > 0 ? sanitized : fallback;
}

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

export async function readPlaybackCapability(playbackUrl, {
  fetchImpl = globalThis.fetch,
  timeoutMs = CAPABILITY_READ_TIMEOUT_MS,
} = {}) {
  const playback = typeof playbackUrl === 'string' ? PLAYBACK_URL.exec(playbackUrl) : null;
  invariant(playback !== null && Number(playback[1]) >= 1 && Number(playback[1]) <= 65_535,
    'Installed playback capability is invalid');
  invariant(typeof fetchImpl === 'function'
    && Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= CAPABILITY_READ_TIMEOUT_MS,
  'Installed playback capability reader is invalid');

  try {
    const response = await fetchImpl(playbackUrl, {
      cache: 'no-store',
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response?.ok !== true || response.status !== 200
        || response.headers?.get?.('content-type')?.split(';', 1)[0] !== 'video/mp4') {
      throw new Error('response');
    }
    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null && declaredLength !== String(EXPECTED_FIXTURE_BYTES)) {
      throw new Error('length');
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error('body');
    }

    const hash = crypto.createHash('sha256');
    const reader = response.body.getReader();
    let byteLength = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw new Error('chunk');
      byteLength += chunk.value.byteLength;
      if (byteLength > EXPECTED_FIXTURE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('oversize');
      }
      hash.update(chunk.value);
    }
    if (byteLength !== EXPECTED_FIXTURE_BYTES) throw new Error('truncated');
    return Object.freeze({ byteLength, sha256: hash.digest('hex') });
  } catch {
    throw new Error('Installed playback capability could not be verified');
  }
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

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails, 'Installed media-flow evaluation failed');
  return evaluation.result?.value;
};

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
  failureCode = 'terminal-state-timeout',
} = {}) {
  invariant(REVIEWED_TIMEOUT_FAILURE_CODES.includes(failureCode),
    'Installed media-flow timeout category is invalid');
  const deadline = now() + timeoutMs;
  do {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      throw new Error(sanitizeInspectorError(error, 'Installed media-flow probe failed'));
    }
    await delay();
  } while (now() < deadline);
  throw new Error(`Installed media flow timed out: ${failureCode}`);
}

const CONFIGURE_MEDIA_PHASE_EXPRESSION = (preferences) => `
(() => {
  localStorage.setItem('auto_import_site_subtitles', ${JSON.stringify(preferences.autoImport)});
  localStorage.setItem('preferred_subtitle_langs', ${JSON.stringify(preferences.preferredLanguages)});
  return localStorage.getItem('auto_import_site_subtitles')
      === ${JSON.stringify(preferences.autoImport)}
    && localStorage.getItem('preferred_subtitle_langs')
      === ${JSON.stringify(preferences.preferredLanguages)};
})()`;

const SET_URL_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  if (tabs.length < 2 || tabs.length > 3 || urlTabs.length !== 1
      || activeTabs.length !== 1 || activeTabs[0] !== urlTabs[0]) return false;
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  if (inputs.length !== 1) return false;
  const input = inputs[0];
  if (!(input instanceof HTMLInputElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (typeof setter !== 'function') return false;
  setter.call(input, ${JSON.stringify(MEDIA_URL)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const ACTIVATE_URL_TAB_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return null;
  const tabList = containers[0].querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return null;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  if (tabs.length < 2 || tabs.length > 3 || urlTabs.length !== 1
      || activeTabs.length !== 1) return null;
  if (activeTabs[0] === urlTabs[0]) return 'already-active';
  urlTabs[0].click();
  return 'activated';
})()`;

const URL_CONTROL_READY_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement;
})()`;

const URL_STAGED_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement
    && inputs[0].value === ${JSON.stringify(MEDIA_URL)}
    && previews.length === 1
    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)};
})()`;

const SRT_READY_EXPRESSION = (preferences, expectedCacheId) => `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  const groups = [...document.querySelectorAll(
    '.buttons-container .srt-upload-buttons-group'
  )];
  if (containers.length !== 1 || groups.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  const group = groups[0];
  const uploadButtons = [...group.querySelectorAll(':scope .srt-upload-button')];
  const clearButtons = [...group.children].filter(
    (child) => child instanceof HTMLButtonElement
      && child.classList.contains('clear-subtitles-button')
  );
  const buttonContainers = [...document.querySelectorAll('.buttons-container')];
  if (buttonContainers.length !== 1) return false;
  const startButtons = [...buttonContainers[0].querySelectorAll(
    ':scope .generate-btn.semi-auto'
  )];
  let info = null;
  try { info = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  return tabs.length >= 2 && tabs.length <= 3
    && urlTabs.length === 1
    && activeTabs.length === 1 && activeTabs[0] === urlTabs[0]
    && inputs.length === 1 && inputs[0] instanceof HTMLInputElement
    && inputs[0].value === ${JSON.stringify(MEDIA_URL)}
    && previews.length === 1
    && (previews[0].textContent ?? '').trim() === ${JSON.stringify(MEDIA_URL)}
    && localStorage.getItem('auto_import_site_subtitles')
      === ${JSON.stringify(preferences.autoImport)}
    && localStorage.getItem('preferred_subtitle_langs')
      === ${JSON.stringify(preferences.preferredLanguages)}
    && uploadButtons.length === 1
    && uploadButtons[0].classList.contains('has-srt-uploaded')
    && !uploadButtons[0].classList.contains('processing')
    && !uploadButtons[0].disabled
    && clearButtons.length === 1 && !clearButtons[0].disabled
    && info && typeof info === 'object' && !Array.isArray(info)
    && Object.keys(info).sort().join(',') === 'cacheId,fileName,v'
    && info.v === 2
    && info.cacheId === ${JSON.stringify(expectedCacheId)}
    && info.fileName === 'osg-installed-media-smoke.srt'
    && document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)})
    && startButtons.length === 1
    && startButtons[0] instanceof HTMLButtonElement
    && !startButtons[0].disabled
    && startButtons[0].dataset.generationMode === 'url-with-srt';
})()`;

const START_EXPRESSION = (preferences, expectedCacheId) => `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  const buttonContainers = [...document.querySelectorAll('.buttons-container')];
  if (containers.length !== 1 || buttonContainers.length !== 1) return false;
  const container = containers[0];
  const tabList = container.querySelector(':scope > .input-header > .input-tabs');
  if (!(tabList instanceof HTMLDivElement)) return false;
  const tabs = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement && child.classList.contains('tab-btn')
  );
  const urlTabs = tabs.filter((tab) => tab.dataset.inputTab === 'unified-url');
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const inputs = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper input.url-field'
  )];
  const previews = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper .selected-video-preview .video-url-value'
  )];
  const groups = [...buttonContainers[0].querySelectorAll(
    ':scope .srt-upload-buttons-group'
  )];
  if (groups.length !== 1) return false;
  const uploadButtons = [...groups[0].querySelectorAll(':scope .srt-upload-button')];
  const clearButtons = [...groups[0].children].filter(
    (child) => child instanceof HTMLButtonElement
      && child.classList.contains('clear-subtitles-button')
  );
  const buttons = [...buttonContainers[0].querySelectorAll(
    ':scope .generate-btn.semi-auto'
  )];
  let info = null;
  try { info = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  if (tabs.length < 2 || tabs.length > 3
      || urlTabs.length !== 1
      || activeTabs.length !== 1 || activeTabs[0] !== urlTabs[0]
      || inputs.length !== 1 || !(inputs[0] instanceof HTMLInputElement)
      || inputs[0].value !== ${JSON.stringify(MEDIA_URL)}
      || previews.length !== 1
      || (previews[0].textContent ?? '').trim() !== ${JSON.stringify(MEDIA_URL)}
      || localStorage.getItem('auto_import_site_subtitles')
        !== ${JSON.stringify(preferences.autoImport)}
      || localStorage.getItem('preferred_subtitle_langs')
        !== ${JSON.stringify(preferences.preferredLanguages)}
      || uploadButtons.length !== 1
      || !uploadButtons[0].classList.contains('has-srt-uploaded')
      || uploadButtons[0].classList.contains('processing')
      || uploadButtons[0].disabled
      || clearButtons.length !== 1 || clearButtons[0].disabled
      || !info || typeof info !== 'object' || Array.isArray(info)
      || Object.keys(info).sort().join(',') !== 'cacheId,fileName,v'
      || info.v !== 2
      || info.cacheId !== ${JSON.stringify(expectedCacheId)}
      || info.fileName !== 'osg-installed-media-smoke.srt'
      || !document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)})
      || buttons.length !== 1 || !(buttons[0] instanceof HTMLButtonElement)
      || buttons[0].disabled
      || buttons[0].dataset.generationMode !== 'url-with-srt') return false;
  buttons[0].click();
  return true;
})()`;

export const MEDIA_RESULT_EXPRESSION = `
(async () => {
  const videoElement = document.querySelector('video.video-player');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let tools = null;
  let jobs = null;
  let session = null;
  let workspaceState = null;
  if (typeof invoke === 'function') {
    [tools, jobs, session, workspaceState] = await Promise.all([
      invoke('native_tools_status'),
      invoke('jobs_list'),
      invoke('get_session_snapshot'),
      invoke('active_workspace_get'),
    ]);
  }
  const assetId = session?.media?.id ?? null;
  const currentFileUrl = videoElement?.currentSrc ?? null;
  const currentFileName = session?.media?.displayName ?? null;
  let uploadedSrtInfo = null;
  try { uploadedSrtInfo = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  return {
    assetId,
    currentFileName,
    currentFileUrl,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    jobs,
    session,
    workspace: workspaceState?.initialized === true ? workspaceState.workspace : null,
    subtitleMarkerVisible: document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)}),
    tools,
    uploadedSrtInfo,
    video: videoElement ? {
      currentSrc: videoElement.currentSrc,
      duration: videoElement.duration,
      height: videoElement.videoHeight,
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      width: videoElement.videoWidth,
    } : null,
  };
})()`;

async function runInstalledMediaFlow(options) {
  const mediaPreferences = mediaPreferencesForPhase(options.mediaPhase);
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('DOM.enable');
    await waitForValue(
      () => evaluate(client, ACTIVATE_URL_TAB_EXPRESSION),
      (value) => value === 'already-active' || value === 'activated',
      { timeoutMs: 30_000, failureCode: 'url-tab-timeout' },
    );
    await waitForValue(
      () => evaluate(client, URL_CONTROL_READY_EXPRESSION),
      (value) => value === true,
      { timeoutMs: 30_000, failureCode: 'url-tab-timeout' },
    );
    // This smoke owns a disposable isolated profile. Keep the exact phase preferences in place
    // through START so the product action reads the reviewed native-adapter cache-key dimension.
    invariant(await evaluate(client, CONFIGURE_MEDIA_PHASE_EXPRESSION(mediaPreferences)) === true,
      'Installed media flow could not configure the reviewed phase');
    const activeState = options.priorAssetId === null
      ? null
      : await evaluate(client, MEDIA_RESULT_EXPRESSION);
    const priorCacheId = activeState?.workspace?.cacheId ?? null;
    invariant(await evaluate(client, SET_URL_EXPRESSION) === true,
      'Installed media flow could not enter the reviewed URL');
    await waitForValue(
      () => evaluate(client, URL_STAGED_EXPRESSION),
      (value) => value === true,
      { timeoutMs: 60_000, failureCode: 'url-stage-timeout' },
    );
    if (options.priorAssetId !== null) {
      const stagedState = await evaluate(client, MEDIA_RESULT_EXPRESSION);
      assertStagedReplacementPreservesActiveMedia(
        activeState, stagedState, options.priorAssetId,
      );
    }
    // Import explicitly for this project. Native local-media activation intentionally does not
    // inherit the preceding URL project's captions or its uploaded-SRT provenance.
    {
      const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const inputs = await client.send('DOM.querySelectorAll', {
        nodeId: documentNode.root.nodeId,
        selector: '.buttons-container .srt-upload-buttons-group input[type="file"][accept=".srt,.json"]',
      });
      invariant(Array.isArray(inputs.nodeIds) && inputs.nodeIds.length === 1
        && Number.isInteger(inputs.nodeIds[0]) && inputs.nodeIds[0] > 0,
      'Installed media flow could not find one exact SRT input');
      await client.send('DOM.setFileInputFiles', {
        files: [options.srt], nodeId: inputs.nodeIds[0],
      });
    }
    await waitForValue(
      () => evaluate(client, SRT_READY_EXPRESSION(mediaPreferences, priorCacheId)),
      (value) => value === true,
      { timeoutMs: 60_000, failureCode: 'srt-readiness-timeout' },
    );
    const baselineState = await evaluate(client, MEDIA_RESULT_EXPRESSION);
    const baselineDownloadJobIds = collectDownloadJobIds(baselineState);
    if (options.priorAssetId !== null) {
      invariant(baselineState?.session?.media?.id === options.priorAssetId,
        'Installed media flow did not begin from the reviewed prior asset');
    }
    const flowGuard = {
      priorAssetId: options.priorAssetId,
      baselineDownloadJobIds,
    };
    invariant(await evaluate(
      client, START_EXPRESSION(mediaPreferences, priorCacheId),
    ) === true,
      'Installed media flow could not click the real semi-automatic action');
    await waitForValue(
      () => evaluate(client, MEDIA_RESULT_EXPRESSION),
      (value) => hasMediaFlowStarted(value, flowGuard),
      { timeoutMs: 30_000, failureCode: 'download-start-timeout' },
    );
    let completedAt = null;
    let lastStateRefusal = 'No accepted media state';
    const state = await waitForValue(
      () => evaluate(client, MEDIA_RESULT_EXPRESSION),
      (value) => {
        hasMediaFlowStarted(value, flowGuard);
        try {
          assertMediaFlowState(value, flowGuard);
          return true;
        } catch (error) {
          lastStateRefusal = sanitizeInspectorError(error, 'Invalid installed media state');
          const downloads = newDownloadJobs(value, baselineDownloadJobIds);
          if (downloads.some((job) => job.state === 'failed' || job.state === 'cancelled')) {
            throw new Error(`Installed download terminated without success: ${lastStateRefusal}`);
          }
          if (downloads.length === 1 && downloads[0].state === 'succeeded') {
            completedAt ??= Date.now();
            if (Date.now() - completedAt > 30_000) {
              throw new Error(`Installed completed download did not settle: ${lastStateRefusal}`);
            }
          }
          return false;
        }
      },
      { failureCode: 'terminal-state-timeout' },
    );
    assertMediaFlowState(state, flowGuard);
    const result = {
      ...state,
      playbackBytes: await readPlaybackCapability(state.currentFileUrl),
    };
    assertMediaFlowResult(result, flowGuard);
    const capture = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    invariant(typeof capture.data === 'string', 'Installed media-flow screenshot was empty');
    const bytes = Buffer.from(capture.data, 'base64');
    invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Installed media-flow screenshot is not a PNG');
    fs.writeFileSync(options.screenshot, bytes, { flag: 'wx' });
    return {
      assetId: result.assetId,
      currentFileName: result.currentFileName,
      downloadJobs: newDownloadJobs(result, baselineDownloadJobIds).length,
      renderJobs: result.jobs.filter((job) => job.kind === 'renderVideo').length,
      fixtureBytes: result.playbackBytes.byteLength,
      fixtureSha256: result.playbackBytes.sha256,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      toolVersions: Object.fromEntries(result.tools.tools.map((tool) => [tool.id, tool.version])),
      videoDuration: result.video.duration,
      videoHeight: result.video.height,
      videoWidth: result.video.width,
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledMediaFlow(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${sanitizeInspectorError(error)}\n`);
      process.exitCode = 1;
    });
}
