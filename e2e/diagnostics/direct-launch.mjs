// Diagnostic: launch the guarded E2E binary directly with the exact harness environment and
// capture its stdout/stderr plus its run-root logs, because a WDIO run deletes the root before
// an early application crash can be read. Off-screen, muted, isolated — same guarantees as a
// journey run; the only difference is that the process output is piped to this launcher.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import {
  assertAutomationDialogGuard, createRunRoot, attachRunRootCaches,
  isolationEnvironment, managedStagingEnvironment, readVerifiedPublishedApplication,
  removeRunRoot, runRootAuthorization, scrubAutomationEnvironment, stagedDialogPaths,
} from '../support/environment.js';
import { acquireE2eApplicationLease } from '../support/applicationLease.js';
import { acquireStagingLease } from '../support/stagingLease.js';
import {
  createGuardedWebDriverBinding, guardedWebDriverEnvironment,
} from '../support/driverIdentity.js';

const HOLD_MS = 30_000;

const dumpLogs = (root) => {
  for (const logDir of ['logs', join('data', 'logs')]) {
    const full = join(root, logDir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full)) {
      process.stdout.write(`=== ${logDir}\\${entry} ===\n`);
      process.stdout.write(`${readFileSync(join(full, entry), 'utf8').slice(-8_000)}\n`);
    }
  }
};

const applicationLease = acquireE2eApplicationLease({});
let stagingLease = null;
let runRoot = null;
let authorization = null;
try {
  const publication = readVerifiedPublishedApplication();
  assertAutomationDialogGuard(publication.binaryPath);
  stagingLease = acquireStagingLease({});
  runRoot = createRunRoot({ stagingLease });
  authorization = runRootAuthorization(runRoot);

  const environment = scrubAutomationEnvironment(process.env);
  environment.OSG_E2E_DATA_ROOT = runRoot;
  environment.OSG_E2E_RUN_ROOT_AUTHORIZATION = authorization;
  Object.assign(environment, managedStagingEnvironment(runRoot));
  attachRunRootCaches({ root: runRoot });
  const binding = await createGuardedWebDriverBinding({
    environment,
    runRoot,
    workerProcess: false,
  });
  Object.assign(environment, guardedWebDriverEnvironment(binding));
  // The tauri-service adds these two when it spawns the application.
  environment.WDIO_EMBEDDED_SERVER = 'true';
  environment.TAURI_WEBDRIVER_PORT = String(binding.port);
  const dialogs = stagedDialogPaths(runRoot, null);
  environment.OSG_E2E_MEDIA_DESTINATION = dialogs.mediaDestination;
  Object.assign(environment, isolationEnvironment(runRoot));

  for (const store of ['engine-packages', 'native-tools']) {
    const through = join(runRoot, 'data', store, 'v1');
    process.stdout.write(`=== ${store} through junction ===\n`);
    try {
      for (const entry of readdirSync(through)) process.stdout.write(`  ${entry}\n`);
    } catch (error) {
      process.stdout.write(`  unreadable: ${error.message}\n`);
    }
  }
  process.stdout.write(`launching ${publication.binaryPath}\n`);
  const child = spawn(publication.binaryPath, [], {
    env: environment,
    cwd: runRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exit = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const exited = () => Promise.race([exit, Promise.resolve(null)]);
  const step = async (label, action) => {
    const alreadyGone = await exited();
    if (alreadyGone !== null) {
      process.stdout.write(`SKIP ${label}: app already exited ${JSON.stringify(alreadyGone)}\n`);
      return null;
    }
    try {
      const value = await action();
      process.stdout.write(`OK ${label}: ${JSON.stringify(value).slice(0, 400)}\n`);
      return value;
    } catch (error) {
      process.stdout.write(`ERR ${label}: ${error.message}\n`);
      return null;
    }
  };
  const base = `http://127.0.0.1:${binding.port}`;
  const json = async (response) => ({ http: response.status, body: await response.json() });
  await new Promise((resolveWait) => { setTimeout(resolveWait, 8_000); });
  await step('GET /status', async () => json(await fetch(`${base}/status`)));
  const session = await step('POST /session', async () => json(await fetch(`${base}/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      capabilities: {
        alwaysMatch: { browserName: 'tauri', 'osg:e2eAuthorization': binding.authorization },
      },
    }),
  })));
  const sessionId = session?.body?.value?.sessionId;
  if (sessionId) {
    await step('POST execute/sync title probe', async () => json(await fetch(
      `${base}/session/${sessionId}/execute/sync`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script: 'return document.title', args: [] }),
      },
    )));
    const executeSync = (script) => async () => json(await fetch(
      `${base}/session/${sessionId}/execute/sync`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ script, args: [] }),
      },
    ));
    await step('probe href', executeSync('return document.location.href'));
    await step('probe root children', executeSync(
      'return { rootChildren: document.querySelector("#root")?.childElementCount ?? null, readyState: document.readyState }',
    ));
    await step('navigate to app protocol', async () => json(await fetch(
      `${base}/session/${sessionId}/url`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://tauri.localhost/index.html' }),
      },
    )));
    await new Promise((resolveWait) => { setTimeout(resolveWait, 5_000); });
    await step('probe href after navigation', executeSync('return document.location.href'));
    await step('probe title after navigation', executeSync('return document.title'));
    await step('probe root after navigation', executeSync(
      'return { rootChildren: document.querySelector("#root")?.childElementCount ?? null, readyState: document.readyState }',
    ));
    await step('open settings', executeSync(
      'document.querySelector(\'[data-app-action="open-settings"]\')?.click(); return true',
    ));
    await new Promise((resolveWait) => { setTimeout(resolveWait, 2_000); });
    await step('open tools tab', executeSync(
      'document.querySelector(\'[data-settings-tab="tools"]\')?.click(); return true',
    ));
    await new Promise((resolveWait) => { setTimeout(resolveWait, 8_000); });
    await step('engine cards', executeSync(`
      return [...document.querySelectorAll('[data-engine-id]')].map((card) => ({
        id: card.getAttribute('data-engine-id'),
        state: card.getAttribute('data-engine-state'),
      }));
    `));
    await step('engine_packages_status invoke', async () => json(await fetch(
      `${base}/session/${sessionId}/execute/async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          script: `
            const done = arguments[arguments.length - 1];
            window.__TAURI__.core.invoke('engine_packages_status').then(
              (result) => done({ ok: result.map((s) => ({
                id: s.id, state: s.state, installed: s.installed, version: s.version,
                installedBytes: s.installedBytes ?? s.installed_bytes,
              })) }),
              (error) => done({ err: String(error) }),
            );
          `,
          args: [],
        }),
      },
    )));
  }
  await new Promise((resolveWait) => { setTimeout(resolveWait, 4_000); });
  const result = await exited();
  if (result === null) {
    process.stdout.write(`ALIVE after command replay — killing child\n`);
    child.kill('SIGKILL');
    await exit;
  } else {
    process.stdout.write(`EXITED code=${result.code} signal=${result.signal}\n`);
  }
  process.stdout.write('=== run root data tree after app ===\n');
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      const kind = entry.isSymbolicLink() ? 'LINK' : entry.isDirectory() ? 'dir' : 'file';
      process.stdout.write(`  ${'  '.repeat(depth)}${kind} ${entry.name}\n`);
      if (entry.isDirectory() && !entry.isSymbolicLink()
          && entry.name !== 'EBWebView' && entry.name !== 'webview') walk(child, depth + 1);
    }
  };
  walk(join(runRoot, 'data'), 0);
  process.stdout.write(`=== STDOUT ===\n${out}\n=== STDERR ===\n${err}\n`);
  dumpLogs(runRoot);
} finally {
  if (runRoot !== null) removeRunRoot(runRoot, authorization);
  if (stagingLease !== null) stagingLease.release();
  applicationLease.release();
}
