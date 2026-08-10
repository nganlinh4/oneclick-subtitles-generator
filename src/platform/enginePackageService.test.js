import fs from 'fs';
import path from 'path';
import { v7 as uuidv7 } from 'uuid';
import {
  ENGINE_PACKAGE_ENGINE_IDS,
  EnginePackageServiceError,
  createNativeEnginePackageService,
  normalizeEnginePackageEvent,
  normalizeEnginePackageJob,
  normalizeEnginePackagesStatus,
} from './enginePackageService';

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
  engine: 'parakeet',
  action: 'install',
  phase: 'downloading',
  basisPoints: job.progress.basisPoints,
  bytesDone: 0,
  totalBytes: 100,
  ...overrides,
});

const statusPayload = () => ({
  schemaVersion: 1,
  engines: ENGINE_PACKAGE_ENGINE_IDS.map((id, index) => ({
    id,
    label: `Engine ${index + 1}`,
    deliveryAvailable: true,
    installed: index === 0,
    updateAvailable: index === 0,
    state: index === 0 ? 'update-available' : 'missing',
    version: index === 0 ? '1.0.0' : null,
    availableVersion: '1.1.0',
    installedBytes: index === 0 ? 1_024 : 0,
    operation: null,
  })),
});

const createService = (overrides = {}) => createNativeEnginePackageService({
  invokeCommand: vi.fn(),
  ChannelConstructor: TestChannel,
  isNativeRuntime: () => true,
  ...overrides,
});

it('contains no HTTP, browser storage, URL, path, file, or byte-buffer transport', () => {
  const source = fs.readFileSync(path.join(__dirname, 'enginePackageService.js'), 'utf8');
  expect(source).not.toMatch(/\bfetch\s*\(/);
  expect(source).not.toMatch(/localStorage\s*\./);
  expect(source).not.toMatch(/https?:\/\//i);
  expect(source).not.toMatch(/\b(path|url|file|base64|buffer)\s*:/i);
});

it('strictly validates, freezes, and canonically orders all five package entries', () => {
  const raw = statusPayload();
  raw.engines.reverse();
  const status = normalizeEnginePackagesStatus(raw);

  expect(status.engines.map(({ id }) => id)).toEqual(ENGINE_PACKAGE_ENGINE_IDS);
  expect(Object.isFrozen(status)).toBe(true);
  expect(Object.isFrozen(status.engines[0])).toBe(true);
  expect(status.engines[0]).toEqual(expect.objectContaining({
    id: 'parakeet',
    installed: true,
    updateAvailable: true,
    state: 'update-available',
  }));
});

it('rejects missing, duplicate, extra, contradictory, unbounded, and unsafe status data', () => {
  const invalidStatuses = [];
  const missing = statusPayload();
  missing.engines.pop();
  invalidStatuses.push(missing);
  const duplicate = statusPayload();
  duplicate.engines[1].id = duplicate.engines[0].id;
  invalidStatuses.push(duplicate);
  invalidStatuses.push({ ...statusPayload(), privatePath: 'hidden' });
  const contradictory = statusPayload();
  contradictory.engines[1].installed = true;
  invalidStatuses.push(contradictory);
  const unsafeInteger = statusPayload();
  unsafeInteger.engines[0].installedBytes = Number.MAX_SAFE_INTEGER + 1;
  invalidStatuses.push(unsafeInteger);
  const unsafeLabel = statusPayload();
  unsafeLabel.engines[0].label = 'engine\nsecret';
  invalidStatuses.push(unsafeLabel);

  invalidStatuses.forEach((value) => {
    expect(() => normalizeEnginePackagesStatus(value)).toThrow(EnginePackageServiceError);
  });
});

it('validates active operations in status without copying unknown diagnostics', () => {
  const raw = statusPayload();
  const job = jobSnapshot({ progress: { basisPoints: 2_500 }, sequence: 3 });
  raw.engines[0].operation = operation(job, {
    action: 'update',
    basisPoints: 2_500,
    bytesDone: 25,
  });
  const status = normalizeEnginePackagesStatus(raw);
  expect(status.engines[0].operation).toEqual(expect.objectContaining({
    engine: 'parakeet',
    action: 'update',
    basisPoints: 2_500,
  }));

  raw.engines[0].operation.privatePath = 'hidden';
  expect(() => normalizeEnginePackagesStatus(raw)).toThrow(EnginePackageServiceError);
});

it('accepts the backend preparing phase while retaining queued as a bounded envelope state', () => {
  const raw = statusPayload();
  const preparingJob = jobSnapshot({ progress: { basisPoints: 0 }, sequence: 2 });
  raw.engines[0].operation = operation(preparingJob, { phase: 'preparing' });
  expect(normalizeEnginePackagesStatus(raw).engines[0].operation.phase).toBe('preparing');

  const queuedJob = jobSnapshot({
    state: 'queued',
    progress: { basisPoints: 0 },
    sequence: 0,
  });
  raw.engines[0].operation = operation(queuedJob, { phase: 'queued' });
  expect(normalizeEnginePackagesStatus(raw).engines[0].operation.phase).toBe('queued');

  raw.engines[0].operation = operation(preparingJob, { phase: 'resolving-url' });
  expect(() => normalizeEnginePackagesStatus(raw)).toThrow(EnginePackageServiceError);
});

it('normalizes strict progress and terminal events', () => {
  const id = uuidv7();
  const running = jobSnapshot({ id, progress: { basisPoints: 500 }, sequence: 2 });
  expect(normalizeEnginePackageEvent({
    event: 'progress',
    operation: operation(running, { basisPoints: 500, bytesDone: 5 }),
  })).toEqual(expect.objectContaining({
    event: 'progress',
    operation: expect.objectContaining({ basisPoints: 500 }),
  }));

  expect(normalizeEnginePackageEvent({
    event: 'completed',
    job: jobSnapshot({
      id,
      state: 'succeeded',
      progress: { basisPoints: 10_000 },
      sequence: 3,
    }),
    engine: 'parakeet',
    action: 'install',
  })).toEqual(expect.objectContaining({ event: 'completed' }));
  expect(normalizeEnginePackageEvent({
    event: 'cancelled',
    job: jobSnapshot({ id, state: 'cancelled', sequence: 3 }),
    engine: 'parakeet',
    action: 'install',
  })).toEqual(expect.objectContaining({ event: 'cancelled' }));
  expect(normalizeEnginePackageEvent({
    event: 'failed',
    job: null,
    engine: 'parakeet',
    action: 'install',
    error: { code: 'packageUnavailable', message: 'Package is unavailable' },
  })).toEqual(expect.objectContaining({
    event: 'failed',
    error: { code: 'packageUnavailable', message: 'Package is unavailable' },
  }));
});

it('rejects malformed jobs, operations, event extras, and invalid terminal invariants', () => {
  const id = uuidv7();
  expect(() => normalizeEnginePackageJob(jobSnapshot({ kind: 'transcribe' })))
    .toThrow(EnginePackageServiceError);
  expect(() => normalizeEnginePackageJob(jobSnapshot({ sequence: -1 })))
    .toThrow(EnginePackageServiceError);
  expect(() => normalizeEnginePackageEvent({
    event: 'progress',
    operation: operation(jobSnapshot({ id }), { bytesDone: 101 }),
  })).toThrow(EnginePackageServiceError);
  expect(() => normalizeEnginePackageEvent({
    event: 'completed',
    job: jobSnapshot({ id }),
    engine: 'parakeet',
    action: 'install',
  })).toThrow(EnginePackageServiceError);
  expect(() => normalizeEnginePackageEvent({
    event: 'failed',
    job: null,
    engine: 'parakeet',
    action: 'install',
    error: { code: 'invalid', message: 'bad', diagnostics: 'hidden' },
  })).toThrow(EnginePackageServiceError);
});

it('invokes exact status/install/remove/runtime command shapes and accepts update events', async () => {
  const initial = jobSnapshot();
  let installChannel;
  let removeChannel;
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'engine_packages_status') return statusPayload();
    if (command === 'engine_package_install') {
      installChannel = args.onEvent;
      return initial;
    }
    if (command === 'engine_package_remove') {
      removeChannel = args.onEvent;
      return jobSnapshot();
    }
    return null;
  });
  const onProgress = vi.fn();
  const service = createService({ invokeCommand });

  await service.getEnginePackagesStatus();
  await service.installEnginePackage('nvidia-parakeet', { onProgress });
  installChannel.emit({
    event: 'progress',
    operation: operation(jobSnapshot({
      id: initial.id,
      progress: { basisPoints: 100 },
      sequence: 2,
    }), { action: 'update', basisPoints: 100, bytesDone: 1 }),
  });
  await service.removeEnginePackage('parakeet');
  await service.startEngineRuntime('parakeet');
  await service.stopEngineRuntime('parakeet');

  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'engine_packages_status', {});
  expect(invokeCommand).toHaveBeenNthCalledWith(2, 'engine_package_install', {
    engine: 'parakeet', onEvent: installChannel,
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(3, 'engine_package_remove', {
    engine: 'parakeet', onEvent: removeChannel,
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(4, 'engine_runtime_start', {
    engine: 'parakeet',
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(5, 'engine_runtime_stop', {
    engine: 'parakeet',
  });
  expect(onProgress).toHaveBeenCalledTimes(1);
});

it('buffers early events until the initial snapshot is registered', async () => {
  const initial = jobSnapshot();
  let resolveStart;
  const onProgress = vi.fn();
  const invokeCommand = vi.fn((command, args) => {
    args.onEvent.emit({
      event: 'progress',
      operation: operation(jobSnapshot({
        id: initial.id,
        progress: { basisPoints: 100 },
        sequence: 2,
      }), { basisPoints: 100, bytesDone: 1 }),
    });
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const service = createService({ invokeCommand });

  const started = service.installEnginePackage('parakeet', { onProgress });
  expect(onProgress).not.toHaveBeenCalled();
  resolveStart(initial);
  await started;
  expect(onProgress).toHaveBeenCalledTimes(1);
});

it('fails closed and cancels once on mismatched, regressive, or malformed channel data', async () => {
  const initial = jobSnapshot();
  let channel;
  const onProtocolError = vi.fn();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'engine_package_install') {
      channel = args.onEvent;
      return initial;
    }
    return cancelling;
  });
  const service = createService({ invokeCommand });
  await service.installEnginePackage('parakeet', { onProtocolError });

  channel.emit({
    event: 'progress',
    operation: operation(jobSnapshot({
      id: uuidv7(),
      progress: { basisPoints: 100 },
      sequence: 2,
    }), { basisPoints: 100, bytesDone: 1 }),
  });
  channel.emit({ event: 'progress', privatePath: 'hidden' });
  await Promise.resolve();

  expect(onProtocolError).toHaveBeenCalledTimes(1);
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'job_cancel'))
    .toHaveLength(1);
});

it('defers AbortSignal cancellation until registration and never starts when already aborted', async () => {
  const initial = jobSnapshot();
  const cancelling = jobSnapshot({ id: initial.id, state: 'cancelling', sequence: 2 });
  const controller = new AbortController();
  let resolveStart;
  const invokeCommand = vi.fn((command) => {
    if (command === 'engine_package_install') {
      return new Promise((resolve) => { resolveStart = resolve; });
    }
    return Promise.resolve(cancelling);
  });
  const service = createService({ invokeCommand });

  const started = service.installEnginePackage('parakeet', undefined, {
    signal: controller.signal,
  });
  controller.abort();
  expect(invokeCommand).toHaveBeenCalledTimes(1);
  resolveStart(initial);
  await started;
  await Promise.resolve();
  expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: initial.id });

  const aborted = new AbortController();
  aborted.abort();
  await expect(service.installEnginePackage('parakeet', undefined, {
    signal: aborted.signal,
  })).rejects.toMatchObject({ code: 'enginePackageCancelled' });
  expect(invokeCommand.mock.calls.filter(([command]) => command === 'engine_package_install'))
    .toHaveLength(1);
});

it('isolates handler failures and reports cancellation errors', async () => {
  const initial = jobSnapshot();
  let channel;
  const controller = new AbortController();
  const onHandlerError = vi.fn();
  const onCancellationError = vi.fn();
  const service = createService({
    invokeCommand: vi.fn(async (command, args) => {
      if (command === 'engine_package_install') {
        channel = args.onEvent;
        return initial;
      }
      throw new Error('cancel unavailable');
    }),
  });
  await service.installEnginePackage('parakeet', {
    onProgress: () => Promise.reject(new Error('handler failed')),
    onHandlerError,
    onCancellationError,
  }, { signal: controller.signal });
  channel.emit({
    event: 'progress',
    operation: operation(jobSnapshot({
      id: initial.id,
      progress: { basisPoints: 100 },
      sequence: 2,
    }), { basisPoints: 100, bytesDone: 1 }),
  });
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onHandlerError).toHaveBeenCalledTimes(1);
  expect(onCancellationError).toHaveBeenCalledWith(expect.any(Error));
});

it('validates cancellation IDs and rejects mismatched native snapshots', async () => {
  const id = uuidv7();
  const invokeCommand = vi.fn().mockResolvedValue(
    jobSnapshot({ id, state: 'cancelling', sequence: 2 })
  );
  const service = createService({ invokeCommand });
  await expect(service.cancelEnginePackageJob(id)).resolves.toEqual(expect.objectContaining({ id }));
  expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id });
  await expect(service.cancelEnginePackageJob('not-v7'))
    .rejects.toMatchObject({ code: 'invalidEnginePackageRequest' });

  invokeCommand.mockResolvedValue(jobSnapshot({ state: 'cancelling', sequence: 2 }));
  await expect(service.cancelEnginePackageJob(id))
    .rejects.toMatchObject({ code: 'invalidEnginePackageResponse' });
});

it('rejects unknown engines and invalid handler/option shapes before invoking native code', async () => {
  const invokeCommand = vi.fn();
  const service = createService({ invokeCommand });
  await expect(service.installEnginePackage('chatterbox'))
    .rejects.toMatchObject({ code: 'invalidEnginePackageRequest' });
  await expect(service.installEnginePackage('parakeet', { unknown: vi.fn() }))
    .rejects.toMatchObject({ code: 'invalidEnginePackageRequest' });
  await expect(service.installEnginePackage('parakeet', undefined, { unknown: true }))
    .rejects.toMatchObject({ code: 'invalidEnginePackageRequest' });
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('fails closed outside Tauri for every operation', async () => {
  const invokeCommand = vi.fn();
  const service = createNativeEnginePackageService({
    invokeCommand,
    ChannelConstructor: TestChannel,
    isNativeRuntime: () => false,
  });
  await expect(service.getEnginePackagesStatus())
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  await expect(service.installEnginePackage('parakeet'))
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  await expect(service.removeEnginePackage('parakeet'))
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  await expect(service.startEngineRuntime('parakeet'))
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  await expect(service.stopEngineRuntime('parakeet'))
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  await expect(service.cancelEnginePackageJob(uuidv7()))
    .rejects.toMatchObject({ code: 'desktopEnginePackagesRequired' });
  expect(invokeCommand).not.toHaveBeenCalled();
});
