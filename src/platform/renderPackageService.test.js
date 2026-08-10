import {
  createRenderPackageService,
  normalizeRenderPackageStatus,
} from './renderPackageService';

const JOB_ID = '01915f6e-7b7c-7f37-b0e8-09d873ebc123';
const snapshot = (state, basisPoints, sequence) => ({
  id: JOB_ID,
  kind: 'installEngine',
  state,
  progress: { basisPoints },
  sequence,
});
const status = (overrides = {}) => ({
  schemaVersion: 1,
  id: 'remotion-runtime',
  label: 'Remotion video renderer',
  deliveryAvailable: true,
  installed: false,
  updateAvailable: false,
  state: 'missing',
  version: null,
  availableVersion: '4.0.507',
  installedBytes: 0,
  downloadBytes: 265_442_457,
  availableInstalledBytes: 624_910_330,
  operation: null,
  ...overrides,
});

class FakeChannel {
  onmessage = null;
}

it('accepts the exact path-free renderer package status', () => {
  expect(normalizeRenderPackageStatus(status())).toEqual(status());
  expect(() => normalizeRenderPackageStatus({ ...status(), packagePath: 'C:\\private' }))
    .toThrow(/invalid render package data/i);
});

it('streams monotonic install progress and a terminal completion', async () => {
  const onProgress = vi.fn();
  const onCompleted = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    expect(command).toBe('render_package_install');
    queueMicrotask(() => {
      args.onEvent.onmessage({
        event: 'progress',
        operation: {
          job: snapshot('running', 2_500, 1),
          package: 'remotion-runtime',
          action: 'install',
          phase: 'downloading',
          basisPoints: 2_500,
          bytesDone: 66_360_614,
          totalBytes: 265_442_457,
        },
      });
      args.onEvent.onmessage({
        event: 'completed',
        job: snapshot('succeeded', 10_000, 2),
        package: 'remotion-runtime',
        action: 'install',
      });
    });
    return snapshot('queued', 0, 0);
  });
  const service = createRenderPackageService({
    invokeCommand, ChannelConstructor: FakeChannel, isNativeRuntime: () => true,
  });
  await service.installRenderPackage({ onProgress, onCompleted });
  await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledOnce());
  expect(onProgress).toHaveBeenCalledOnce();
});

it('fails closed and cancels when progress regresses', async () => {
  const onProtocolError = vi.fn();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'job_cancel') return undefined;
    queueMicrotask(() => {
      for (const [basisPoints, sequence] of [[4_000, 1], [3_000, 2]]) {
        args.onEvent.onmessage({
          event: 'progress',
          operation: {
            job: snapshot('running', basisPoints, sequence),
            package: 'remotion-runtime',
            action: 'install',
            phase: 'downloading',
            basisPoints,
            bytesDone: basisPoints,
            totalBytes: 10_000,
          },
        });
      }
    });
    return snapshot('queued', 0, 0);
  });
  const service = createRenderPackageService({
    invokeCommand, ChannelConstructor: FakeChannel, isNativeRuntime: () => true,
  });
  await service.installRenderPackage({ onProtocolError });
  await vi.waitFor(() => expect(onProtocolError).toHaveBeenCalledOnce());
  expect(invokeCommand).toHaveBeenCalledWith('job_cancel', { id: JOB_ID });
});

it('uses the dedicated removal command and generic cancellation command', async () => {
  const invokeCommand = vi.fn(async (command) => {
    if (command === 'render_package_remove') return snapshot('queued', 0, 0);
    return undefined;
  });
  const service = createRenderPackageService({
    invokeCommand, ChannelConstructor: FakeChannel, isNativeRuntime: () => true,
  });
  await service.removeRenderPackage();
  await service.cancelRenderPackageJob(JOB_ID);
  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'render_package_remove', {
    onEvent: expect.any(FakeChannel),
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(2, 'job_cancel', { id: JOB_ID });
});
