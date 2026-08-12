import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { CdpClient, discoverTarget } from './inspect-installed-webview.mjs';

const MEDIA_URL = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
const SUBTITLE_MARKER = 'OSG installed media smoke';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYBACK_URL = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

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
      'Usage: inspect-installed-media-flow.mjs --port PORT --srt PATH --screenshot PATH');
    invariant(!values.has(key), `Duplicate argument: ${key}`);
    values.set(key, value);
  }
  invariant(values.size === 3, 'Only reviewed installed media-flow arguments are accepted');
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
  return Object.freeze({ port, srt, screenshot });
}

const hasExactKeys = (value, keys) => value && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function assertMediaFlowResult(value) {
  invariant(hasExactKeys(value, [
    'assetId', 'currentFileName', 'currentFileUrl', 'errorToastCount', 'jobs', 'session',
    'subtitleMarkerVisible', 'tools', 'uploadedSrtInfo', 'video',
  ]), 'Installed media flow returned an invalid result shape');
  invariant(UUID_V7.test(value.assetId ?? ''), 'Installed media flow did not publish a UUIDv7 asset');
  const playback = typeof value.currentFileUrl === 'string'
    ? PLAYBACK_URL.exec(value.currentFileUrl)
    : null;
  invariant(playback !== null && Number(playback[1]) >= 1 && Number(playback[1]) <= 65_535,
    'Installed media flow did not publish a tokenized loopback capability');
  invariant(typeof value.currentFileName === 'string' && value.currentFileName.endsWith('.mp4'),
    'Installed media flow did not retain an MP4 display name');
  invariant(hasExactKeys(value.video, [
    'currentSrc', 'duration', 'height', 'paused', 'readyState', 'width',
  ])
    && value.video.currentSrc === value.currentFileUrl
    && Number.isFinite(value.video.duration) && value.video.duration > 1
    && Number.isInteger(value.video.readyState) && value.video.readyState >= 1
    && Number.isInteger(value.video.width) && value.video.width > 0
    && Number.isInteger(value.video.height) && value.video.height > 0,
  'Installed media element did not decode the downloaded video metadata');
  invariant(value.subtitleMarkerVisible === true
    && hasExactKeys(value.uploadedSrtInfo, ['fileName', 'hasUploaded', 'source'])
    && value.uploadedSrtInfo.hasUploaded === true
    && value.uploadedSrtInfo.fileName === 'osg-installed-media-smoke.srt'
    && value.uploadedSrtInfo.source === 'srt',
  'Installed media flow lost the uploaded SRT state or rendered marker');
  invariant(value.errorToastCount === 0, 'Installed media flow displayed an error toast');
  invariant(value.session?.media?.id === value.assetId
    && value.session?.media?.kind === 'video'
    && value.session?.playback?.playbackUrl === value.currentFileUrl,
  'Installed native session and visible media capability diverged');
  invariant(Array.isArray(value.tools?.tools) && value.tools.tools.length === 3
    && value.tools.tools.every((tool) => tool.state === 'installed'
      && tool.installed === true
      && tool.activeRuntime === true
      && tool.pendingRemoval === false
      && tool.restartRequired === false
      && tool.operation === null),
  'Installed native tools were not immediately active after parallel on-demand installation');
  invariant(Array.isArray(value.jobs)
    && value.jobs.some((job) => job.kind === 'downloadMedia'
      && job.state === 'succeeded' && job.progress?.basisPoints === 10_000)
    && !value.jobs.some((job) => job.kind === 'renderVideo'),
  'Installed button flow did not finish as a download-only job');
  return value;
}

const evaluate = async (client, expression) => {
  const evaluation = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  invariant(!evaluation.exceptionDetails,
    `Installed media-flow evaluation threw: ${evaluation.exceptionDetails?.text ?? 'unknown error'}`);
  return evaluation.result?.value;
};

export async function waitForValue(read, accept, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delay = () => new Promise((resolve) => setTimeout(resolve, 500)),
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  let lastValue;
  do {
    lastValue = await read();
    if (accept(lastValue)) return lastValue;
    await delay();
  } while (now() < deadline);
  throw new Error(`Installed media flow timed out: ${JSON.stringify(lastValue)}`);
}

const SET_URL_EXPRESSION = `
(() => {
  const input = document.querySelector('.url-field');
  if (!(input instanceof HTMLInputElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (typeof setter !== 'function') return false;
  setter.call(input, ${JSON.stringify(MEDIA_URL)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

const READY_TO_START_EXPRESSION = `
(() => ({
  url: document.querySelector('.url-field')?.value ?? null,
  srtReady: document.querySelector('.srt-upload-button.has-srt-uploaded') !== null,
  startReady: document.querySelector('.generate-btn.semi-auto:not([disabled])') !== null,
}))()`;

const START_EXPRESSION = `
(() => {
  const button = document.querySelector('.generate-btn.semi-auto:not([disabled])');
  if (!(button instanceof HTMLButtonElement)) return false;
  button.click();
  return true;
})()`;

const RESULT_EXPRESSION = `
(async () => {
  const assetId = localStorage.getItem('current_file_cache_id');
  const currentFileUrl = localStorage.getItem('current_file_url');
  const currentFileName = localStorage.getItem('current_file_name');
  const videoElement = document.querySelector('video.video-player');
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  let tools = null;
  let jobs = null;
  let session = null;
  if (typeof invoke === 'function') {
    [tools, jobs, session] = await Promise.all([
      invoke('native_tools_status'),
      invoke('jobs_list'),
      invoke('get_session_snapshot'),
    ]);
  }
  let uploadedSrtInfo = null;
  try { uploadedSrtInfo = JSON.parse(localStorage.getItem('uploaded_srt_info')); } catch {}
  return {
    assetId,
    currentFileName,
    currentFileUrl,
    errorToastCount: document.querySelectorAll('.toast-error').length,
    jobs,
    session,
    subtitleMarkerVisible: document.body.innerText.includes(${JSON.stringify(SUBTITLE_MARKER)}),
    tools,
    uploadedSrtInfo,
    video: videoElement ? {
      currentSrc: videoElement.currentSrc,
      duration: videoElement.duration,
      height: videoElement.videoHeight,
      paused: videoElement.paused,
      readyState: videoElement.readyState,
      width: videoElement.videoWidth,
    } : null,
  };
})()`;

async function runInstalledMediaFlow(options) {
  const target = await discoverTarget(options.port);
  const client = new CdpClient(target.webSocketDebuggerUrl, DEFAULT_TIMEOUT_MS);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('DOM.enable');
    invariant(await evaluate(client, SET_URL_EXPRESSION) === true,
      'Installed media flow could not enter the reviewed URL');
    const documentNode = await client.send('DOM.getDocument', { depth: -1, pierce: true });
    const input = await client.send('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: 'input[type="file"][accept=".srt,.json"]',
    });
    invariant(Number.isInteger(input.nodeId) && input.nodeId > 0,
      'Installed media flow could not find the SRT input');
    await client.send('DOM.setFileInputFiles', { files: [options.srt], nodeId: input.nodeId });
    await evaluate(client, `
      (() => {
        const input = document.querySelector('input[type="file"][accept=".srt,.json"]');
        if (!(input instanceof HTMLInputElement) || input.files?.length !== 1) return false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
    await waitForValue(
      () => evaluate(client, READY_TO_START_EXPRESSION),
      (value) => value?.url === MEDIA_URL && value.srtReady === true && value.startReady === true,
      { timeoutMs: 60_000 },
    );
    invariant(await evaluate(client, START_EXPRESSION) === true,
      'Installed media flow could not click the real semi-automatic action');
    const result = await waitForValue(
      () => evaluate(client, RESULT_EXPRESSION),
      (value) => {
        try {
          assertMediaFlowResult(value);
          return true;
        } catch {
          return false;
        }
      },
    );
    assertMediaFlowResult(result);
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
      downloadJobs: result.jobs.filter((job) => job.kind === 'downloadMedia').length,
      renderJobs: result.jobs.filter((job) => job.kind === 'renderVideo').length,
      screenshotBytes: bytes.length,
      screenshotSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      toolVersions: Object.fromEntries(result.tools.tools.map((tool) => [tool.id, tool.version])),
      videoDuration: result.video.duration,
      videoHeight: result.video.height,
      videoWidth: result.video.width,
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => runInstalledMediaFlow(parseArguments(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Installed media flow failed'}\n`);
      process.exitCode = 1;
    });
}
