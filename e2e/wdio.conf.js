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

/* global browser, console, process */

import { copyFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  APPLICATION_BINARY, BUILT_APPLICATION_DIRECTORY, JOURNEY_TIMEOUT_MS,
  assertAutomationDialogGuard, assertStagedApplicationBinary, attachRunRootCaches, canReuseRunRoot,
  isolationEnvironment, managedStagingEnvironment, readVerifiedPublishedApplication,
  runRootAuthorization, stagedDialogPaths,
} from './support/environment.js';
import { readInheritedApplicationLease } from './support/applicationLease.js';
import {
  cachedRealVideo, ensureSourceSwitchVideo, verifiedDownloadIdentityVideo,
} from './support/realMedia.js';
import { stagedLongSyntheticMedia } from './support/longSyntheticMediaFixture.js';
import { waitForAutomationWindowIsolation } from './support/editor.js';
import {
  promoteWorkflowFailureEvidence, recordWorkflowTestFailure, workflowFailureStepForTest,
} from './support/workflowEvidence.js';
import { startDownloadFixtureOrigin } from './support/downloadFixtureOrigin.js';
import {
  assertGuardedWebDriverSession,
  assertWebDriverCommandIsNonInteractive,
  createGuardedWebDriverBinding,
  guardedWebDriverEnvironment,
  verifyGuardedWebDriverStatus,
} from './support/driverIdentity.js';
import { assertInstalledTauriServiceSafety } from './support/tauriServiceSafetyPatch.mjs';

// `npm ci --ignore-scripts` must fail here, before a run root is created and before the service can
// spawn anything. The postinstall patch is reproducible convenience; this assertion is authority.
assertInstalledTauriServiceSafety();

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
// The root is REUSED only by a real WDIO IPC worker or a reviewed multi-process scenario, because
// this config is loaded once in the launcher and again in each worker. Both must present the
// independently-created 256-bit authority stored in the root. A path, worker-looking environment,
// or explicit reuse flag alone is not authority. Creating another root in the worker produced two
// per run: the service spawned the binary into the launcher's root while the worker saved
// screenshots elsewhere.
const isWdioWorker = typeof process.send === 'function'
  && typeof process.env.WDIO_WORKER_ID === 'string'
  && process.env.WDIO_WORKER_ID.length > 0;
const samePath = (left, right) => (
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
);
const { inherited: inheritedApplication, publication: leasedPublication } = readInheritedApplicationLease({
  readPublication: readVerifiedPublishedApplication,
});
if (process.env.OSG_E2E_BINARY === undefined) {
  if (
    !samePath(leasedPublication.binaryPath, APPLICATION_BINARY)
    || !samePath(leasedPublication.applicationRoot, BUILT_APPLICATION_DIRECTORY)
    || basename(leasedPublication.applicationRoot) !== leasedPublication.applicationHash
  ) {
    throw new Error('the inherited E2E application publication does not match the selected binary');
  }
} else {
  const staged = assertStagedApplicationBinary(APPLICATION_BINARY);
  if (staged.marker.applicationHash !== inheritedApplication.applicationHash) {
    throw new Error('the staged E2E application was not copied from the inherited publication');
  }
}
assertAutomationDialogGuard(APPLICATION_BINARY);
if (!canReuseRunRoot({ environment: process.env, workerProcess: isWdioWorker })) {
  throw new Error('WDIO must inherit one authorized run root from its managed staging lease owner');
}
const runRoot = process.env.OSG_E2E_DATA_ROOT;
attachRunRootCaches({ root: runRoot });
const runAuthorization = runRootAuthorization(runRoot);
process.env.OSG_E2E_RUN_ROOT_AUTHORIZATION = runAuthorization;
Object.assign(process.env, managedStagingEnvironment(runRoot));
const webdriverBinding = await createGuardedWebDriverBinding({
  environment: process.env,
  runRoot,
  workerProcess: isWdioWorker,
});
Object.assign(process.env, guardedWebDriverEnvironment(webdriverBinding));
let guardedWebDriverProcessId = null;
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
// A damaged-install run has no E2E asset-lane lease by design. It tests only the private staged
// application, so it must not even inspect persistent media while that lane can be pruned.
const cachedVideo = process.env.OSG_E2E_BINARY === undefined ? cachedRealVideo() : null;
const dialogPaths = stagedDialogPaths(runRoot, cachedVideo);
if (process.env.OSG_E2E_MEDIA_SELECTION === undefined && cachedVideo !== null) {
  copyFileSync(cachedVideo, dialogPaths.mediaSelection);
  process.env.OSG_E2E_MEDIA_SELECTION = dialogPaths.mediaSelection;
}
if (process.env.OSG_E2E_WORKFLOW === 'main-preview-controls-and-fullscreen') {
  if (cachedVideo === null || process.env.OSG_E2E_MEDIA_SELECTION === undefined) {
    throw new Error('the preview-controls journey requires the cached real YouTube source');
  }
  const secondSource = await ensureSourceSwitchVideo();
  const stagedSecondSource = join(runRoot, 'input', `source-switch-${basename(secondSource)}`);
  copyFileSync(secondSource, stagedSecondSource);
  process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE = JSON.stringify([
    process.env.OSG_E2E_MEDIA_SELECTION,
    stagedSecondSource,
  ]);
}
if (process.env.OSG_E2E_WORKFLOW === 'long-media-resource-bounds') {
  // This workflow's whole point is a duration the pinned real video does not have. It replaces the
  // generic real-video default above with a wholly synthetic, offline-generated two-hour file (see
  // support/longSyntheticMediaFixture.js), and stages an ordinary short real source as the
  // sequence's second answer so the journey can cancel the long file's in-flight native waveform job
  // through a real customer action -- selecting different media -- rather than a fabricated hook.
  // The THIRD answer selects the long file again: the journey returns to it and lets its waveform
  // complete for real before proving the waveform/timeline-range and resource-bound claims.
  //
  // This config loads twice (launcher, then worker) and each load already holds the INHERITED
  // application lease from run-isolated.mjs's outer withE2eApplicationLease -- stagedLongSyntheticMedia
  // uses that inherited proof directly rather than acquiring a second, competing lease of its own,
  // exactly like scenarios/multiWindowAsrPersistence.mjs's stagedFourWindowAsrVideo call.
  const stagedLongMedia = stagedLongSyntheticMedia({
    inheritedApplication,
    stage: (source) => {
      const staged = join(runRoot, 'input', basename(source));
      copyFileSync(source, staged);
      return staged;
    },
  });
  const secondSource = await ensureSourceSwitchVideo();
  const stagedSecondSource = join(runRoot, 'input', `source-switch-${basename(secondSource)}`);
  copyFileSync(secondSource, stagedSecondSource);
  process.env.OSG_E2E_MEDIA_SELECTION = stagedLongMedia;
  process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE = JSON.stringify([
    stagedLongMedia,
    stagedSecondSource,
    stagedLongMedia,
  ]);
}
let downloadFixtureOrigin = null;
if (process.env.OSG_E2E_WORKFLOW === 'download-cancellation-retry-identity'
    || process.env.OSG_E2E_WORKFLOW === 'failed-download-no-stale') {
  // This configuration is loaded once by the WDIO launcher and again by its worker. Only the
  // launcher creates the origin; the exact capabilities then reach both the worker and the app as
  // inherited, immutable-at-launch environment values. The application cannot choose a URL and a
  // journey cannot widen the allow-list after it starts.
  if (process.env.OSG_E2E_EXACT_DOWNLOAD_URLS === undefined) {
    const sourceA = await ensureSourceSwitchVideo();
    const failureJourney = process.env.OSG_E2E_WORKFLOW === 'failed-download-no-stale';
    downloadFixtureOrigin = await startDownloadFixtureOrigin({
      eventsPath: join(runRoot, 'evidence', 'download-fixture-events.jsonl'),
      sources: failureJourney ? [
        { label: 'a', path: sourceA },
        // C is still a real, reviewed MP4 for yt-dlp inspection. After that first GET, the exact
        // origin returns 503 so the native job/failure/cleanup path runs without a product mock.
        { label: 'c', path: verifiedDownloadIdentityVideo(), rejectGetAfter: 1 },
      ] : [
        { label: 'a', path: sourceA },
        // A real committed speech clip, not generated colour bars. Real-network extraction stays
        // independently proven by urlToPreview instead of making cancellation timing depend on it.
        { label: 'b', path: verifiedDownloadIdentityVideo() },
      ],
      chunkDelayMs: failureJourney ? 10 : 120,
      initialDelayMs: failureJourney ? 0 : 2_000,
    });
    process.env.OSG_E2E_EXACT_DOWNLOAD_URLS = JSON.stringify(
      downloadFixtureOrigin.manifest.map(({ url }) => url),
    );
    process.env.OSG_E2E_DOWNLOAD_FIXTURE_MANIFEST = JSON.stringify(
      downloadFixtureOrigin.manifest,
    );
    process.env.OSG_E2E_DOWNLOAD_FIXTURE_EVENTS = downloadFixtureOrigin.eventsPath;
  }
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
    'osg:e2eAuthorization': webdriverBinding.authorization,
    'tauri:options': {
      application: APPLICATION_BINARY,
      driverProvider: 'embedded',
      // A genuinely clean profile can spend more than the service's 60-second default installing
      // and verifying managed runtime packages before the embedded server starts accepting
      // sessions. The window is already created entirely off-screen by the E2E-only Rust feature, so
      // waiting here cannot interrupt the desktop. Treat a slow cold start as slow, not as a crash.
      startTimeout: 180_000,
    },
    'wdio:tauriServiceOptions': {
      embeddedPort: webdriverBinding.port,
      env: guardedWebDriverEnvironment(webdriverBinding),
      // A startup fail-fast (observed once: exit 0xC0000409 before the embedded server was
      // ready, with the run root still empty) leaves evidence ONLY on the app's stderr — a Rust
      // panic that aborts inside a non-unwinding callback prints there before dying. Forward the
      // backend streams so a recurrence names its own cause.
      captureBackendLogs: true,
      backendLogLevel: 'trace',
    },
  }],
  reporters: ['spec'],
  framework: 'mocha',
  // Longer than any single journey's internal waits. When mocha's cap fires first it reports
  // only "took too long", discarding the observation the journey collected about WHY.
  // Heavy engine-install journeys legitimately run for hours. Cross-process persistence is driven
  // by scenario runners that launch this configuration twice, never by extending one Mocha test.
  mochaOpts: {
    ui: 'bdd',
    timeout: JOURNEY_TIMEOUT_MS,
    require: ['./support/mochaHooks.js'],
  },
  logLevel: 'warn',
  // The backend-stream forwarder logs raw stderr lines at their parsed level, which defaults to
  // info for unstructured text such as a panic message; the global 'warn' level would swallow
  // exactly the lines the capture exists for. Observed: this key opens every tauri-service:*
  // channel, not only :service — the extra debug lines are accepted as failure context.
  logLevels: { 'tauri-service:service': 'trace' },

  onPrepare: () => {
    if (process.env.OSG_E2E_DATA_ROOT !== runRoot) {
      throw new Error('the isolation environment was overwritten before the run started');
    }
    assertAutomationDialogGuard(APPLICATION_BINARY);
  },

  // The upstream service considers any ready server on its port to be the process it just spawned.
  // Verify the compiled marker, PID and 256-bit run identity before WebDriver creates a session.
  beforeSession: async () => {
    ({ processId: guardedWebDriverProcessId } = await verifyGuardedWebDriverStatus(webdriverBinding));
  },

  // This application has exactly one WebView. Mark its existing WebDriver handle as the explicit
  // target once, before a journey issues element commands. Without this, tauri-service performs an
  // active-window discovery call before every `$`, `$$` and click. Its direct-eval bridge is not
  // available in a small but repeatable fraction of otherwise healthy embedded sessions, so each
  // discovery waits five seconds even though ordinary WebDriver commands are already attached to
  // the rendered editor. An explicit standard WebDriver switch suppresses that irrelevant recovery
  // path; it does not navigate, inject state, mock IPC or choose a different application window.
  before: async () => {
    assertGuardedWebDriverSession(
      browser.capabilities,
      webdriverBinding,
      guardedWebDriverProcessId,
    );
    const handle = await browser.getWindowHandle();
    await browser.switchToWindow(handle);
    await waitForAutomationWindowIsolation();
  },

  // Defense in depth above the server-side refusals. The vendored server independently runs the
  // native off-screen/non-focusable invariant before every HTTP request, including screenshots and
  // synthetic input; these names must never reach its mutation routes.
  beforeCommand: (commandName) => {
    assertWebDriverCommandIsNonInteractive(commandName);
  },

  // Suite/root hooks can fail before a journey body starts, most importantly the native hidden-
  // window preflight. They do not enter afterTest, so retain the same exact bounded Error here.
  afterHook: (test, context, { error, passed }, hookName) => {
    if (passed) return;
    const workflow = process.env.OSG_E2E_WORKFLOW;
    if (!workflow) return;
    try {
      recordWorkflowTestFailure({ workflow, test: { ...test, hook: hookName }, error });
    } catch (captureError) {
      console.log(`\n--- immutable hook failure unavailable: ${captureError.message} ---`);
    }
  },

  // Launcher-owned network resources must outlive the application session but never the WDIO run.
  // A worker sees only the inherited manifest and therefore has nothing it can accidentally close.
  onComplete: async () => {
    let resourceError;
    try {
      if (downloadFixtureOrigin !== null) await downloadFixtureOrigin.close();
    } catch (error) {
      resourceError = error;
    }
    if (resourceError !== undefined) throw resourceError;
  },

  // Evidence on every failure. The promoted bundle already records bounded WebView diagnostics and
  // app-log tails; querying WebDriver logs again here only duplicates the request (and the embedded
  // provider's unsupported-command warnings) without adding evidence.
  afterTest: async function afterTest(test, context, { error, passed }) {
    if (passed) return;
    const title = typeof test.title === 'string' ? test.title : 'unknown test';
    const failureStep = workflowFailureStepForTest(title);
    const fallbackScreenshot = join(runRoot, 'evidence', `${failureStep}.png`);
    let savedFallback = null;
    const workflow = process.env.OSG_E2E_WORKFLOW;
    // The Error object exists independently of the WebView session. Persist it first: a failed
    // transport may make every screenshot and execute call below unavailable.
    if (workflow) {
      try {
        recordWorkflowTestFailure({ workflow, test, error });
      } catch (captureError) {
        console.log(`\n--- immutable test failure unavailable: ${captureError.message} ---`);
      }
    }
    // Screenshot first. Page evaluation is one of the operations most likely to be broken after a
    // timeout or renderer failure, while WebDriver can still often return the last composited frame.
    try {
      await browser.saveScreenshot(fallbackScreenshot);
      savedFallback = fallbackScreenshot;
    } catch { /* the window may already be gone; immutable diagnostics still capture app logs */ }
    if (workflow) {
      try {
        await promoteWorkflowFailureEvidence({
          workflow,
          step: failureStep,
          description: `Failure evidence: ${title}`,
          fallbackScreenshot: savedFallback,
        });
      } catch (error) {
        console.log(`\n--- immutable failure evidence unavailable: ${error.message} ---`);
      }
    }
    // The isolated runner removes the run root unconditionally; what survives a failure is the
    // workflow evidence attempt, into which the runner promotes the root's staged evidence.
    console.log(`\n--- failure evidence retained in the workflow evidence lane (run root: ${runRoot}) ---`);
  },
};
