import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
  CdpClient,
  discoverTarget,
  waitForInspection,
} from './inspect-installed-webview.mjs';

const MODES = new Set(['trigger', 'verify']);
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETTING_KEY = 'osg.ciInstalledSmoke.v1';
const PROJECT_NAME = 'OSG installed lifecycle probe committed';
const REVISION_REASON = 'OSG installed lifecycle revision';

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-updater.mjs --port PORT --mode MODE --base-version VERSION --updated-version VERSION --project-id UUID --screenshot PATH');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 6, 'Only the reviewed updater inspection arguments are accepted');
  const port = Number(values.get('--port'));
  const mode = values.get('--mode');
  const baseVersion = values.get('--base-version');
  const updatedVersion = values.get('--updated-version');
  const projectId = values.get('--project-id');
  const screenshot = values.get('--screenshot');
  invariant(Number.isInteger(port) && port >= 1024 && port <= 65_535,
    'Updater DevTools port must be unprivileged');
  invariant(MODES.has(mode), 'Updater inspection mode is invalid');
  invariant(SEMVER.test(baseVersion ?? '') && SEMVER.test(updatedVersion ?? '')
    && baseVersion !== updatedVersion,
  'Updater fixture versions are invalid');
  invariant(UUID_V7.test(projectId ?? ''), 'Updater fixture project ID must be UUIDv7');
  invariant(typeof screenshot === 'string' && screenshot.length > 0,
    'Updater fixture screenshot path is required');
  return Object.freeze({ port, mode, baseVersion, updatedVersion, projectId, screenshot });
}

export function assertUpdateStatus(value, {
  currentVersion,
  updatedVersion,
  available,
}) {
  invariant(exactKeys(value, ['configured', 'currentVersion', 'update'])
    && value.configured === true
    && value.currentVersion === currentVersion,
  'Installed updater returned an invalid status envelope');
  if (!available) {
    invariant(value.update === null, 'Updated application still offers an installed version');
    return value;
  }
  invariant(exactKeys(value.update, ['version', 'publishedAt', 'notes'])
    && value.update.version === updatedVersion
    && typeof value.update.publishedAt === 'string'
    && Number.isFinite(Date.parse(value.update.publishedAt))
    && typeof value.update.notes === 'string'
    && value.update.notes.length <= 32 * 1024,
  'Installed updater did not return the reviewed fixture release');
  return value;
}

export function assertPersistence(value, { baseVersion, projectId }) {
  invariant(exactKeys(value, ['setting', 'project', 'history']),
    'Updater persistence response has an invalid shape');
  invariant(value.setting === JSON.stringify({
    schemaVersion: 1,
    version: baseVersion,
    purpose: 'installed-lifecycle',
    projectId,
  }), 'Updater did not preserve the canonical settings value');
  invariant(exactKeys(value.project, ['metadata', 'stateVersion', 'media', 'tracks'])
    && exactKeys(value.project.metadata, ['id', 'name'])
    && value.project.metadata.id === projectId
    && value.project.metadata.name === PROJECT_NAME
    && value.project.stateVersion === 3
    && Array.isArray(value.project.media) && value.project.media.length === 0
    && Array.isArray(value.project.tracks) && value.project.tracks.length === 0,
  'Updater did not preserve the durable project');
  invariant(exactKeys(value.history, [
    'stateVersion', 'canUndo', 'canRedo', 'undoReason', 'redoReason',
  ])
    && value.history.stateVersion === 3
    && value.history.canUndo === true
    && value.history.canRedo === false
    && value.history.undoReason === REVISION_REASON
    && value.history.redoReason === null,
  'Updater did not preserve the durable project revision cursor');
  return value;
}

const updateStateExpression = (projectId) => `
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const projectId = ${JSON.stringify(projectId)};
  return {
    status: await invoke('app_update_check'),
    persistence: {
      setting: await invoke('setting_get', { key: ${JSON.stringify(SETTING_KEY)} }),
      project: await invoke('project_load', { id: projectId }),
      history: await invoke('project_history_status', { id: projectId }),
    },
  };
})()`;

const offerExpression = (updatedVersion, click) => `
(() => {
  const version = ${JSON.stringify(updatedVersion)};
  const candidates = [...document.querySelectorAll('.toast-item.live .toast-button')]
    .filter((button) => button.closest('.toast')?.querySelector('p')?.textContent?.includes(version));
  if (candidates.length !== 1) return { found: false, candidateCount: candidates.length };
  const button = candidates[0];
  const result = {
    found: true,
    candidateCount: 1,
    buttonText: button.textContent?.trim() ?? '',
    message: button.closest('.toast')?.querySelector('p')?.textContent?.trim() ?? '',
  };
  if (${JSON.stringify(click)}) button.click();
  return result;
})()`;

async function evaluate(client, expression) {
  const response = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!response.exceptionDetails,
    `Installed updater evaluation threw: ${response.exceptionDetails?.text ?? 'unknown error'}`);
  return response.result?.value;
}

export async function waitForUpdateOffer(read, updatedVersion, {
  timeoutMs = 60_000,
  delay = () => setTimeout(250),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastCount = 0;
  do {
    const value = await read();
    lastCount = value?.candidateCount ?? -1;
    if (value?.found === true) {
      invariant(typeof value.buttonText === 'string' && value.buttonText.length > 0
        && value.buttonText.length <= 128
        && typeof value.message === 'string'
        && value.message.includes(updatedVersion)
        && value.message.length <= 1024,
      'Installed updater offer escaped the bounded toast contract');
      return value;
    }
    await delay();
  } while (now() < deadline);
  throw new Error(`Installed update offer did not appear; last candidate count was ${lastCount}`);
}

async function captureScreenshot(client, screenshot) {
  const capture = await client.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  invariant(typeof capture.data === 'string' && capture.data.length > 1_000,
    'Updater WebView screenshot was empty');
  const bytes = Buffer.from(capture.data, 'base64');
  invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'Updater WebView screenshot is not PNG');
  fs.writeFileSync(path.resolve(screenshot), bytes, { flag: 'wx' });
  return Object.freeze({
    screenshotBytes: bytes.length,
    screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

async function inspectUpdater(options) {
  const target = await discoverTarget(options.port, 120_000);
  const client = new CdpClient(target.webSocketDebuggerUrl, 120_000);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const expectedVersion = options.mode === 'trigger'
      ? options.baseVersion
      : options.updatedVersion;
    const inspection = await waitForInspection(
      () => client.send('Runtime.evaluate', {
        expression: `
          (async () => {
            await document.fonts.ready;
            const root = document.getElementById('root');
            const bounds = root?.getBoundingClientRect();
            const health = await window.__TAURI_INTERNALS__.invoke('app_health');
            return {
              readyState: document.readyState,
              rootChildren: root?.childElementCount ?? 0,
              rootWidth: Math.round(bounds?.width ?? 0),
              rootHeight: Math.round(bounds?.height ?? 0),
              managedFont: window.__OSG_MANAGED_UI_FONT__ === true,
              managedFontStyle: document.getElementById('osg-managed-ui-font') !== null,
              fontReadyClass: document.documentElement.classList.contains('osg-managed-ui-font-ready'),
              fontLoaded: document.fonts.check('400 16px "Google Sans"', 'OSG Tiếng Việt ă đ ơ ư'),
              bodyFontFamily: getComputedStyle(document.body).fontFamily,
              health,
            };
          })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      expectedVersion,
      { timeoutMs: 120_000 },
    );
    const state = await evaluate(client, updateStateExpression(options.projectId));
    invariant(exactKeys(state, ['status', 'persistence']),
      'Installed updater state has an invalid shape');
    assertUpdateStatus(state.status, {
      currentVersion: expectedVersion,
      updatedVersion: options.updatedVersion,
      available: options.mode === 'trigger',
    });
    assertPersistence(state.persistence, options);

    let offer = null;
    if (options.mode === 'trigger') {
      offer = await waitForUpdateOffer(
        () => evaluate(client, offerExpression(options.updatedVersion, false)),
        options.updatedVersion,
      );
    }
    const screenshot = await captureScreenshot(client, options.screenshot);
    if (options.mode === 'trigger') {
      const clicked = await evaluate(client, offerExpression(options.updatedVersion, true));
      invariant(clicked?.found === true && clicked.buttonText === offer.buttonText,
        'Installed updater offer changed before the real click');
    }
    return Object.freeze({ ...inspection, ...screenshot, persistence: state.persistence, offer });
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  inspectUpdater(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)))
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Updater inspection failed'}\n`,
        () => process.exit(1),
      );
    });
}
