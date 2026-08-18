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

import { existsSync } from 'node:fs';

import { APPLICATION_BINARY, createRunRoot, removeRunRoot } from './support/environment.js';

let runRoot;

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
  mochaOpts: { ui: 'bdd', timeout: 180_000 },
  logLevel: 'warn',

  onPrepare: () => {
    if (!existsSync(APPLICATION_BINARY)) {
      throw new Error(
        `The E2E binary is missing: ${APPLICATION_BINARY}\n`
        + 'Build it with: npm --prefix apps/desktop run tauri -- build '
        + '--features e2e-automation --no-bundle --target x86_64-pc-windows-msvc',
      );
    }
  },

  beforeSession: () => {
    runRoot = createRunRoot();
    // Read by the application only in the local-test channel; a production build has no such path.
    process.env.OSG_E2E_DATA_ROOT = runRoot;
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
