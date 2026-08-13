import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';
import { sanitizeInspectorError } from './inspect-installed-media-flow.mjs';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const TOOL_IDS = Object.freeze(['deno', 'media-tools', 'yt-dlp']);
const TOOL_LABELS = Object.freeze({
  deno: 'Deno',
  'media-tools': 'FFmpeg and FFprobe',
  'yt-dlp': 'yt-dlp',
});
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS_KEYS = Object.freeze([
  'activeRuntime', 'availableInstalledBytes', 'availableVersion', 'deliveryAvailable',
  'downloadBytes', 'id', 'installed', 'installedBytes', 'label', 'operation',
  'pendingRemoval', 'restartRequired', 'state', 'version',
]);
const PIPELINE_KEYS = Object.freeze([
  'assetId', 'audioCodec', 'compatibilityAction', 'durationUs', 'frameRate', 'hasAudio',
  'hasVideo', 'height', 'issues', 'videoCodec', 'width',
]);

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const isInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const isSafeVersion = (value) => typeof value === 'string'
  && value.length >= 1 && value.length <= 128
  && [...value].every((character) => {
    const point = character.codePointAt(0);
    return point >= 32 && point !== 127 && (point < 128 || point > 159);
  });

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-native-tools.mjs --port PORT --asset-id UUID '
        + '--installing-screenshot PATH --installed-screenshot PATH');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 4, 'Only reviewed installed native-tool arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  const assetId = values.get('--asset-id');
  invariant(UUID_V7.test(assetId ?? ''), 'Installed native-tool asset identity is invalid');
  invariant(typeof environment.RUNNER_TEMP === 'string' && environment.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP is required for the installed native-tool smoke');
  const runnerTemp = fs.realpathSync(environment.RUNNER_TEMP);
  const installingScreenshot = path.resolve(values.get('--installing-screenshot'));
  const installedScreenshot = path.resolve(values.get('--installed-screenshot'));
  invariant(isInside(installingScreenshot, runnerTemp)
    && isInside(installedScreenshot, runnerTemp)
    && installingScreenshot !== installedScreenshot,
  'Installed native-tool screenshots must be distinct children of RUNNER_TEMP');
  invariant(!fs.existsSync(installingScreenshot) && !fs.existsSync(installedScreenshot),
    'Installed native-tool screenshot paths must be clean');
  return Object.freeze({ port, assetId, installingScreenshot, installedScreenshot });
}

const assertJob = (job) => {
  invariant(hasExactKeys(job, ['id', 'kind', 'progress', 'sequence', 'state'])
    && UUID_V7.test(job.id ?? '')
    && job.kind === 'installEngine'
    && job.state === 'running'
    && hasExactKeys(job.progress, ['basisPoints'])
    && Number.isSafeInteger(job.progress.basisPoints)
    && job.progress.basisPoints >= 0 && job.progress.basisPoints < 10_000
    && Number.isSafeInteger(job.sequence) && job.sequence >= 1,
  'Installed native-tool operation returned an invalid job');
};

const assertOperation = (operation, toolId) => {
  invariant(hasExactKeys(operation, [
    'action', 'basisPoints', 'bytesDone', 'job', 'phase', 'tool', 'totalBytes',
  ]), 'Installed native-tool operation returned an invalid shape');
  assertJob(operation.job);
  invariant(operation.tool === toolId
    && operation.action === 'install'
    && ['preparing', 'downloading', 'extracting', 'publishing'].includes(operation.phase)
    && operation.basisPoints === operation.job.progress.basisPoints
    && Number.isSafeInteger(operation.bytesDone) && operation.bytesDone >= 0
    && Number.isSafeInteger(operation.totalBytes) && operation.totalBytes >= 0
    && operation.bytesDone <= operation.totalBytes,
  'Installed native-tool operation did not prove a bounded install');
};

export function assertNativeToolsStatus(value, expected) {
  invariant(['missing', 'installing', 'installed'].includes(expected),
    'Installed native-tool expected state is invalid');
  const tools = Array.isArray(value?.tools) ? [...value.tools].sort((a, b) => (
    String(a?.id).localeCompare(String(b?.id))
  )) : [];
  invariant(hasExactKeys(value, ['schemaVersion', 'tools'])
    && value.schemaVersion === 1
    && tools.length === TOOL_IDS.length
    && tools.every((tool, index) => tool?.id === TOOL_IDS[index]),
  'Installed native-tool status omitted the exact tool catalog');
  const jobIds = [];
  for (const tool of tools) {
    invariant(hasExactKeys(tool, STATUS_KEYS)
      && tool.label === TOOL_LABELS[tool.id]
      && tool.deliveryAvailable === true
      && isSafeVersion(tool.availableVersion)
      && Number.isSafeInteger(tool.downloadBytes) && tool.downloadBytes > 0
      && Number.isSafeInteger(tool.availableInstalledBytes)
      && tool.availableInstalledBytes > 0
      && tool.pendingRemoval === false
      && tool.restartRequired === false,
    'Installed native-tool status returned an invalid catalog entry');
    if (expected === 'installed') {
      invariant(tool.installed === true
        && tool.state === 'installed'
        && isSafeVersion(tool.version)
        && tool.version === tool.availableVersion
        && tool.installedBytes === tool.availableInstalledBytes
        && tool.activeRuntime === true
        && tool.operation === null,
      'Installed native-tool status did not prove a hot active runtime');
    } else if (expected === 'missing') {
      invariant(tool.installed === false
        && tool.state === 'missing'
        && tool.version === null
        && tool.installedBytes === 0
        && tool.activeRuntime === false
        && tool.operation === null,
      'Installed native-tool status did not prove complete removal');
    } else {
      invariant(tool.installed === false
        && tool.state === 'missing'
        && tool.version === null
        && tool.installedBytes === 0
        && tool.activeRuntime === false,
      'Installed native-tool install did not begin from missing state');
      assertOperation(tool.operation, tool.id);
      jobIds.push(tool.operation.job.id);
    }
  }
  invariant(expected !== 'installing' || new Set(jobIds).size === TOOL_IDS.length,
    'Installed native-tool installs did not use three distinct jobs');
  return Object.freeze({
    tools: Object.freeze(tools.map((tool) => Object.freeze({
      id: tool.id,
      version: tool.version,
      jobId: tool.operation?.job.id ?? null,
    }))),
  });
}

export function assertToolDomState(value, expected) {
  invariant(['missing', 'installing', 'installed'].includes(expected)
    && hasExactKeys(value, ['errorCount', 'panelActive', 'rows', 'settingsOpen'])
    && value.settingsOpen === true
    && value.panelActive === true
    && value.errorCount === 0
    && Array.isArray(value.rows)
    && value.rows.length === TOOL_IDS.length,
  'Installed native-tool UI did not expose the reviewed Tools panel');
  const expectedAction = expected === 'missing' ? 'install'
    : expected === 'installing' ? 'cancel' : 'remove-request';
  const rows = [...value.rows].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
  invariant(rows.every((row, index) => hasExactKeys(row, ['actions', 'id', 'state'])
    && row.id === TOOL_IDS[index]
    && row.state === expected
    && Array.isArray(row.actions)
    && row.actions.length === 1
    && row.actions[0] === expectedAction),
  'Installed native-tool UI did not reach the reviewed row state');
  return value;
}

export function assertRemovedCapabilities(value) {
  invariant(hasExactKeys(value, ['download', 'pipelineErrorCode'])
    && hasExactKeys(value.download, [
      'available', 'inspectAvailable', 'inventoryTtlSeconds', 'maxConcurrentDownloads',
      'reason', 'version',
    ])
    && value.download.available === false
    && value.download.inspectAvailable === false
    && value.download.version === null
    && value.download.reason === 'downloaderUnavailable'
    && value.download.maxConcurrentDownloads === 4
    && value.download.inventoryTtlSeconds === 900
    && value.pipelineErrorCode === 'mediaToolsUnavailable',
  'Installed native-tool removal did not deactivate download and media consumers');
  return value;
}

export function assertActiveCapabilities(value, assetId) {
  invariant(UUID_V7.test(assetId ?? '')
    && hasExactKeys(value, ['download', 'pipeline'])
    && hasExactKeys(value.download, [
      'available', 'inspectAvailable', 'inventoryTtlSeconds', 'maxConcurrentDownloads',
      'reason', 'version',
    ])
    && value.download.available === true
    && value.download.inspectAvailable === true
    && isSafeVersion(value.download.version)
    && value.download.reason === null
    && value.download.maxConcurrentDownloads === 4
    && value.download.inventoryTtlSeconds === 900
    && hasExactKeys(value.pipeline, PIPELINE_KEYS)
    && value.pipeline.assetId === assetId
    && value.pipeline.hasVideo === true
    && value.pipeline.hasAudio === true
    && value.pipeline.width === 640
    && value.pipeline.height === 360
    && Number.isSafeInteger(value.pipeline.durationUs)
    && value.pipeline.durationUs >= 3_900_000 && value.pipeline.durationUs <= 4_100_000
    && Number.isFinite(value.pipeline.frameRate)
    && value.pipeline.frameRate >= 23.9 && value.pipeline.frameRate <= 24.1
    && value.pipeline.videoCodec === 'h264'
    && value.pipeline.audioCodec === 'aac'
    && value.pipeline.compatibilityAction === 'direct'
    && Array.isArray(value.pipeline.issues) && value.pipeline.issues.length === 0,
  'Installed native-tool reinstall did not hot-reactivate real consumers');
  return value;
}

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    const value = await read();
    if (accept(value)) return value;
    await delay();
  } while (now() < deadline);
  throw new Error('Installed native-tool UI timed out before reaching the reviewed state');
}

const evaluate = async (client, expression) => {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!result.exceptionDetails, 'Installed native-tool evaluation failed');
  return result.result?.value;
};

const OPEN_SETTINGS_EXPRESSION = `
(() => {
  if (document.querySelector('[data-settings-tab="tools"]')) return true;
  const button = document.querySelector('[data-app-action="open-settings"]');
  if (!(button instanceof HTMLButtonElement)) return false;
  button.click();
  return true;
})()`;

const ACTIVATE_TOOLS_EXPRESSION = `
(() => {
  const tab = document.querySelector('[data-settings-tab="tools"]');
  if (!(tab instanceof HTMLButtonElement)) return false;
  tab.click();
  return true;
})()`;

const CLOSE_SETTINGS_EXPRESSION = `
(() => {
  const button = document.querySelector('[data-settings-action="close"]');
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`;

const DOM_STATE_EXPRESSION = `
(() => {
  const ids = ${JSON.stringify(TOOL_IDS)};
  const rows = ids.map((id) => {
    const row = document.querySelector('[data-native-tool-id="' + id + '"]');
    const state = ['missing', 'installing', 'installed'].find(
      (candidate) => row?.classList.contains('engine-card--' + candidate),
    ) ?? null;
    return {
      id,
      state,
      actions: row ? [...row.querySelectorAll('[data-tool-action]')]
        .map((button) => button.getAttribute('data-tool-action')).sort() : [],
    };
  });
  return {
    settingsOpen: document.querySelector('[data-settings-tab="tools"]') !== null,
    panelActive: document.querySelector('[data-settings-panel="tools"].active') !== null,
    errorCount: document.querySelectorAll(
      '[data-settings-panel="tools"] .engine-card__error, .toast-error',
    ).length,
    rows,
  };
})()`;

const clickToolActionsExpression = (action) => `
(() => {
  const rows = ${JSON.stringify(TOOL_IDS)}.map(
    (id) => document.querySelector('[data-native-tool-id="' + id + '"]'),
  );
  const buttons = rows.map((row) => row?.querySelector('[data-tool-action="${action}"]'));
  if (buttons.some((button) => !(button instanceof HTMLButtonElement))) return false;
  const states = buttons.map((button) => ({
    connected: button.isConnected,
    disabled: button.disabled,
    action: button.getAttribute('data-tool-action'),
  }));
  buttons.forEach((button) => button.click());
  return states;
})()`;

const confirmRemovalsExpression = `
(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const ids = ${JSON.stringify(TOOL_IDS)};
  const buttons = ids.map((id) => document.querySelector(
    '[data-native-tool-id="' + id + '"] [data-tool-action="remove-confirm"]',
  ));
  if (buttons.some((button) => !(button instanceof HTMLButtonElement))) return false;
  const states = buttons.map((button) => ({
    connected: button.isConnected,
    disabled: button.disabled,
    action: button.getAttribute('data-tool-action'),
  }));
  buttons.forEach((button) => button.click());
  return states;
})()`;

const assertClickedActions = (value, action) => {
  invariant(Array.isArray(value)
    && value.length === TOOL_IDS.length
    && value.every((entry) => hasExactKeys(entry, ['action', 'connected', 'disabled'])
      && entry.action === action
      && entry.connected === true
      && entry.disabled === false),
  `Installed native-tool flow could not click every ${action} action`);
};

const NATIVE_STATUS_EXPRESSION = `window.__TAURI_INTERNALS__?.invoke('native_tools_status')`;

const removedCapabilitiesExpression = (assetId) => `
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return null;
  const download = await invoke('download_status');
  let pipelineErrorCode = null;
  try {
    await invoke('media_pipeline_inspect', { assetId: ${JSON.stringify(assetId)} });
  } catch (error) {
    pipelineErrorCode = typeof error?.code === 'string' ? error.code : null;
  }
  return { download, pipelineErrorCode };
})()`;

const activeCapabilitiesExpression = (assetId) => `
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return null;
  const [download, pipeline] = await Promise.all([
    invoke('download_status'),
    invoke('media_pipeline_inspect', { assetId: ${JSON.stringify(assetId)} }),
  ]);
  return { download, pipeline };
})()`;

const captureScreenshot = async (client, destination) => {
  const capture = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  invariant(typeof capture.data === 'string', 'Installed native-tool screenshot was empty');
  const bytes = Buffer.from(capture.data, 'base64');
  invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'Installed native-tool screenshot was not a PNG');
  fs.writeFileSync(destination, bytes, { flag: 'wx' });
  return Object.freeze({
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
};

const waitForDom = (client, expected, delayMs = 500) => waitForValue(
  () => evaluate(client, DOM_STATE_EXPRESSION),
  (value) => {
    try {
      assertToolDomState(value, expected);
      return true;
    } catch {
      return false;
    }
  },
  { delay: () => new Promise((resolve) => setTimeout(resolve, delayMs)) },
);

async function runInstalledNativeTools(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    invariant(await evaluate(client, OPEN_SETTINGS_EXPRESSION) === true,
      'Installed native-tool flow could not open Settings');
    await waitForValue(
      () => evaluate(client, "document.querySelector('[data-settings-tab=\"tools\"]') !== null"),
      (value) => value === true,
      { timeoutMs: 30_000 },
    );
    invariant(await evaluate(client, ACTIVATE_TOOLS_EXPRESSION) === true,
      'Installed native-tool flow could not activate Tools');
    await waitForDom(client, 'installed');
    assertNativeToolsStatus(await evaluate(client, NATIVE_STATUS_EXPRESSION), 'installed');

    assertClickedActions(
      await evaluate(client, clickToolActionsExpression('remove-request')), 'remove-request',
    );
    assertClickedActions(await evaluate(client, confirmRemovalsExpression), 'remove-confirm');
    await waitForDom(client, 'missing');
    const removed = assertNativeToolsStatus(
      await evaluate(client, NATIVE_STATUS_EXPRESSION), 'missing',
    );
    const removedCapabilities = assertRemovedCapabilities(
      await evaluate(client, removedCapabilitiesExpression(options.assetId)),
    );

    assertClickedActions(await evaluate(client, clickToolActionsExpression('install')), 'install');
    await waitForDom(client, 'installing', 50);
    const installing = assertNativeToolsStatus(
      await evaluate(client, NATIVE_STATUS_EXPRESSION), 'installing',
    );
    const installingScreenshot = await captureScreenshot(client, options.installingScreenshot);

    await waitForDom(client, 'installed');
    const installed = assertNativeToolsStatus(
      await evaluate(client, NATIVE_STATUS_EXPRESSION), 'installed',
    );
    const activeCapabilities = assertActiveCapabilities(
      await evaluate(client, activeCapabilitiesExpression(options.assetId)), options.assetId,
    );
    const installedScreenshot = await captureScreenshot(client, options.installedScreenshot);
    invariant(await evaluate(client, CLOSE_SETTINGS_EXPRESSION) === true,
      'Installed native-tool flow could not close Settings');
    await waitForValue(
      () => evaluate(client, "document.querySelector('[data-settings-tab=\"tools\"]') === null"),
      (value) => value === true,
      { timeoutMs: 30_000 },
    );
    return {
      assetId: options.assetId,
      removedToolIds: removed.tools.map(({ id }) => id),
      missingDownloadReason: removedCapabilities.download.reason,
      missingPipelineErrorCode: removedCapabilities.pipelineErrorCode,
      installJobs: installing.tools.map(({ id, jobId }) => ({ id, jobId })),
      installedTools: installed.tools.map(({ id, version }) => ({ id, version })),
      downloadVersion: activeCapabilities.download.version,
      pipeline: {
        audioCodec: activeCapabilities.pipeline.audioCodec,
        durationUs: activeCapabilities.pipeline.durationUs,
        frameRate: activeCapabilities.pipeline.frameRate,
        height: activeCapabilities.pipeline.height,
        videoCodec: activeCapabilities.pipeline.videoCodec,
        width: activeCapabilities.pipeline.width,
      },
      installingScreenshot,
      installedScreenshot,
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledNativeTools(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${sanitizeInspectorError(error, 'Installed native-tool flow failed')}\n`);
      process.exitCode = 1;
    });
}
