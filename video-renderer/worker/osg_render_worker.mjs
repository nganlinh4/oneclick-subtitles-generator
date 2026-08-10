import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export const PROTOCOL_VERSION = 1;
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 64 * 1024;
const REMOTION_VERSION = '4.0.507';
const ALLOWED_FPS = new Set([24, 25, 30, 50, 60, 120]);
const REQUEST_KEYS = [
  'protocolVersion',
  'requestType',
  'serveUrl',
  'browserExecutable',
  'rendererRoot',
  'binariesDirectory',
  'outputLocation',
  'compositionId',
  'inputProps',
  'width',
  'height',
  'fps',
  'durationInFrames',
];

const exactKeys = (value, expected) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
};

const boundedAbsolutePath = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024 && !value.includes('\0') && path.isAbsolute(value);

const existingPath = (value, kind) => {
  if (!boundedAbsolutePath(value)) return false;
  let stats;
  try {
    stats = fs.lstatSync(value);
  } catch {
    return false;
  }
  if (stats.isSymbolicLink()) return false;
  return kind === 'file' ? stats.isFile() : stats.isDirectory();
};

export const validateRequest = (request) => {
  if (!exactKeys(request, REQUEST_KEYS)) return false;
  if (request.protocolVersion !== PROTOCOL_VERSION || request.requestType !== 'render') return false;
  if (request.compositionId !== 'subtitled-video') return false;
  if (!existingPath(request.serveUrl, 'directory')) return false;
  if (!existingPath(request.browserExecutable, 'file')) return false;
  if (!existingPath(request.rendererRoot, 'directory')) return false;
  if (!existingPath(request.binariesDirectory, 'directory')) return false;
  if (!boundedAbsolutePath(request.outputLocation)) return false;
  if (!existingPath(path.dirname(request.outputLocation), 'directory') || fs.existsSync(request.outputLocation)) return false;
  if (!Number.isSafeInteger(request.width) || request.width < 2 || request.width > 15360 || request.width % 2 !== 0) return false;
  if (!Number.isSafeInteger(request.height) || request.height < 2 || request.height > 8640 || request.height % 2 !== 0) return false;
  if (!Number.isSafeInteger(request.fps) || !ALLOWED_FPS.has(request.fps)) return false;
  if (!Number.isSafeInteger(request.durationInFrames) || request.durationInFrames < 1 || request.durationInFrames > 1_000_000) return false;
  if (request.inputProps === null || typeof request.inputProps !== 'object' || Array.isArray(request.inputProps)) return false;
  if (request.inputProps.audioUrl !== 'job-media/source-audio.aac') return false;
  if (request.inputProps.framesPathUrl !== 'job-media/frames') return false;
  if (request.inputProps.extractedAudioUrl !== 'job-media/source-audio.aac') return false;
  if (request.inputProps.metadata?.fontStylesheetUrl !== 'fonts/fonts.css') return false;
  if (request.inputProps.narrationUrl !== undefined && !/^job-media\/narration\.[a-z0-9]{1,16}$/.test(request.inputProps.narrationUrl)) return false;
  return true;
};

export const encodeFrame = (message) => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > MAX_MESSAGE_BYTES) throw new Error('invalid-frame');
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
};

export const decodeSingleRequest = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 5 || bytes.length > MAX_REQUEST_BYTES + 4) throw new Error('invalid-request');
  const length = bytes.readUInt32BE(0);
  if (length === 0 || length > MAX_REQUEST_BYTES || length + 4 !== bytes.length) throw new Error('invalid-request');
  let request;
  try {
    request = JSON.parse(bytes.subarray(4).toString('utf8'));
  } catch {
    throw new Error('invalid-request');
  }
  return request;
};

const readRequest = async () => {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_REQUEST_BYTES + 4) throw new Error('invalid-request');
    chunks.push(chunk);
  }
  return decodeSingleRequest(Buffer.concat(chunks, total));
};

const installQuietOutput = () => {
  process.stdout.write = () => true;
  const suppressed = () => {};
  console.log = suppressed;
  console.info = suppressed;
  console.warn = suppressed;
  console.error = suppressed;
};

const writeProtocolFrame = (message) => {
  fs.writeSync(1, encodeFrame(message));
};

const failureCode = (error) => {
  if (error?.code === 'OSG_CANCELLED') return 'cancelled';
  if (error?.code === 'OSG_INVALID_REQUEST') return 'invalidRequest';
  if (error?.code === 'OSG_RUNTIME_UNAVAILABLE') return 'runtimeUnavailable';
  if (error?.code === 'OSG_COMPOSITION_UNAVAILABLE') return 'compositionUnavailable';
  if (error?.code === 'OSG_BROWSER_FAILURE') return 'browserFailure';
  if (error?.code === 'OSG_OUTPUT_INVALID') return 'outputInvalid';
  return 'renderFailure';
};

const codedError = (code) => Object.assign(new Error('render-worker-failure'), {code});

const main = async () => {
  if (process.argv.length !== 3 || process.argv[2] !== '--stdio-v1') process.exit(64);
  installQuietOutput();
  writeProtocolFrame({type: 'ready', protocolVersion: PROTOCOL_VERSION});

  let cancel = null;
  let cancelled = false;
  const onSignal = () => {
    cancelled = true;
    if (cancel) cancel();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const request = await readRequest();
    if (!validateRequest(request)) throw codedError('OSG_INVALID_REQUEST');
    const rendererPackage = path.join(request.rendererRoot, 'package.json');
    let packageJson;
    try {
      packageJson = JSON.parse(fs.readFileSync(rendererPackage, 'utf8'));
    } catch {
      throw codedError('OSG_RUNTIME_UNAVAILABLE');
    }
    if (packageJson.version !== REMOTION_VERSION) throw codedError('OSG_RUNTIME_UNAVAILABLE');

    let renderer;
    try {
      const require = createRequire(rendererPackage);
      renderer = require(request.rendererRoot);
    } catch {
      throw codedError('OSG_RUNTIME_UNAVAILABLE');
    }
    const {makeCancelSignal, renderMedia, selectComposition} = renderer;
    if (typeof makeCancelSignal !== 'function' || typeof renderMedia !== 'function' || typeof selectComposition !== 'function') {
      throw codedError('OSG_RUNTIME_UNAVAILABLE');
    }
    const cancellation = makeCancelSignal();
    cancel = cancellation.cancel;
    if (cancelled) throw codedError('OSG_CANCELLED');

    writeProtocolFrame({
      type: 'progress',
      fractionMillionths: 0,
      renderedFrames: 0,
      encodedFrames: 0,
      durationInFrames: request.durationInFrames,
      phase: 'loadingComposition',
    });
    let composition;
    try {
      composition = await selectComposition({
        serveUrl: request.serveUrl,
        id: request.compositionId,
        inputProps: request.inputProps,
        browserExecutable: request.browserExecutable,
        binariesDirectory: request.binariesDirectory,
        chromeMode: 'chrome-for-testing',
        logLevel: 'error',
        onBrowserDownload: () => {
          throw codedError('OSG_RUNTIME_UNAVAILABLE');
        },
      });
    } catch {
      throw codedError('OSG_COMPOSITION_UNAVAILABLE');
    }
    if (cancelled) throw codedError('OSG_CANCELLED');

    let fractionMillionths = 0;
    let renderedFrames = 0;
    let encodedFrames = 0;
    let phase = 'renderingFrames';
    await renderMedia({
      composition: {
        ...composition,
        width: request.width,
        height: request.height,
        fps: request.fps,
        durationInFrames: request.durationInFrames,
      },
      serveUrl: request.serveUrl,
      outputLocation: request.outputLocation,
      inputProps: request.inputProps,
      browserExecutable: request.browserExecutable,
      binariesDirectory: request.binariesDirectory,
      chromeMode: 'chrome-for-testing',
      codec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      crf: 18,
      audioBitrate: '256k',
      hardwareAcceleration: 'disable',
      logLevel: 'error',
      cancelSignal: cancellation.cancelSignal,
      onBrowserDownload: () => {
        throw codedError('OSG_RUNTIME_UNAVAILABLE');
      },
      onProgress: (progress) => {
        const observedFraction = Math.max(0, Math.min(1_000_000, Math.floor(Number(progress.progress || 0) * 1_000_000)));
        fractionMillionths = Math.max(fractionMillionths, observedFraction);
        renderedFrames = Math.max(renderedFrames, Math.min(request.durationInFrames, Number(progress.renderedFrames || 0)));
        encodedFrames = Math.max(encodedFrames, Math.min(request.durationInFrames, Number(progress.encodedFrames || 0)));
        if (encodedFrames > 0) phase = 'encoding';
        writeProtocolFrame({
          type: 'progress',
          fractionMillionths,
          renderedFrames,
          encodedFrames,
          durationInFrames: request.durationInFrames,
          phase,
        });
      },
    });
    if (cancelled) throw codedError('OSG_CANCELLED');
    writeProtocolFrame({
      type: 'progress',
      fractionMillionths: 1_000_000,
      renderedFrames: request.durationInFrames,
      encodedFrames: request.durationInFrames,
      durationInFrames: request.durationInFrames,
      phase: 'muxing',
    });
    const output = fs.lstatSync(request.outputLocation);
    if (!output.isFile() || output.isSymbolicLink() || output.size < 32) throw codedError('OSG_OUTPUT_INVALID');
    writeProtocolFrame({type: 'completed', outputBytes: output.size});
  } catch (error) {
    const code = cancelled ? 'cancelled' : failureCode(error);
    writeProtocolFrame({type: 'failed', code});
    process.exitCode = code === 'cancelled' ? 130 : 1;
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
