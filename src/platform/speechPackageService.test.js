import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';

import {
  SPEECH_PACKAGE_BACKENDS,
  SpeechPackageServiceError,
  createNativeSpeechPackageService,
  normalizeSpeechPackageEvent,
  normalizeSpeechPackagesStatus,
} from './speechPackageService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

class TestChannel {
  onmessage = () => {};

  emit(value) {
    this.onmessage(value);
  }
}

const jobSnapshot = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'installEngine',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const operation = (job, overrides = {}) => ({
  job,
  backend: 'f5-tts',
  action: 'install',
  phase: 'downloading',
  basisPoints: job.progress.basisPoints,
  bytesDone: 0,
  totalBytes: 100,
  ...overrides,
});

const unavailableStatus = () => ({
  schemaVersion: 1,
  packages: SPEECH_PACKAGE_BACKENDS.map((id, index) => ({
    id,
    label: `Speech package ${index + 1}`,
    deliveryAvailable: false,
    installed: false,
    updateAvailable: false,
    state: 'unavailable',
    version: null,
    availableVersion: null,
    installedBytes: 0,
    downloadBytes: 0,
    availableInstalledBytes: 0,
    operation: null,
  })),
});

const createService = (overrides = {}) => createNativeSpeechPackageService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});

it('contains no browser transport, storage, path, URL, file, or byte payload fields', () => {
  const source = fs.readFileSync(path.join(__dirname, 'speechPackageService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/u);
  expect(source).not.toMatch(/localStorage\s*\./u);
  expect(source).not.toMatch(/https?:\/\//iu);
  expect(source).not.toMatch(/\b(path|url|file|base64|buffer)\s*:/iu);
});

it('strictly validates, freezes, and orders the empty managed speech catalog', () => {
  const raw = unavailableStatus();
  raw.packages.reverse();
  const status = normalizeSpeechPackagesStatus(raw);

  expect(status.packages.map(({ id }) => id)).toEqual(SPEECH_PACKAGE_BACKENDS);
  expect(status.packages.every(({ state }) => state === 'unavailable')).toBe(true);
  expect(Object.isFrozen(status)).toBe(true);
  expect(Object.isFrozen(status.packages)).toBe(true);
  expect(Object.isFrozen(status.packages[0])).toBe(true);
});

it('rejects missing, duplicate, contradictory, unbounded, and path-bearing status data', () => {
  const invalid = [];
  const missing = unavailableStatus();
  missing.packages.pop();
  invalid.push(missing);
  const duplicate = unavailableStatus();
  duplicate.packages[1].id = duplicate.packages[0].id;
  invalid.push(duplicate);
  invalid.push({ ...unavailableStatus(), privatePath: 'C:\\Users\\person\\secret' });
  const contradictory = unavailableStatus();
  contradictory.packages[0].installed = true;
  invalid.push(contradictory);
  const unsafe = unavailableStatus();
  unsafe.packages[0].installedBytes = Number.MAX_SAFE_INTEGER + 1;
  invalid.push(unsafe);

  invalid.forEach((value) => {
    expect(() => normalizeSpeechPackagesStatus(value)).toThrow(SpeechPackageServiceError);
  });
});

it('redacts failed-event diagnostics instead of retaining native paths', () => {
  const privatePath = 'C:\\Users\\person\\AppData\\speech-pack';
  const event = normalizeSpeechPackageEvent({
    event: 'failed',
    job: null,
    backend: 'f5-tts',
    action: 'install',
    error: { code: 'packageFailed', message: `could not open ${privatePath}` },
  });

  expect(event.error).toEqual({
    code: 'packageFailed',
    message: 'The native speech package operation failed',
  });
  expect(JSON.stringify(event)).not.toContain(privatePath);
});

it('uses exact native command shapes and rejects hostile backend input before invocation', async () => {
  const initial = jobSnapshot();
  let channel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'speech_packages_status') return unavailableStatus();
    channel = args.onEvent;
    return initial;
  });
  const service = createService({ invokeCommand });

  await service.getSpeechPackagesStatus();
  await service.installSpeechPackage('f5-tts');

  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'speech_packages_status', {});
  expect(invokeCommand).toHaveBeenNthCalledWith(2, 'speech_package_install', {
    backend: 'f5-tts', onEvent: channel,
  });

  await expect(service.installSpeechPackage('C:\\private\\speech-pack'))
    .rejects.toMatchObject({ code: 'invalidSpeechPackageRequest' });
  expect(invokeCommand).toHaveBeenCalledTimes(2);
});

it('redacts rejected native errors without retaining cause or private diagnostics', async () => {
  const privatePath = 'C:\\Users\\person\\private-model.bin';
  const service = createService({
    invokeCommand: vi.fn().mockRejectedValue(new Error(`cannot read ${privatePath}`)),
  });

  const error = await service.getSpeechPackagesStatus().catch((reason) => reason);
  expect(error).toMatchObject({
    code: 'nativeSpeechPackageFailure',
    message: 'The native speech package operation failed',
  });
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain(privatePath);
  expect(String(error)).not.toContain(privatePath);
});

it('fails closed and cancels once for malformed path-bearing channel data', async () => {
  const initial = jobSnapshot();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const onProtocolError = vi.fn();
  let channel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'speech_package_install') {
      channel = args.onEvent;
      return initial;
    }
    return cancelling;
  });
  const service = createService({ invokeCommand });
  await service.installSpeechPackage('f5-tts', { onProtocolError });

  channel.emit({ event: 'progress', privatePath: 'C:\\private\\model.bin' });
  channel.emit({ event: 'progress', privatePath: 'C:\\private\\second.bin' });
  await Promise.resolve();

  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
    .toHaveLength(1);
  expect(String(onProtocolError.mock.calls[0][0])).not.toContain('C:\\private');
});

it('accepts preparing removal progress and rejects cross-action phases', () => {
  const running = jobSnapshot({ progress: { basisPoints: 0 }, sequence: 2 });
  expect(normalizeSpeechPackageEvent({
    event: 'progress',
    operation: operation(running, {
      action: 'remove',
      phase: 'preparing',
      totalBytes: 0,
    }),
  })).toEqual(expect.objectContaining({ event: 'progress' }));

  expect(() => normalizeSpeechPackageEvent({
    event: 'progress',
    operation: operation(running, { action: 'install', phase: 'removing' }),
  })).toThrow(SpeechPackageServiceError);
});
