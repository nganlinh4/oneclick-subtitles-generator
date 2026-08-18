// WebdriverIO against the real application, via tauri-driver.
//
// tauri-driver is a thin proxy: it starts the native binary and forwards WebDriver traffic to
// msedgedriver, which must match the installed WebView2 runtime. That version rule is the single
// most common reason a Tauri E2E setup fails to start at all, so it is asserted here with the
// measured values rather than left to a README.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { APPLICATION_BINARY, createRunRoot, removeRunRoot } from './support/environment.js';

/** Pinned: msedgedriver's major version must equal the installed WebView2 runtime's. */
const EDGE_DRIVER = join(
  process.env.OSG_E2E_DRIVER_DIR
    ?? 'C:/Users/user/AppData/Local/Temp/claude/C--WORK-oneclick-subtitles-generator/91776f0a-37b4-40f7-a14b-91498e783837/scratchpad/edgedriver',
  'msedgedriver.exe',
);

let tauriDriver;
let runRoot;

export const config = {
  runner: 'local',
  specs: ['./journeys/**/*.journey.js'],
  maxInstances: 1,
  capabilities: [{
    browserName: 'wry',
    'tauri:options': { application: APPLICATION_BINARY },
  }],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 180_000 },
  hostname: '127.0.0.1',
  port: 4444,
  logLevel: 'warn',

  onPrepare: () => {
    if (!existsSync(APPLICATION_BINARY)) {
      throw new Error(
        `The E2E binary is missing: ${APPLICATION_BINARY}\n`
        + 'Build it with: npm --prefix apps/desktop run tauri -- build '
        + '--features unsigned-local-build --no-bundle --target x86_64-pc-windows-msvc',
      );
    }
    if (!existsSync(EDGE_DRIVER)) {
      throw new Error(`msedgedriver is missing: ${EDGE_DRIVER}`);
    }
  },

  beforeSession: () => {
    runRoot = createRunRoot();
    // Read by the application only in the local-test channel; a production build has no such path.
    process.env.OSG_E2E_DATA_ROOT = runRoot;
    tauriDriver = spawn('tauri-driver', ['--native-driver', EDGE_DRIVER], {
      stdio: [null, process.stdout, process.stderr],
      env: { ...process.env, OSG_E2E_DATA_ROOT: runRoot },
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
    if (runRoot && !process.env.OSG_E2E_KEEP_ROOT) removeRunRoot(runRoot);
  },

  // Evidence on every failure, because a journey that fails without a screenshot and a console
  // dump costs more to diagnose than it saved by existing.
  afterTest: async function afterTest(test, context, { passed }) {
    if (passed) return;
    const evidence = join(runRoot, 'evidence');
    const name = test.title.replace(/[^\w-]+/g, '-').slice(0, 80);
    try {
      await browser.saveScreenshot(join(evidence, `${name}.png`));
    } catch { /* the window may already be gone; the logs below still help */ }
    try {
      const logs = await browser.execute(() => (window.__osgConsole ?? []).slice(-200));
      console.log(`\n--- WebView console (${name}) ---\n${JSON.stringify(logs, null, 2)}`);
    } catch { /* console capture is best effort */ }
    console.log(`\n--- evidence kept at: ${runRoot} ---`);
    process.env.OSG_E2E_KEEP_ROOT = '1';
  },
};
