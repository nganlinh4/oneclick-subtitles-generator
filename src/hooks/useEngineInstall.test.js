import { act, renderHook, waitFor } from '@testing-library/react';
import { v7 as uuidv7 } from 'uuid';
import {
  cancelManagedEnginePackageJob,
  getManagedEnginePackageStatus,
  installManagedEnginePackage,
  removeManagedEnginePackage,
} from '../platform/managedEngineService';
import { useEngineInstall } from './useEngineInstall';

vi.mock('../platform/managedEngineService', () => ({
  cancelManagedEnginePackageJob: vi.fn(),
  getManagedEnginePackageStatus: vi.fn(),
  installManagedEnginePackage: vi.fn(),
  removeManagedEnginePackage: vi.fn(),
}));

const jobSnapshot = (overrides = {}) => ({
  id: uuidv7(),
  kind: 'installEngine',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
  ...overrides,
});

const packageStatus = (activeOperation = null) => ({
  id: 'parakeet',
  label: 'Parakeet',
  deliveryAvailable: true,
  installed: true,
  updateAvailable: false,
  state: 'installed',
  version: '1.0.0',
  availableVersion: '1.0.0',
  installedBytes: 1_024,
  downloadBytes: 2_048,
  availableInstalledBytes: 4_096,
  operation: activeOperation,
});

const activeOperation = (overrides = {}) => {
  const job = jobSnapshot({ progress: { basisPoints: 2_500 }, sequence: 3 });
  return {
    job,
    engine: 'parakeet',
    action: 'install',
    phase: 'downloading',
    basisPoints: 2_500,
    bytesDone: 25,
    totalBytes: 100,
    ...overrides,
  };
};

beforeEach(() => {
  getManagedEnginePackageStatus.mockResolvedValue(packageStatus());
  installManagedEnginePackage.mockResolvedValue(jobSnapshot());
  removeManagedEnginePackage.mockResolvedValue(jobSnapshot());
  cancelManagedEnginePackageJob.mockResolvedValue(jobSnapshot({ state: 'cancelling', sequence: 2 }));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  delete global.fetch;
});

it('does not restart view polling when mount status resolves after unmount', async () => {
  vi.useFakeTimers();
  let resolveStatus;
  getManagedEnginePackageStatus.mockImplementationOnce(() => new Promise((resolve) => {
    resolveStatus = resolve;
  }));
  const { unmount } = renderHook(() => useEngineInstall('parakeet'));
  unmount();

  await act(async () => { resolveStatus(packageStatus(activeOperation())); });
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

  expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(1);
  expect(cancelManagedEnginePackageJob).not.toHaveBeenCalled();
});

it('keeps a native install alive without polling a closed view after registration', async () => {
  vi.useFakeTimers();
  let resolveInstall;
  let signal;
  installManagedEnginePackage.mockImplementationOnce((_id, _handlers, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveInstall = resolve; });
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet', { reconnect: false }));
  let installation;
  act(() => { installation = result.current.install(); });
  unmount();

  await act(async () => {
    resolveInstall(jobSnapshot());
    await installation;
    await vi.advanceTimersByTimeAsync(6_000);
  });

  expect(signal.aborted).toBe(false);
  expect(cancelManagedEnginePackageJob).not.toHaveBeenCalled();
  expect(getManagedEnginePackageStatus).not.toHaveBeenCalled();
});

it('waits for a slow native status read instead of accumulating overlapping polls', async () => {
  vi.useFakeTimers();
  let resolvePoll;
  const slowStatus = new Promise((resolve) => { resolvePoll = resolve; });
  getManagedEnginePackageStatus.mockResolvedValueOnce(packageStatus(activeOperation()));
  getManagedEnginePackageStatus.mockReturnValue(slowStatus);
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });

  expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(2);
  await act(async () => { resolvePoll(packageStatus(activeOperation({ basisPoints: 5_000 }))); });
  expect(result.current.percent).toBe(50);
  unmount();
});

it('does not let a previous engine poll overwrite or stop the current engine observer', async () => {
  vi.useFakeTimers();
  let resolveOldPoll;
  const oldPoll = new Promise((resolve) => { resolveOldPoll = resolve; });
  getManagedEnginePackageStatus
    .mockResolvedValueOnce(packageStatus(activeOperation()))
    .mockReturnValueOnce(oldPoll)
    .mockResolvedValue(packageStatus(activeOperation({ engine: 'f5tts', basisPoints: 7_500 })));
  const { result, rerender, unmount } = renderHook(({ id }) => useEngineInstall(id), {
    initialProps: { id: 'parakeet' },
  });
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  rerender({ id: 'f5tts' });
  await act(async () => {});

  await act(async () => { resolveOldPoll(packageStatus()); });
  expect(result.current.operation?.engine).toBe('f5tts');
  expect(result.current.percent).toBe(75);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  expect(getManagedEnginePackageStatus.mock.calls.filter(([id]) => id === 'f5tts')).toHaveLength(2);
  unmount();
});

it('reconnects to a durable native install and maps basis points to legacy percent', async () => {
  const operation = activeOperation();
  getManagedEnginePackageStatus.mockResolvedValue(packageStatus(operation));
  global.fetch = vi.fn();

  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(result.current.installing).toBe(true));

  expect(result.current.percent).toBe(25);
  expect(result.current.log).toEqual([]);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(1);
  unmount();
});

it('skips redundant package hashing when a parent inventory owns idle status', async () => {
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet', {
    reconnect: false,
  }));
  await act(async () => { await Promise.resolve(); });

  expect(result.current.installing).toBe(false);
  expect(getManagedEnginePackageStatus).not.toHaveBeenCalled();
  unmount();
});

it('keeps native update operations visible as installs and ignores removal for install UI', async () => {
  getManagedEnginePackageStatus.mockResolvedValue(packageStatus(activeOperation({ action: 'update' })));
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(result.current.percent).toBe(25));
  expect(result.current.installing).toBe(true);
  unmount();

  getManagedEnginePackageStatus.mockResolvedValue(packageStatus(activeOperation({
    action: 'remove', phase: 'removing',
  })));
  const view = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(2));
  expect(view.result.current.installing).toBe(false);
  expect(view.result.current.percent).toBe(0);
  view.unmount();
});

it('starts native installation with progress, terminal, and fail-closed handlers', async () => {
  let handlers;
  installManagedEnginePackage.mockImplementation(async (engine, providedHandlers) => {
    handlers = providedHandlers;
    return jobSnapshot();
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalled());

  await act(async () => { await result.current.install(); });
  expect(installManagedEnginePackage).toHaveBeenCalledWith(
    'parakeet',
    expect.objectContaining({
      onProgress: expect.any(Function),
      onCompleted: expect.any(Function),
      onProtocolError: expect.any(Function),
    }),
    { signal: expect.any(AbortSignal) }
  );
  act(() => handlers.onProgress({ operation: activeOperation({ basisPoints: 5_050 }) }));
  expect(result.current.installing).toBe(true);
  expect(result.current.percent).toBe(50.5);

  act(() => handlers.onFailed({ error: { message: 'Package verification failed' } }));
  expect(result.current.installing).toBe(false);
  expect(result.current.error).toBe('Package verification failed');
  unmount();
});

it('does not let a stale mount-time status response overwrite a newly started install', async () => {
  let resolveStatus;
  getManagedEnginePackageStatus.mockImplementationOnce(() => new Promise((resolve) => {
    resolveStatus = resolve;
  }));
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));

  await act(async () => { await result.current.install(); });
  expect(result.current.installing).toBe(true);
  await act(async () => {
    resolveStatus(packageStatus());
    await Promise.resolve();
  });
  expect(result.current.installing).toBe(true);
  unmount();
});

it('cancels a native install through its AbortSignal before job registration', async () => {
  let resolveStart;
  let signal;
  installManagedEnginePackage.mockImplementation((engine, handlers, options) => {
    signal = options.signal;
    return new Promise((resolve) => { resolveStart = resolve; });
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalled());

  let installing;
  act(() => { installing = result.current.install(); });
  await waitFor(() => expect(installManagedEnginePackage).toHaveBeenCalled());
  await act(async () => { await result.current.cancel(); });
  expect(signal.aborted).toBe(true);
  expect(cancelManagedEnginePackageJob).not.toHaveBeenCalled();
  await act(async () => {
    resolveStart(jobSnapshot());
    await installing;
  });
  unmount();
});

it('cancels a reconnected native operation by durable UUIDv7 job ID', async () => {
  const operation = activeOperation();
  getManagedEnginePackageStatus.mockResolvedValue(packageStatus(operation));
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(result.current.installing).toBe(true));

  await act(async () => { await result.current.cancel(); });
  expect(cancelManagedEnginePackageJob).toHaveBeenCalledWith('parakeet', operation.job.id);
  unmount();
});

it('cancels a rendered durable operation before the mount-time status query settles', async () => {
  let resolveStatus;
  getManagedEnginePackageStatus.mockImplementationOnce(() => new Promise((resolve) => {
    resolveStatus = resolve;
  }));
  const recoveredJobId = uuidv7();
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));

  await act(async () => { await result.current.cancel(recoveredJobId); });
  expect(cancelManagedEnginePackageJob).toHaveBeenCalledWith('parakeet', recoveredJobId);
  await act(async () => { resolveStatus(packageStatus()); });
  unmount();
});

it('preserves the speech engine ID across package, runtime, and terminal removal operations', async () => {
  let installHandlers;
  let removalHandlers;
  installManagedEnginePackage.mockImplementation(async (_engine, handlers) => {
    installHandlers = handlers;
    return jobSnapshot();
  });
  removeManagedEnginePackage.mockImplementation(async (_engine, handlers) => {
    removalHandlers = handlers;
    return jobSnapshot();
  });
  const { result, unmount } = renderHook(() => useEngineInstall('f5tts'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalledWith('f5tts'));

  await act(async () => { await result.current.install(); });
  expect(installManagedEnginePackage).toHaveBeenCalledWith(
    'f5tts',
    expect.any(Object),
    { signal: expect.any(AbortSignal) }
  );
  act(() => installHandlers.onCompleted({ event: 'completed' }));
  let removing;
  act(() => { removing = result.current.uninstall(); });
  await waitFor(() => expect(removalHandlers).toBeDefined());
  act(() => removalHandlers.onCompleted({ event: 'completed' }));
  await removing;
  expect(removeManagedEnginePackage).toHaveBeenCalledWith(
    'f5tts',
    expect.objectContaining({ onCompleted: expect.any(Function) })
  );
  unmount();
});

it('keeps native uninstall pending until its durable removal reaches a terminal event', async () => {
  let handlers;
  removeManagedEnginePackage.mockImplementation(async (engine, providedHandlers) => {
    handlers = providedHandlers;
    return jobSnapshot();
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalled());

  let removing;
  act(() => { removing = result.current.uninstall(); });
  await waitFor(() => expect(removeManagedEnginePackage).toHaveBeenCalledWith(
    'parakeet',
    expect.objectContaining({ onCompleted: expect.any(Function) })
  ));
  let settled = false;
  removing.finally(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  await act(async () => {
    handlers.onCompleted({ event: 'completed' });
    await removing;
  });
  expect(settled).toBe(true);
  unmount();
});

it('surfaces native removal failures without inventing log text', async () => {
  let handlers;
  removeManagedEnginePackage.mockImplementation(async (engine, providedHandlers) => {
    handlers = providedHandlers;
    return jobSnapshot();
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalled());

  let removing;
  act(() => { removing = result.current.uninstall(); });
  await waitFor(() => expect(handlers).toBeDefined());
  await act(async () => {
    handlers.onFailed({ error: { message: 'Removal failed safely' } });
    await expect(removing).rejects.toThrow('Removal failed safely');
  });
  expect(result.current.error).toBe('Removal failed safely');
  expect(result.current.log).toEqual([]);
  unmount();
});

it('fails closed when native package status is unavailable without probing HTTP', async () => {
  getManagedEnginePackageStatus.mockRejectedValue(new Error('This operation requires the desktop runtime'));
  global.fetch = vi.fn();
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(1));

  expect(result.current.installing).toBe(false);
  expect(result.current.percent).toBe(0);
  expect(global.fetch).not.toHaveBeenCalled();
  unmount();
});

it('routes every engine mutation through typed native services only', async () => {
  global.fetch = vi.fn();
  let removalHandlers;
  removeManagedEnginePackage.mockImplementation(async (_engine, handlers) => {
    removalHandlers = handlers;
    return jobSnapshot();
  });
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(1));

  await act(async () => { await result.current.install(); });
  await act(async () => { await result.current.cancel(); });
  let removing;
  act(() => { removing = result.current.uninstall(); });
  await waitFor(() => expect(removalHandlers).toBeDefined());
  await act(async () => {
    removalHandlers.onCompleted({ event: 'completed' });
    await removing;
  });

  expect(installManagedEnginePackage).toHaveBeenCalled();
  expect(removeManagedEnginePackage).toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  unmount();
});

it('surfaces native-boundary failures without falling back to HTTP', async () => {
  global.fetch = vi.fn();
  installManagedEnginePackage.mockRejectedValueOnce(
    new Error('This operation requires the desktop runtime')
  );
  const { result, unmount } = renderHook(() => useEngineInstall('parakeet'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalledTimes(1));

  await act(async () => { await result.current.install(); });
  expect(result.current.installing).toBe(false);
  expect(result.current.error).toBe('This operation requires the desktop runtime');
  expect(installManagedEnginePackage).toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  unmount();
});

it('never contacts localhost in Tauri even for engines unavailable to package delivery', async () => {
  global.fetch = vi.fn();
  const { result, unmount } = renderHook(() => useEngineInstall('chatterbox'));
  await waitFor(() => expect(getManagedEnginePackageStatus).toHaveBeenCalled());
  installManagedEnginePackage.mockRejectedValueOnce(new Error('Engine package is unavailable'));

  await act(async () => { await result.current.install(); });
  expect(result.current.error).toBe('Engine package is unavailable');
  expect(global.fetch).not.toHaveBeenCalled();
  unmount();
});
