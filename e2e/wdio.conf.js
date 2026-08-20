// WebdriverIO against the real application, through the official Tauri service.
//
// The WebDriver server runs INSIDE the E2E binary (`driverProvider: 'embedded'`), which is the whole
// point of this configuration rather than a preference. The previous harness ran an external
// `tauri-driver` plus `msedgedriver`, and a new session bound non-deterministically to one of the
// application's WebView2 targets — sometimes the editor, sometimes `about:blank`, with no window
// handle to switch to and no number of session reloads that fixed it. See
// `e2e/diagnostics/direct-driver/README.md` for what that measured. An embedded server has no target
// to choose.
//
// The server is compiled only under the `e2e-automation` Cargo feature. `cargo tree` reports two
// wdio crates in that graph and zero in the production graph.

import { copyFileSync, existsSync } from 'node:fs';

import {
  APPLICATION_BINARY, JOURNEY_TIMEOUT_MS, assertAutomationDialogGuard, createRunRoot,
  isolationEnvironment, removeRunRoot, stagedDialogPaths,
} from './support/environment.js';
import { cachedRealVideo } from './support/realMedia.js';

// The run root is created and exported into the environment WHEN THIS CONFIG LOADS, before any
// hook and before the service spawns the binary.
//
// `beforeSession` is too late. Measured: with the isolation assigned there, a run's root contained
// empty `logs` and `webview` directories — the application had written nothing into it — while the
// editor displayed the developer's real recent-videos list. The service had already launched the
// binary with the ambient environment. Every embedded run before this fix was reading live user
// state while appearing to be isolated, which is the most dangerous shape a test harness can take:
// it looks clean and it is not.
//
// The root is REUSED when one is already in the environment, because this config is loaded once in
// the launcher process and again in each worker. Creating a root in both produced two per run, and
// the service spawns the binary from the launcher — so the application wrote its database and log
// into the launcher's root while the worker saved screenshots into a different one. Diagnosing the
// first real failure this harness found therefore started with an evidence directory that contained
// a screenshot, no log, and no indication that the log existed somewhere else entirely.
const runRoot = process.env.OSG_E2E_DATA_ROOT && existsSync(process.env.OSG_E2E_DATA_ROOT)
  ? process.env.OSG_E2E_DATA_ROOT
  : createRunRoot();
// The staged dialog answers, decided before the binary is spawned because the application reads
// them from its own environment at launch.
//
// The open dialog returns a private copy of the real downloaded video when one is cached; the save
// dialog writes into this run's private output directory. The persistent media cache is input-only:
// allowing outputs beneath it caused the next journey to select its own newest 1440x1080 export as
// the 192x144 source fixture. Neither answer is set speculatively: a journey that finds no staged
// selection receives a typed refusal from the automation-only Rust boundary. It can never fall back
// to the customer dialog implementation because that implementation is not compiled into this
// channel.
const cachedVideo = cachedRealVideo();
const dialogPaths = stagedDialogPaths(runRoot, cachedVideo);
if (process.env.OSG_E2E_MEDIA_SELECTION === undefined && cachedVideo !== null) {
  copyFileSync(cachedVideo, dialogPaths.mediaSelection);
  process.env.OSG_E2E_MEDIA_SELECTION = dialogPaths.mediaSelection;
}
if (process.env.OSG_E2E_MEDIA_DESTINATION === undefined) {
  // A directory, not a file: only the application knows what the asset is called or what container
  // it ended up in, so it names the file inside this and the journey watches for it to appear.
  //
  // A FRESH one per run. The application refuses a staged destination that already exists, and a
  // refusal is typed and fail-closed. Re-running into an occupied destination must fail the journey;
  // it must never open a native dialog.
  process.env.OSG_E2E_MEDIA_DESTINATION = dialogPaths.mediaDestination;
}
Object.assign(process.env, isolationEnvironment(runRoot));

export const config = {
  runner: 'local',
  specs: ['./journeys/**/*.journey.js'],
  // One worker until isolated roots, ports, GPU and Media Foundation resources are proven
  // independent. Media Foundation has already been observed to fault under concurrent opens.
  maxInstances: 1,
  services: ['@wdio/tauri-service'],
  capabilities: [{
    browserName: 'tauri',
    'tauri:options': {
      application: APPLICATION_BINARY,
      driverProvider: 'embedded',
    },
  }],
  reporters: ['spec'],
  framework: 'mocha',
  // Longer than any single journey's internal waits. When mocha's cap fires first it reports
  // only "took too long", discarding the observation the journey collected about WHY.
  // Heavy engine-install journeys legitimately run for hours. Cross-process persistence is driven
  // by scenario runners that launch this configuration twice, never by extending one Mocha test.
  mochaOpts: { ui: 'bdd', timeout: JOURNEY_TIMEOUT_MS },
  logLevel: 'warn',

  onPrepare: () => {
    if (process.env.OSG_E2E_DATA_ROOT !== runRoot) {
      throw new Error('the isolation environment was overwritten before the run started');
    }
    assertAutomationDialogGuard(APPLICATION_BINARY);
  },

  // This application has exactly one WebView. Mark its existing WebDriver handle as the explicit
  // target once, before a journey issues element commands. Without this, tauri-service performs an
  // active-window discovery call before every `$`, `$$` and click. Its direct-eval bridge is not
  // available in a small but repeatable fraction of otherwise healthy embedded sessions, so each
  // discovery waits five seconds even though ordinary WebDriver commands are already attached to
  // the rendered editor. An explicit standard WebDriver switch suppresses that irrelevant recovery
  // path; it does not navigate, inject state, mock IPC or choose a different application window.
  before: async () => {
    const handle = await browser.getWindowHandle();
    await browser.switchToWindow(handle);
  },

  afterSession: () => {
    if (runRoot && !process.env.OSG_E2E_KEEP_ROOT) removeRunRoot(runRoot);
  },

  // Evidence on every failure. A timeout without a screenshot and a log dump costs more to diagnose
  // than the test saved by existing.
  afterTest: async function afterTest(test, context, { passed }) {
    if (passed) return;
    const name = test.title.replace(/[^\w-]+/g, '-').slice(0, 80);
    try {
      await browser.saveScreenshot(`${runRoot}/evidence/${name}.png`);
    } catch { /* the window may already be gone; the logs below still help */ }
    try {
      const logs = await browser.getLogs('browser');
      console.log(`\n--- WebView logs (${name}) ---\n${JSON.stringify(logs, null, 2)}`);
    } catch (error) {
      console.log(`\n--- WebView logs unavailable: ${error.message} ---`);
    }
    console.log(`\n--- evidence kept at: ${runRoot} ---`);
    process.env.OSG_E2E_KEEP_ROOT = '1';
  },
};
