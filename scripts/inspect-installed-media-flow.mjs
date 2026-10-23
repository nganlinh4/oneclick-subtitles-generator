import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';
import { readPlaybackCapability, sanitizeInspectorError } from './installed-media-flow/capability.mjs';
import {
  ACTIVATE_URL_TAB_EXPRESSION,
  CONFIGURE_MEDIA_PHASE_EXPRESSION,
  MEDIA_RESULT_EXPRESSION,
  SET_URL_EXPRESSION,
  SRT_READY_EXPRESSION,
  START_EXPRESSION,
  URL_CONTROL_READY_EXPRESSION,
  URL_STAGED_EXPRESSION,
} from './installed-media-flow/expressions.mjs';
import {
  assertFirstMediaDocumentPreserved,
  assertMediaFlowResult,
  assertMediaFlowState,
  assertStagedReplacementPreservesActiveMedia,
  collectDownloadJobIds,
  hasCompletedReplacementForImport,
  hasMediaFlowStarted,
  newDownloadJobs,
} from './installed-media-flow/guards.mjs';
import {
  DEFAULT_TIMEOUT_MS,
  REVIEWED_TIMEOUT_FAILURE_CODES,
  UUID_V7,
  invariant,
} from './installed-media-flow/shared.mjs';

const isInside = (candidate, root) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
};

export function parseArguments(argv, environment = process.env) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    invariant(/^--[a-z-]+$/.test(key ?? '') && value !== undefined,
      'Usage: inspect-installed-media-flow.mjs --port PORT --srt PATH --screenshot PATH '
        + '--media-phase initial|reactivation '
        + '[--prior-asset-id UUID]');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  const requiredKeys = ['--port', '--srt', '--screenshot', '--media-phase'];
  const acceptedKeys = new Set([...requiredKeys, '--prior-asset-id']);
  invariant((values.size === 4 || values.size === 5)
    && requiredKeys.every((key) => values.has(key))
    && [...values.keys()].every((key) => acceptedKeys.has(key)),
  'Only reviewed installed media-flow arguments are accepted');
  const port = Number(values.get('--port'));
  invariant(Number.isInteger(port) && port >= 1_024 && port <= 65_535,
    'DevTools port must be an unprivileged TCP port');
  invariant(typeof environment.RUNNER_TEMP === 'string' && environment.RUNNER_TEMP.length > 0,
    'RUNNER_TEMP is required for the installed media-flow smoke');
  const runnerTemp = fs.realpathSync(environment.RUNNER_TEMP);
  const srt = fs.realpathSync(values.get('--srt'));
  const screenshot = path.resolve(values.get('--screenshot'));
  invariant(isInside(srt, runnerTemp), 'SRT fixture must stay inside RUNNER_TEMP');
  invariant(isInside(screenshot, runnerTemp), 'Screenshot must stay inside RUNNER_TEMP');
  const stats = fs.statSync(srt);
  invariant(stats.isFile() && stats.size > 0 && stats.size <= 64 * 1_024,
    'SRT fixture must be a bounded regular file');
  invariant(path.extname(srt).toLowerCase() === '.srt', 'SRT fixture must use the .srt extension');
  invariant(!fs.existsSync(screenshot), 'Installed media-flow screenshot path must be clean');
  const priorAssetId = values.get('--prior-asset-id') ?? null;
  invariant(priorAssetId === null || UUID_V7.test(priorAssetId),
    'Prior installed media asset identity is invalid');
  const mediaPhase = values.get('--media-phase');
  mediaPreferencesForPhase(mediaPhase);
  invariant((mediaPhase === 'initial' && priorAssetId === null)
    || (mediaPhase === 'reactivation' && priorAssetId !== null),
  'Installed media-flow phase and prior asset are inconsistent');
  return Object.freeze({ port, srt, screenshot, priorAssetId, mediaPhase });
}

export function mediaPreferencesForPhase(mediaPhase) {
  if (mediaPhase === 'initial') {
    return Object.freeze({ autoImport: 'true', preferredLanguages: '["en"]' });
  }
  if (mediaPhase === 'reactivation') {
    return Object.freeze({ autoImport: 'false', preferredLanguages: '["en"]' });
  }
  throw new Error('Installed media-flow phase is invalid');
}

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails, 'Installed media-flow evaluation failed');
  return evaluation.result?.value;
};

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
  failureCode = 'terminal-state-timeout',
} = {}) {
  invariant(REVIEWED_TIMEOUT_FAILURE_CODES.includes(failureCode),
    'Installed media-flow timeout category is invalid');
  const deadline = now() + timeoutMs;
  do {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch (error) {
      throw new Error(sanitizeInspectorError(error, 'Installed media-flow probe failed'));
    }
    await delay();
  } while (now() < deadline);
  throw new Error(`Installed media flow timed out: ${failureCode}`);
}

async function runInstalledMediaFlow(options) {
  const mediaPreferences = mediaPreferencesForPhase(options.mediaPhase);
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('DOM.enable');
    await waitForValue(
      () => evaluate(client, ACTIVATE_URL_TAB_EXPRESSION),
      (value) => value === 'already-active' || value === 'activated',
      { timeoutMs: 30_000, failureCode: 'url-tab-timeout' },
    );
    await waitForValue(
      () => evaluate(client, URL_CONTROL_READY_EXPRESSION),
      (value) => value === true,
      { timeoutMs: 30_000, failureCode: 'url-tab-timeout' },
    );
    // This smoke owns a disposable isolated profile. Keep the exact phase preferences in place
    // through START so the product action reads the reviewed native-adapter cache-key dimension.
    invariant(await evaluate(client, CONFIGURE_MEDIA_PHASE_EXPRESSION(mediaPreferences)) === true,
      'Installed media flow could not configure the reviewed phase');
    const activeState = options.priorAssetId === null
      ? null
      : await evaluate(client, MEDIA_RESULT_EXPRESSION);
    const priorCacheId = activeState?.workspace?.cacheId ?? null;
    invariant(await evaluate(client, SET_URL_EXPRESSION) === true,
      'Installed media flow could not enter the reviewed URL');
    await waitForValue(
      () => evaluate(client, URL_STAGED_EXPRESSION),
      (value) => value === true,
      { timeoutMs: 60_000, failureCode: 'url-stage-timeout' },
    );
    if (options.priorAssetId !== null) {
      const stagedState = await evaluate(client, MEDIA_RESULT_EXPRESSION);
      assertStagedReplacementPreservesActiveMedia(
        activeState, stagedState, options.priorAssetId,
      );
    }
    // Import explicitly for this project. Native local-media activation intentionally does not
    // inherit the preceding URL project's captions or its uploaded-SRT provenance.
    const importSubtitles = async () => {
      const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
      const inputs = await client.send('DOM.querySelectorAll', {
        nodeId: documentNode.root.nodeId,
        selector: '.buttons-container .srt-upload-buttons-group input[type="file"][accept=".srt,.json"]',
      });
      invariant(Array.isArray(inputs.nodeIds) && inputs.nodeIds.length === 1
        && Number.isInteger(inputs.nodeIds[0]) && inputs.nodeIds[0] > 0,
      'Installed media flow could not find one exact SRT input');
      await client.send('DOM.setFileInputFiles', {
        files: [options.srt], nodeId: inputs.nodeIds[0],
      });
    };
    await importSubtitles();
    await waitForValue(
      () => evaluate(client, SRT_READY_EXPRESSION(mediaPreferences, priorCacheId)),
      (value) => value === true,
      { timeoutMs: 60_000, failureCode: 'srt-readiness-timeout' },
    );
    const baselineState = await evaluate(client, MEDIA_RESULT_EXPRESSION);
    const baselineDownloadJobIds = collectDownloadJobIds(baselineState);
    if (options.priorAssetId !== null) {
      invariant(baselineState?.session?.media?.id === options.priorAssetId,
        'Installed media flow did not begin from the reviewed prior asset');
    }
    const flowGuard = {
      priorAssetId: options.priorAssetId,
      baselineDownloadJobIds,
    };
    invariant(await evaluate(
      client, START_EXPRESSION(mediaPreferences, priorCacheId),
    ) === true,
      'Installed media flow could not click the real semi-automatic action');
    await waitForValue(
      () => evaluate(client, MEDIA_RESULT_EXPRESSION),
      (value) => hasMediaFlowStarted(value, flowGuard),
      { timeoutMs: 30_000, failureCode: 'download-start-timeout' },
    );
    let completedAt = null;
    let lastStateRefusal = 'No accepted media state';
    let replacementImportComplete = options.priorAssetId === null;
    const state = await waitForValue(
      async () => {
        const value = await evaluate(client, MEDIA_RESULT_EXPRESSION);
        if (!replacementImportComplete && hasCompletedReplacementForImport(value, flowGuard)) {
          // The first import belongs to A. Explicitly import into B only after its native
          // activation and visible player agree; provenance must never leak across projects.
          await importSubtitles();
          replacementImportComplete = true;
        }
        return value;
      },
      (value) => {
        hasMediaFlowStarted(value, flowGuard);
        try {
          assertMediaFlowState(value, flowGuard);
          return true;
        } catch (error) {
          lastStateRefusal = sanitizeInspectorError(error, 'Invalid installed media state');
          const downloads = newDownloadJobs(value, baselineDownloadJobIds);
          if (downloads.some((job) => job.state === 'failed' || job.state === 'cancelled')) {
            throw new Error(`Installed download terminated without success: ${lastStateRefusal}`);
          }
          if (downloads.length === 1 && downloads[0].state === 'succeeded') {
            completedAt ??= Date.now();
            if (Date.now() - completedAt > 30_000) {
              throw new Error(`Installed completed download did not settle: ${lastStateRefusal}`);
            }
          }
          return false;
        }
      },
      { failureCode: 'terminal-state-timeout' },
    );
    assertMediaFlowState(state, flowGuard);
    if (options.priorAssetId === null) assertFirstMediaDocumentPreserved(baselineState, state);
    const result = {
      ...state,
      playbackBytes: await readPlaybackCapability(state.currentFileUrl),
    };
    assertMediaFlowResult(result, flowGuard);
    const capture = await client.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });
    invariant(typeof capture.data === 'string', 'Installed media-flow screenshot was empty');
    const bytes = Buffer.from(capture.data, 'base64');
    invariant(bytes.length > 10_000 && bytes.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'Installed media-flow screenshot is not a PNG');
    fs.writeFileSync(options.screenshot, bytes, { flag: 'wx' });
    return {
      assetId: result.assetId,
      currentFileName: result.currentFileName,
      downloadJobs: newDownloadJobs(result, baselineDownloadJobIds).length,
      renderJobs: result.jobs.filter((job) => job.kind === 'renderVideo').length,
      fixtureBytes: result.playbackBytes.byteLength,
      fixtureSha256: result.playbackBytes.sha256,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      toolVersions: Object.fromEntries(result.tools.tools.map((tool) => [tool.id, tool.version])),
      videoDuration: result.video.duration,
      videoHeight: result.video.height,
      videoWidth: result.video.width,
    };
  } catch (error) {
    try {
      const capture = await client.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false, fromSurface: true,
      });
      fs.writeFileSync(options.screenshot.replace(/\.png$/i, '-failure.png'),
        Buffer.from(capture.data, 'base64'), { flag: 'wx' });
    } catch {
      // Evidence capture cannot replace the original workflow failure.
    }
    throw error;
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledMediaFlow(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${sanitizeInspectorError(error)}\n`);
      process.exitCode = 1;
    });
}
