import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';

const ORIGINAL_TEXT = 'OSG installed media smoke';
const EDITED_TEXT = 'OSG durable editor smoke';
const EDITOR_REASON = 'OSG lyrics editor v1: text';
const SUBTITLE_INDEX_KEY = 'project.subtitleCacheIndex.v1';
const SUBTITLE_TRACK_LABEL = 'Cached subtitles';
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export function sanitizeEditorError(error, fallback = 'Installed editor flow failed') {
  const raw = error instanceof Error && typeof error.message === 'string'
    ? error.message
    : fallback;
  const sanitized = raw
    .replace(/\b(?:file|https?):\/\/[^\s"'<>]+/giu, '<redacted-url>')
    .replace(/\\\\[^\r\n"'<>]+/gu, '<redacted-path>')
    .replace(/\b[A-Za-z]:[\\/][^\r\n"'<>]*/gu, '<redacted-path>')
    .replace(/\b(?:127\.0\.0\.1|localhost)\b/giu, '<redacted-host>')
    .replace(/\b(?:currentFileUrl|playbackUrl|token)\b/giu, 'capability')
    .replace(/\b[0-9a-f]{64}\b/giu, '<redacted-capability>')
    .slice(0, 2_048);
  return sanitized.length > 0 ? sanitized : fallback;
}

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-editor-flow.mjs --port PORT --screenshot PATH');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 2, 'Only reviewed installed editor-flow arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  invariant(typeof environment.RUNNER_TEMP === 'string' && environment.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP is required for the installed editor smoke');
  const runnerTemp = fs.realpathSync(environment.RUNNER_TEMP);
  const screenshot = path.resolve(values.get('--screenshot'));
  invariant(isInside(screenshot, runnerTemp), 'Screenshot must stay inside RUNNER_TEMP');
  invariant(!fs.existsSync(screenshot), 'Installed editor screenshot path must be clean');
  return Object.freeze({ port, screenshot });
}

export function assertEditorSnapshot(value, {
  text,
  canUndo,
  canRedo,
} = {}) {
  invariant(hasExactKeys(value, [
    'canRedo', 'canUndo', 'editButtonCount', 'errorToastMessages', 'itemCount',
    'redoButtonCount', 'text', 'textInputCount', 'undoButtonCount',
  ]), 'Installed editor flow returned an invalid snapshot');
  invariant(value.itemCount === 1 && value.text === text,
    'Installed editor flow published the wrong subtitle rows');
  invariant(value.editButtonCount === 1 && value.textInputCount === 0
    && value.undoButtonCount === 1 && value.redoButtonCount === 1,
  'Installed editor flow exposed ambiguous editor controls');
  invariant(value.canUndo === canUndo && value.canRedo === canRedo,
    'Installed editor flow exposed the wrong undo/redo controls');
  invariant(Array.isArray(value.errorToastMessages) && value.errorToastMessages.length === 0,
    'Installed editor flow displayed an error toast');
  return value;
}

export function assertNativeHistorySnapshot(value, {
  text,
  canUndo,
  canRedo,
  minimumHistoryVersion = 1,
} = {}) {
  invariant(hasExactKeys(value, [
    'cacheIdValid', 'cueCount', 'matchingEntryCount', 'matchingTrackCount',
    'projectIdValid', 'projectStateVersion', 'status', 'text',
  ]), 'Installed editor flow returned an invalid native history snapshot');
  invariant(value.cacheIdValid === true && value.matchingEntryCount === 1
    && value.projectIdValid === true && value.matchingTrackCount === 1
    && value.cueCount === 1 && value.text === text,
  'Installed editor flow did not persist the authoritative subtitle row');
  invariant(hasExactKeys(value.status, [
    'canRedo', 'canUndo', 'diverged', 'historyVersion', 'redoReason',
    'stateVersion', 'undoReason',
  ]), 'Installed editor flow returned an invalid native history cursor');
  invariant(Number.isSafeInteger(value.status.stateVersion) && value.status.stateVersion >= 1
    && value.projectStateVersion === value.status.stateVersion
    && Number.isSafeInteger(value.status.historyVersion)
    && value.status.historyVersion >= minimumHistoryVersion
    && value.status.diverged === false,
  'Installed editor flow returned a stale native history cursor');
  invariant(value.status.canUndo === canUndo && value.status.canRedo === canRedo
    && value.status.undoReason === (canUndo ? EDITOR_REASON : null)
    && value.status.redoReason === (canRedo ? EDITOR_REASON : null),
  'Installed editor flow exposed the wrong native undo/redo cursor');
  return value;
}

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 250)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastValue;
  do {
    lastValue = await read();
    if (accept(lastValue)) return lastValue;
    await delay();
  } while (now() < deadline);
  throw new Error('Installed editor flow timed out before reaching the reviewed state');
}

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails, 'Installed editor evaluation failed');
  return evaluation.result?.value;
};

const SNAPSHOT_EXPRESSION = `
(() => {
  const redo = document.querySelector('.redo-btn');
  const undo = document.querySelector('.undo-btn');
  return {
    canRedo: redo instanceof HTMLButtonElement ? !redo.disabled : null,
    canUndo: undo instanceof HTMLButtonElement ? !undo.disabled : null,
    editButtonCount: document.querySelectorAll(
      '.lyric-item[data-lyric-index="0"] .edit-lyric-btn',
    ).length,
    errorToastMessages: [...document.querySelectorAll('.toast-error p')]
      .slice(0, 4)
      .map((element) => (element.textContent ?? '').trim().slice(0, 1024)),
    itemCount: document.querySelectorAll('.lyric-item').length,
    redoButtonCount: document.querySelectorAll('.redo-btn').length,
    text: document.querySelector('.lyric-item[data-lyric-index="0"] .lyric-text')
      ?.textContent?.trim() ?? null,
    textInputCount: document.querySelectorAll(
      '.lyric-item[data-lyric-index="0"] textarea.lyric-text-input',
    ).length,
    undoButtonCount: document.querySelectorAll('.undo-btn').length,
  };
})()`;

const EDIT_EXPRESSION = `
(() => {
  const buttons = document.querySelectorAll(
    '.lyric-item[data-lyric-index="0"] .edit-lyric-btn',
  );
  if (buttons.length !== 1) return false;
  const [button] = buttons;
  if (!(button instanceof HTMLButtonElement)) return false;
  button.click();
  return true;
})()`;

const COMMIT_EDIT_EXPRESSION = `
(async () => {
  const inputs = document.querySelectorAll(
    '.lyric-item[data-lyric-index="0"] textarea.lyric-text-input',
  );
  if (inputs.length !== 1) return false;
  const [input] = inputs;
  if (!(input instanceof HTMLTextAreaElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (typeof setter !== 'function') return false;
  setter.call(input, ${JSON.stringify(EDITED_TEXT)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (input.value !== ${JSON.stringify(EDITED_TEXT)}) return false;
  input.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    key: 'Enter',
  }));
  return true;
})()`;

const clickEnabled = (selector) => `
(() => {
  const buttons = document.querySelectorAll(${JSON.stringify(selector)});
  if (buttons.length !== 1) return false;
  const [button] = buttons;
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`;

const NATIVE_HISTORY_EXPRESSION = `
(async () => {
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  if (typeof invoke !== 'function') return null;
  const cacheId = localStorage.getItem('current_file_cache_id');
  const index = await invoke('setting_get', { key: ${JSON.stringify(SUBTITLE_INDEX_KEY)} });
  const entries = Array.isArray(index?.entries) ? index.entries : [];
  const matchingEntries = entries.filter((entry) => entry?.cacheId === cacheId);
  const projectId = matchingEntries.length === 1 ? matchingEntries[0].projectId : null;
  let project = null;
  let status = null;
  if (typeof projectId === 'string') {
    [project, status] = await Promise.all([
      invoke('project_load', { id: projectId }),
      invoke('project_track_history_status', {
        id: projectId,
        selector: {
          label: ${JSON.stringify(SUBTITLE_TRACK_LABEL)},
          origin: 'legacyJson',
        },
      }),
    ]);
  }
  const matchingTracks = Array.isArray(project?.tracks)
    ? project.tracks.filter((track) => (
      track?.label === ${JSON.stringify(SUBTITLE_TRACK_LABEL)}
        && track?.origin === 'legacyJson'
    ))
    : [];
  const cues = matchingTracks.length === 1 && Array.isArray(matchingTracks[0].cues)
    ? matchingTracks[0].cues
    : [];
  return {
    cacheIdValid: ${UUID_V7}.test(cacheId ?? ''),
    cueCount: cues.length,
    matchingEntryCount: matchingEntries.length,
    matchingTrackCount: matchingTracks.length,
    projectIdValid: ${UUID_V7}.test(projectId ?? ''),
    projectStateVersion: Number.isSafeInteger(project?.stateVersion)
      ? project.stateVersion
      : null,
    status,
    text: cues.length === 1 ? cues[0]?.text ?? null : null,
  };
})()`;

const waitForSnapshot = (client, expected) => waitForValue(
  () => evaluate(client, SNAPSHOT_EXPRESSION),
  (value) => {
    try {
      assertEditorSnapshot(value, expected);
      return true;
    } catch {
      return false;
    }
  },
);

const waitForNativeHistory = (client, expected) => waitForValue(
  () => evaluate(client, NATIVE_HISTORY_EXPRESSION),
  (value) => {
    try {
      assertNativeHistorySnapshot(value, expected);
      return true;
    } catch {
      return false;
    }
  },
);

const reloadAndWait = async (client, expected, nativeExpected) => {
  await client.send('Page.reload', { ignoreCache: true });
  await waitForValue(
    () => evaluate(client, 'document.readyState'),
    (value) => value === 'complete',
  );
  await waitForNativeHistory(client, nativeExpected);
  return waitForSnapshot(client, expected);
};

async function runInstalledEditorFlow(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await waitForSnapshot(client, { text: ORIGINAL_TEXT, canUndo: false, canRedo: false });
    invariant(await evaluate(client, EDIT_EXPRESSION) === true,
      'Installed editor flow could not enter text-edit mode');
    await waitForValue(
      () => evaluate(client, 'document.querySelector("textarea.lyric-text-input") !== null'),
      (value) => value === true,
      { timeoutMs: 30_000 },
    );
    invariant(await evaluate(client, COMMIT_EDIT_EXPRESSION) === true,
      'Installed editor flow could not commit the text edit');
    await waitForSnapshot(client, { text: EDITED_TEXT, canUndo: true, canRedo: false });
    const editedHistory = await waitForNativeHistory(client, {
      text: EDITED_TEXT, canUndo: true, canRedo: false,
    });
    invariant(await evaluate(client, clickEnabled('.undo-btn')) === true,
      'Installed editor flow could not invoke undo');
    await waitForSnapshot(client, { text: ORIGINAL_TEXT, canUndo: false, canRedo: true });
    const undoneHistory = await waitForNativeHistory(client, {
      text: ORIGINAL_TEXT,
      canUndo: false,
      canRedo: true,
      minimumHistoryVersion: editedHistory.status.historyVersion + 1,
    });
    await reloadAndWait(
      client,
      { text: ORIGINAL_TEXT, canUndo: false, canRedo: true },
      {
        text: ORIGINAL_TEXT,
        canUndo: false,
        canRedo: true,
        minimumHistoryVersion: undoneHistory.status.historyVersion,
      },
    );
    invariant(await evaluate(client, clickEnabled('.redo-btn')) === true,
      'Installed editor flow could not invoke redo after reload');
    await waitForSnapshot(client, { text: EDITED_TEXT, canUndo: true, canRedo: false });
    const redoneHistory = await waitForNativeHistory(client, {
      text: EDITED_TEXT,
      canUndo: true,
      canRedo: false,
      minimumHistoryVersion: undoneHistory.status.historyVersion + 1,
    });
    await reloadAndWait(
      client,
      { text: EDITED_TEXT, canUndo: true, canRedo: false },
      {
        text: EDITED_TEXT,
        canUndo: true,
        canRedo: false,
        minimumHistoryVersion: redoneHistory.status.historyVersion,
      },
    );

    const capture = await client.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false, fromSurface: true,
    });
    invariant(typeof capture.data === 'string', 'Installed editor screenshot was empty');
    const bytes = Buffer.from(capture.data, 'base64');
    invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Installed editor screenshot is not a PNG');
    fs.writeFileSync(options.screenshot, bytes, { flag: 'wx' });
    return {
      editedText: EDITED_TEXT,
      finalHistoryVersion: redoneHistory.status.historyVersion,
      pageReloads: 2,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      undoRedoCycles: 1,
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledEditorFlow(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${sanitizeEditorError(error)}\n`);
      process.exitCode = 1;
    });
}
