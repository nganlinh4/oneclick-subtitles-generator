import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';
import {
  readPlaybackCapability,
  sanitizeInspectorError,
} from './inspect-installed-media-flow.mjs';

const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const PICKER_TAB_ACTIVATION_TIMEOUT_MS = 30_000;
const EXPECTED_FIXTURE_BYTES = 366_888;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-local-media-flow.mjs --port PORT '
        + '--expected-file-name NAME --screenshot PATH --phase-directory PATH '
        + '--prior-asset-id UUID');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 5, 'Only reviewed installed local-media arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  invariant(typeof environment.RUNNER_TEMP === 'string' && environment.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP is required for the installed local-media smoke');
  const runnerTemp = fs.realpathSync(environment.RUNNER_TEMP);
  const screenshot = path.resolve(values.get('--screenshot'));
  invariant(isInside(screenshot, runnerTemp), 'Screenshot must stay inside RUNNER_TEMP');
  invariant(!fs.existsSync(screenshot), 'Installed local-media screenshot path must be clean');
  const expectedFileName = values.get('--expected-file-name');
  invariant(typeof expectedFileName === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.mp4$/.test(expectedFileName)
    && path.basename(expectedFileName) === expectedFileName,
  'Expected local-media filename is invalid');
  const phaseDirectory = fs.realpathSync(values.get('--phase-directory'));
  invariant(phaseDirectory === runnerTemp,
    'Picker phase directory must be the canonical RUNNER_TEMP');
  const priorAssetId = values.get('--prior-asset-id');
  invariant(CANONICAL_UUID_V7.test(priorAssetId ?? ''),
    'Prior installed local-media asset identity is invalid');
  return Object.freeze({ port, expectedFileName, screenshot, phaseDirectory, priorAssetId });
}

export function writePickerPhase(phaseDirectory, stage) {
  invariant([
    'starting',
    'connected',
    'tab-activated',
    'control-ready',
    'prior-state-validated',
    'click-issued',
  ].includes(stage),
    'Installed local-media picker phase is invalid');
  const phasePath = path.join(phaseDirectory, `osg-installed-native-picker-${stage}.json`);
  const temporaryPath = `${phasePath}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, stage })}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.linkSync(temporaryPath, phasePath);
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The publication failure remains authoritative when descriptor cleanup also fails.
      }
    }
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The publication failure remains authoritative when scratch cleanup also fails.
    }
    throw error;
  }
}

export function assertPriorMediaState(value, priorAssetId, tabActivation) {
  invariant(CANONICAL_UUID_V7.test(priorAssetId ?? ''),
    'Prior installed local-media asset identity is invalid');
  invariant(tabActivation === 'already-active' || tabActivation === 'activated',
    'Installed local-media Upload File tab activation is invalid');
  const expectedRendererAssetId = tabActivation === 'already-active' ? priorAssetId : null;
  invariant(hasExactKeys(value, ['assetId', 'sessionMediaId'])
    && value.assetId === expectedRendererAssetId
    && value.sessionMediaId === priorAssetId,
  'Installed local-media flow did not begin from the reviewed prior native asset');
  return value;
}

export function assertLocalMediaResult(value, expectedFileName, priorAssetId) {
  invariant(hasExactKeys(value, [
    'assetId', 'currentFileUrl', 'displayedFileName', 'errorToastMessages', 'htmlFileInput',
    'inspection', 'playbackBytes', 'session', 'video',
  ]), 'Installed local-media flow returned an invalid result shape');
  const { playbackBytes, ...state } = value;
  assertLocalMediaState(state, expectedFileName, priorAssetId);
  invariant(hasExactKeys(playbackBytes, ['byteLength', 'sha256'])
    && playbackBytes.byteLength === EXPECTED_FIXTURE_BYTES
    && playbackBytes.sha256 === 'aecf6c8ef3977cd4525261ccadb4086581bd911cb17cc97128cfd8640c6055db',
  'Installed local-media playback bytes did not match the reviewed fixture');
  return value;
}

export function assertLocalMediaState(value, expectedFileName, priorAssetId) {
  invariant(CANONICAL_UUID_V7.test(priorAssetId ?? ''),
    'Prior installed local-media asset identity is invalid');
  invariant(hasExactKeys(value, [
    'assetId', 'currentFileUrl', 'displayedFileName', 'errorToastMessages', 'htmlFileInput',
    'inspection', 'session', 'video',
  ]), 'Installed local-media flow returned an invalid result shape');
  invariant(UUID_V7.test(value.assetId ?? ''),
    'Installed local-media flow did not publish a UUIDv7 asset');
  invariant(value.assetId !== priorAssetId,
    'Installed local-media flow retained the prior URL asset after native selection');
  const playback = typeof value.currentFileUrl === 'string'
    ? PLAYBACK_URL.exec(value.currentFileUrl)
    : null;
  invariant(playback !== null && Number(playback[1]) >= 1 && Number(playback[1]) <= 65_535,
    'Installed local-media flow did not publish an opaque loopback capability');
  invariant(UUID_V4.test(playback?.[2] ?? ''),
    'Installed local-media flow published an invalid playback identity');
  invariant(value.displayedFileName === expectedFileName,
    'Installed local-media flow did not render the selected display name');
  invariant(Array.isArray(value.errorToastMessages) && value.errorToastMessages.length === 0,
    'Installed local-media flow displayed an error toast');
  invariant(hasExactKeys(value.htmlFileInput, ['fileCount', 'value'])
    && value.htmlFileInput.fileCount === 0
    && value.htmlFileInput.value === '',
  'Installed local-media flow injected a path into the WebView file input');
  invariant(hasExactKeys(value.session, ['media', 'playback', 'subtitleTrack'])
    && hasExactKeys(value.session.media, [
      'displayName', 'extension', 'id', 'kind', 'sizeBytes',
    ])
    && value.session.media.id === value.assetId
    && value.session.media.id !== priorAssetId
    && value.session.media.kind === 'video'
    && value.session.media.displayName === expectedFileName
    && value.session.media.extension === 'mp4'
    && value.session.media.sizeBytes === EXPECTED_FIXTURE_BYTES
    && hasExactKeys(value.session.playback, ['byteLength', 'id', 'mimeType', 'playbackUrl'])
    && value.session.playback.id === playback[2]
    && value.session.playback.byteLength === EXPECTED_FIXTURE_BYTES
    && value.session.playback.mimeType === 'video/mp4'
    && value.session.playback.playbackUrl === value.currentFileUrl,
  'Installed local-media session and visible capability diverged');
  invariant(hasExactKeys(value.inspection, [
    'assetId', 'audioCodec', 'compatibilityAction', 'durationUs', 'frameRate', 'hasAudio',
    'hasVideo', 'height', 'issues', 'videoCodec', 'width',
  ])
    && value.inspection.assetId === value.assetId
    && value.inspection?.hasVideo === true
    && value.inspection?.hasAudio === true
    && value.inspection?.width === 640
    && value.inspection?.height === 360
    && value.inspection?.durationUs >= 3_900_000
    && value.inspection?.durationUs <= 4_100_000
    && value.inspection?.videoCodec === 'h264'
    && value.inspection?.audioCodec === 'aac'
    && Number.isFinite(value.inspection?.frameRate)
    && value.inspection.frameRate >= 23.9
    && value.inspection.frameRate <= 24.1
    && value.inspection?.compatibilityAction === 'direct'
    && Array.isArray(value.inspection?.issues)
    && value.inspection.issues.length === 0,
  'Installed local-media native inspection did not match the reviewed fixture');
  invariant(hasExactKeys(value.video, [
    'currentSrc', 'duration', 'height', 'paused', 'readyState', 'width',
  ])
    && value.video.currentSrc === value.currentFileUrl
    && Number.isFinite(value.video.duration)
    && value.video.duration >= 3.9 && value.video.duration <= 4.1
    && Number.isInteger(value.video.readyState) && value.video.readyState >= 1
    && value.video.width === 640
    && value.video.height === 360,
  'Installed local-media element did not decode the selected fixture');
  return value;
}

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 250)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      throw new Error(sanitizeInspectorError(error, 'Installed local-media probe failed'));
    }
    await delay();
  } while (now() < deadline);
  throw new Error('Installed local-media flow timed out before reaching the reviewed state');
}

export async function waitForPickerTabActivation(read, options = {}) {
  return waitForValue(
    read,
    (value) => value === 'already-active' || value === 'activated',
    { timeoutMs: PICKER_TAB_ACTIVATION_TIMEOUT_MS, ...options },
  );
}

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails, 'Installed local-media evaluation failed');
  return evaluation.result?.value;
};

export const OPEN_PICKER_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1 || !(containers[0] instanceof HTMLElement)) return null;
  const uploadTabs = [...containers[0].querySelectorAll(
    ':scope > .input-header > .input-tabs > button[data-input-tab="file-upload"]'
  )];
  if (uploadTabs.length !== 1 || !(uploadTabs[0] instanceof HTMLButtonElement)) return null;
  const uploadTab = uploadTabs[0];
  const tabList = uploadTab.parentElement;
  if (!(tabList instanceof HTMLElement)) return null;
  const tabs = [...tabList.querySelectorAll(':scope > button.tab-btn')];
  const directButtons = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement,
  );
  if (tabs.length < 2 || tabs.length > 3
      || !tabs.every((tab) => tab instanceof HTMLButtonElement)
      || directButtons.length !== tabs.length
      || !directButtons.every((button) => tabs.includes(button))) return null;
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  if (activeTabs.length !== 1) return null;
  if (uploadTab.classList.contains('active')) return 'already-active';
  uploadTab.click();
  return 'activated';
})()`;

export const PICKER_CONTROL_READY_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1 || !(containers[0] instanceof HTMLElement)) return false;
  const container = containers[0];
  const uploadTabs = [...container.querySelectorAll(
    ':scope > .input-header > .input-tabs > button[data-input-tab="file-upload"]'
  )];
  if (uploadTabs.length !== 1 || !(uploadTabs[0] instanceof HTMLButtonElement)) return false;
  const uploadTab = uploadTabs[0];
  const tabList = uploadTab.parentElement;
  if (!(tabList instanceof HTMLElement)) return false;
  const tabs = [...tabList.querySelectorAll(':scope > button.tab-btn')];
  const directButtons = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement,
  );
  if (tabs.length < 2 || tabs.length > 3
      || !tabs.every((tab) => tab instanceof HTMLButtonElement)
      || directButtons.length !== tabs.length
      || !directButtons.every((button) => tabs.includes(button))) return false;
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const pickers = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper div.file-upload-input:not(.loading)'
  )];
  if (pickers.length !== 1) return false;
  const picker = pickers[0];
  const input = picker?.querySelector(':scope > input.hidden-file-input[type="file"]');
  return activeTabs.length === 1
    && activeTabs[0] === uploadTab
    && picker instanceof HTMLDivElement
    && input instanceof HTMLInputElement;
})()`;

export const CLICK_PICKER_EXPRESSION = `
(() => {
  const containers = [...document.querySelectorAll('.input-methods-container')];
  if (containers.length !== 1 || !(containers[0] instanceof HTMLElement)) return false;
  const container = containers[0];
  const uploadTabs = [...container.querySelectorAll(
    ':scope > .input-header > .input-tabs > button[data-input-tab="file-upload"]'
  )];
  if (uploadTabs.length !== 1 || !(uploadTabs[0] instanceof HTMLButtonElement)) return false;
  const uploadTab = uploadTabs[0];
  const tabList = uploadTab.parentElement;
  if (!(tabList instanceof HTMLElement)) return false;
  const tabs = [...tabList.querySelectorAll(':scope > button.tab-btn')];
  const directButtons = [...tabList.children].filter(
    (child) => child instanceof HTMLButtonElement,
  );
  const activeTabs = tabs.filter((tab) => tab.classList.contains('active'));
  const pickers = [...container.querySelectorAll(
    ':scope > .tab-content-wrapper div.file-upload-input:not(.loading)'
  )];
  if (tabs.length < 2 || tabs.length > 3
      || !tabs.every((tab) => tab instanceof HTMLButtonElement)
      || directButtons.length !== tabs.length
      || !directButtons.every((button) => tabs.includes(button))
      || activeTabs.length !== 1 || activeTabs[0] !== uploadTab
      || pickers.length !== 1 || !(pickers[0] instanceof HTMLDivElement)) return false;
  const picker = pickers[0];
  const input = picker.querySelector(':scope > input.hidden-file-input[type="file"]');
  if (!(input instanceof HTMLInputElement)) return false;
  picker.click();
  return true;
})()`;

export const LOCAL_MEDIA_RESULT_EXPRESSION = `
(async () => {
  const assetId = localStorage.getItem('current_file_cache_id');
  const currentFileUrl = localStorage.getItem('current_file_url');
  const videoElement = document.querySelector('video.video-player');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let session = null;
  let inspection = null;
  if (typeof invoke === 'function') {
    session = await invoke('get_session_snapshot');
    if (${UUID_V7.toString()}.test(assetId ?? '')) {
      inspection = await invoke('media_pipeline_inspect', { assetId });
    }
  }
  return {
    assetId,
    currentFileUrl,
    displayedFileName: document.querySelector('.file-info-card .file-name')?.textContent?.trim()
      ?? null,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    htmlFileInput: (() => {
      const input = document.querySelector('.hidden-file-input[type="file"]');
      return input instanceof HTMLInputElement
        ? { fileCount: input.files?.length ?? null, value: input.value }
        : null;
    })(),
    inspection,
    session,
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

export const PRIOR_MEDIA_STATE_EXPRESSION = `
(async () => {
  const assetId = localStorage.getItem('current_file_cache_id');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let sessionMediaId = null;
  if (typeof invoke === 'function') {
    const session = await invoke('get_session_snapshot');
    sessionMediaId = session?.media?.id ?? null;
  }
  return { assetId, sessionMediaId };
})()`;

async function runInstalledLocalMediaFlow(options) {
  writePickerPhase(options.phaseDirectory, 'starting');
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    writePickerPhase(options.phaseDirectory, 'connected');
    // Closing Settings can briefly leave the reviewed input subtree absent. Retry only that
    // null/invalid observation; OPEN_PICKER_EXPRESSION returns success in the same evaluation
    // that clicks an inactive tab, so a successful activation is never clicked a second time.
    const tabActivation = await waitForPickerTabActivation(
      () => evaluate(client, OPEN_PICKER_EXPRESSION),
    );
    writePickerPhase(options.phaseDirectory, 'tab-activated');
    await waitForValue(
      () => evaluate(client, PICKER_CONTROL_READY_EXPRESSION),
      (value) => value === true,
      { timeoutMs: 30_000 },
    );
    writePickerPhase(options.phaseDirectory, 'control-ready');
    assertPriorMediaState(
      await evaluate(client, PRIOR_MEDIA_STATE_EXPRESSION),
      options.priorAssetId,
      tabActivation,
    );
    writePickerPhase(options.phaseDirectory, 'prior-state-validated');
    invariant(await evaluate(client, CLICK_PICKER_EXPRESSION) === true,
      'Installed local-media flow could not open the native picker');
    writePickerPhase(options.phaseDirectory, 'click-issued');
    const state = await waitForValue(
      () => evaluate(client, LOCAL_MEDIA_RESULT_EXPRESSION),
      (value) => {
        try {
          assertLocalMediaState(value, options.expectedFileName, options.priorAssetId);
          return true;
        } catch {
          return false;
        }
      },
    );
    assertLocalMediaState(state, options.expectedFileName, options.priorAssetId);
    const result = {
      ...state,
      playbackBytes: await readPlaybackCapability(state.currentFileUrl),
    };
    assertLocalMediaResult(result, options.expectedFileName, options.priorAssetId);
    const capture = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    invariant(typeof capture.data === 'string', 'Installed local-media screenshot was empty');
    const bytes = Buffer.from(capture.data, 'base64');
    invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Installed local-media screenshot is not a PNG');
    fs.writeFileSync(options.screenshot, bytes, { flag: 'wx' });
    return {
      assetId: result.assetId,
      displayedFileName: result.displayedFileName,
      fixtureBytes: result.session.media.sizeBytes,
      fixtureSha256: result.playbackBytes.sha256,
      nativeCompatibilityAction: result.inspection.compatibilityAction,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
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
    .then(() => runInstalledLocalMediaFlow(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${sanitizeInspectorError(error, 'Installed local-media flow failed')}\n`);
      process.exitCode = 1;
    });
}
