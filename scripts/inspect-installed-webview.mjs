import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, pathToFileURL } from 'node:url';

/* global AbortSignal, WebSocket, fetch */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TAURI_ORIGIN = 'https://tauri.localhost';
const DEFAULT_TIMEOUT_MS = 60_000;
const PERSISTENCE_KEY = 'osg.ciInstalledSmoke.v1';
const PERSISTENCE_PROJECT_INITIAL_NAME = 'OSG installed lifecycle probe';
const PERSISTENCE_PROJECT_NAME = 'OSG installed lifecycle probe committed';
const PERSISTENCE_REVISION_REASON = 'OSG installed lifecycle revision';
const PHASES = new Set(['first-launch', 'relaunch', 'reinstall-launch']);
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-webview.mjs --port PORT --expected-version VERSION --screenshot PATH --phase PHASE [--expected-project-id UUID]');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const port = Number(values.get('--port'));
  const expectedVersion = values.get('--expected-version');
  const screenshot = values.get('--screenshot');
  const phase = values.get('--phase');
  const expectedProjectId = values.get('--expected-project-id');
  invariant(Number.isInteger(port) && port >= 1024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  invariant(typeof expectedVersion === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expectedVersion),
    'Expected version must be semantic');
  invariant(typeof screenshot === 'string' && screenshot.length > 0,
    'Screenshot output path is required');
  invariant(PHASES.has(phase), 'Installed WebView phase is invalid');
  if (phase === 'first-launch') {
    invariant(expectedProjectId === undefined,
      'First launch must create rather than trust an existing project ID');
  } else {
    invariant(UUID_V7.test(expectedProjectId ?? ''),
      'Relaunch inspection requires the first-launch UUIDv7 project ID');
  }
  invariant(values.size === (expectedProjectId === undefined ? 4 : 5),
    'Only reviewed installed-WebView arguments are accepted');
  return { port, expectedVersion, screenshot, phase, expectedProjectId };
}

export function selectTauriTarget(targets, port) {
  invariant(Array.isArray(targets), 'DevTools target response must be an array');
  const candidates = targets.filter((target) => target?.type === 'page'
    && typeof target.url === 'string'
    && new URL(target.url).origin === TAURI_ORIGIN);
  invariant(candidates.length === 1,
    `Expected exactly one installed Tauri page, found ${candidates.length}`);
  const target = candidates[0];
  invariant(typeof target.webSocketDebuggerUrl === 'string',
    'Installed Tauri page did not expose a DevTools WebSocket');
  const endpoint = new URL(target.webSocketDebuggerUrl);
  invariant(endpoint.protocol === 'ws:' && LOOPBACK_HOSTS.has(endpoint.hostname),
    'DevTools WebSocket must remain loopback-only');
  invariant(Number(endpoint.port) === port,
    'DevTools WebSocket escaped the requested loopback port');
  return target;
}

export function assertInspection(value, expectedVersion) {
  invariant(value && typeof value === 'object' && !Array.isArray(value),
    'Installed WebView inspection returned an invalid payload');
  invariant(value.readyState === 'complete', 'Installed WebView document is not complete');
  invariant(value.rootChildren > 0 && value.rootWidth >= 1_000 && value.rootHeight >= 600,
    'Installed React surface is absent or unexpectedly collapsed');
  invariant(value.managedFont === true && value.managedFontStyle === true,
    'Installed WebView did not receive the managed UI font bootstrap');
  invariant(value.fontReadyClass === true && value.fontLoaded === true,
    'Installed WebView did not load the managed Google Sans Flex faces');
  invariant(typeof value.bodyFontFamily === 'string' && value.bodyFontFamily.includes('Google Sans'),
    'Installed WebView body does not resolve through the reviewed Google Sans Flex family');
  invariant(value.health?.appVersion === expectedVersion,
    `Installed IPC version ${value.health?.appVersion ?? 'missing'} does not match ${expectedVersion}`);
  invariant(value.health?.platform === 'windows' && value.health?.architecture === 'x86_64',
    'Installed IPC health is not the Windows x64 release target');
  return value;
}

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

const assertProjectSnapshot = (snapshot, projectId, name, stateVersion, label) => {
  invariant(hasExactKeys(snapshot, ['metadata', 'stateVersion', 'media', 'tracks'])
    && hasExactKeys(snapshot.metadata, ['id', 'name'])
    && snapshot.metadata.id === projectId
    && snapshot.metadata.name === name
    && snapshot.stateVersion === stateVersion
    && Array.isArray(snapshot.media) && snapshot.media.length === 0
    && Array.isArray(snapshot.tracks) && snapshot.tracks.length === 0,
  `Installed ${label} did not survive the expected lifecycle`);
};

const assertHistoryStatus = (
  status,
  { stateVersion, canUndo, canRedo, undoReason, redoReason },
  label,
) => {
  invariant(hasExactKeys(status, ['stateVersion', 'canUndo', 'canRedo', 'undoReason', 'redoReason'])
    && status.stateVersion === stateVersion
    && status.canUndo === canUndo
    && status.canRedo === canRedo
    && status.undoReason === undoReason
    && status.redoReason === redoReason,
  `Installed ${label} returned an invalid durable history cursor`);
};

export function assertPersistence(value, { phase, expectedVersion, expectedProjectId }) {
  invariant(hasExactKeys(value, ['setting', 'project', 'loaded', 'history', 'lifecycle']),
    'Installed persistence inspection returned an invalid payload');
  const projectId = phase === 'first-launch' ? value.project?.metadata?.id : expectedProjectId;
  invariant(UUID_V7.test(projectId ?? ''), 'Installed project did not return a UUIDv7 ID');
  invariant(value.setting === JSON.stringify({
    schemaVersion: 1,
    version: expectedVersion,
    purpose: 'installed-lifecycle',
    projectId,
  }),
  'Installed settings did not survive the expected lifecycle');
  assertProjectSnapshot(value.project, projectId, PERSISTENCE_PROJECT_NAME, 3, 'project');
  assertProjectSnapshot(value.loaded, projectId, PERSISTENCE_PROJECT_NAME, 3, 'loaded project');
  invariant(JSON.stringify(value.project) === JSON.stringify(value.loaded),
    'Installed project reload changed the persisted snapshot');
  assertHistoryStatus(value.history, {
    stateVersion: 3,
    canUndo: true,
    canRedo: false,
    undoReason: PERSISTENCE_REVISION_REASON,
    redoReason: null,
  }, 'project history');

  if (phase === 'first-launch') {
    invariant(hasExactKeys(value.lifecycle, [
      'commit', 'afterCommit', 'statusAfterCommit', 'undo', 'statusAfterUndo', 'redo',
    ]), 'Installed project revision lifecycle returned an invalid payload');
    invariant(hasExactKeys(value.lifecycle.commit, ['revisionId', 'stateVersion'])
      && UUID_V7.test(value.lifecycle.commit.revisionId ?? '')
      && value.lifecycle.commit.stateVersion === 1,
    'Installed project commit returned an invalid durable revision');
    assertProjectSnapshot(
      value.lifecycle.afterCommit, projectId, PERSISTENCE_PROJECT_NAME, 1, 'committed project',
    );
    assertHistoryStatus(value.lifecycle.statusAfterCommit, {
      stateVersion: 1,
      canUndo: true,
      canRedo: false,
      undoReason: PERSISTENCE_REVISION_REASON,
      redoReason: null,
    }, 'post-commit history');
    assertProjectSnapshot(
      value.lifecycle.undo, projectId, PERSISTENCE_PROJECT_INITIAL_NAME, 2, 'undone project',
    );
    assertHistoryStatus(value.lifecycle.statusAfterUndo, {
      stateVersion: 2,
      canUndo: false,
      canRedo: true,
      undoReason: null,
      redoReason: PERSISTENCE_REVISION_REASON,
    }, 'post-undo history');
    assertProjectSnapshot(
      value.lifecycle.redo, projectId, PERSISTENCE_PROJECT_NAME, 3, 'redone project',
    );
  } else {
    invariant(value.lifecycle === null,
      'Relaunch persistence inspection unexpectedly repeated the revision lifecycle');
  }
  return Object.freeze({ projectId });
}

export async function waitForInspection(evaluate, expectedVersion, {
  now = Date.now,
  delay = () => new Promise((resolve) => setTimeout(resolve, 250)),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  invariant(typeof evaluate === 'function', 'Installed WebView evaluator is required');
  const deadline = now() + timeoutMs;
  let lastFailure = 'not started';
  do {
    try {
      const evaluation = await evaluate();
      invariant(!evaluation?.exceptionDetails,
        `Installed WebView inspection threw: ${evaluation?.exceptionDetails?.text ?? 'unknown error'}`);
      return assertInspection(evaluation?.result?.value, expectedVersion);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'unknown inspection error';
      await delay();
    }
  } while (now() < deadline);
  throw new Error(`Installed WebView did not become ready within 60 seconds: ${lastFailure}`);
}

export class CdpClient {
  constructor(endpoint, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;
    socket.addEventListener('message', (event) => this.onMessage(event));
    socket.addEventListener('close', () => this.rejectPending('DevTools WebSocket closed'));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DevTools WebSocket connection timed out')),
        this.timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('DevTools WebSocket connection failed'));
      }, { once: true });
    });
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.rejectPending('DevTools returned malformed JSON');
      return;
    }
    if (!Number.isInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`DevTools command failed: ${message.error.message ?? 'unknown error'}`));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  send(method, params = {}) {
    invariant(this.socket?.readyState === WebSocket.OPEN, 'DevTools WebSocket is not open');
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools command timed out: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
  }
}

export async function discoverTarget(port, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'not started';
  do {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(2_000),
      });
      invariant(response.ok, `DevTools discovery returned HTTP ${response.status}`);
      return selectTauriTarget(await response.json(), port);
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : 'unknown discovery error';
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } while (Date.now() < deadline);
  throw new Error(`Installed WebView DevTools target was unavailable: ${lastFailure}`);
}

const INSPECTION_EXPRESSION = `
(async () => {
  await document.fonts.ready;
  const root = document.getElementById('root');
  const bounds = root?.getBoundingClientRect();
  const descriptor = '400 16px "Google Sans"';
  const health = await window.__TAURI_INTERNALS__.invoke('app_health');
  return {
    readyState: document.readyState,
    rootChildren: root?.childElementCount ?? 0,
    rootWidth: Math.round(bounds?.width ?? 0),
    rootHeight: Math.round(bounds?.height ?? 0),
    managedFont: window.__OSG_MANAGED_UI_FONT__ === true,
    managedFontStyle: document.getElementById('osg-managed-ui-font') !== null,
    fontReadyClass: document.documentElement.classList.contains('osg-managed-ui-font-ready'),
    fontLoaded: document.fonts.check(descriptor, 'OSG Tiếng Việt ă đ ơ ư'),
    bodyFontFamily: getComputedStyle(document.body).fontFamily,
    health,
  };
})()`;

const persistenceExpression = ({ phase, expectedVersion, expectedProjectId }) => `
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const key = ${JSON.stringify(PERSISTENCE_KEY)};
  const firstLaunch = ${JSON.stringify(phase === 'first-launch')};
  let project;
  let lifecycle = null;
  if (firstLaunch) {
    localStorage.setItem('has_visited_site', 'true');
    localStorage.setItem('onboarding_controls_dismissed', 'true');
    const created = await invoke('project_create', {
      name: ${JSON.stringify(PERSISTENCE_PROJECT_INITIAL_NAME)},
    });
    const candidate = {
      ...created,
      metadata: { ...created.metadata, name: ${JSON.stringify(PERSISTENCE_PROJECT_NAME)} },
    };
    const reason = ${JSON.stringify(PERSISTENCE_REVISION_REASON)};
    const commit = await invoke('project_commit', { snapshot: candidate, reason });
    const afterCommit = await invoke('project_load', { id: created.metadata.id });
    const statusAfterCommit = await invoke('project_history_status', { id: created.metadata.id });
    const undo = await invoke('project_undo', {
      id: created.metadata.id,
      expectedVersion: afterCommit.stateVersion,
      expectedReason: reason,
    });
    const statusAfterUndo = await invoke('project_history_status', { id: created.metadata.id });
    const redo = await invoke('project_redo', {
      id: created.metadata.id,
      expectedVersion: undo.stateVersion,
      expectedReason: reason,
    });
    project = redo;
    lifecycle = { commit, afterCommit, statusAfterCommit, undo, statusAfterUndo, redo };
    await invoke('setting_set', {
      key,
      value: JSON.stringify({
        schemaVersion: 1,
        version: ${JSON.stringify(expectedVersion)},
        purpose: 'installed-lifecycle',
        projectId: project.metadata.id,
      }),
    });
  } else {
    project = await invoke('project_load', { id: ${JSON.stringify(expectedProjectId ?? null)} });
  }
  const stored = await invoke('setting_get', { key });
  const loaded = await invoke('project_load', { id: project?.metadata?.id ?? null });
  const history = await invoke('project_history_status', { id: project?.metadata?.id ?? null });
  return { setting: stored, project, loaded, history, lifecycle };
})()`;

async function inspectInstalledWebView(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    const inspection = await waitForInspection(
      () => client.send('Runtime.evaluate', {
          expression: INSPECTION_EXPRESSION,
          awaitPromise: true,
          returnByValue: true,
      }),
      options.expectedVersion,
    );
    const persistenceEvaluation = await client.send('Runtime.evaluate', {
      expression: persistenceExpression(options),
      awaitPromise: true,
      returnByValue: true,
    });
    invariant(!persistenceEvaluation.exceptionDetails,
      `Installed persistence inspection threw: ${persistenceEvaluation.exceptionDetails?.text ?? 'unknown error'}`);
    const persistence = assertPersistence(persistenceEvaluation.result?.value, options);
    const capture = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    invariant(typeof capture.data === 'string' && capture.data.length > 1_000,
      'Installed WebView screenshot was empty');
    const bytes = Buffer.from(capture.data, 'base64');
    invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Installed WebView screenshot is not a bounded PNG capture');
    fs.writeFileSync(options.screenshot, bytes, { flag: 'wx' });
    return {
      ...inspection,
      persistence,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => inspectInstalledWebView(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Installed WebView inspection failed'}\n`);
      process.exitCode = 1;
    });
}
