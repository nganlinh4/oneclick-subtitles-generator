import {
  getCachedDesktopUpdateStatus,
  offerDesktopUpdate,
  refreshDesktopUpdateCheck,
  resetStartupUpdateCheckForTests,
  startStartupUpdateCheck,
  subscribeDesktopUpdateStatus,
} from './startupUpdateCoordinator';

beforeEach(() => resetStartupUpdateCheckForTests());

test('checks once per startup and offers only a configured newer signed release', async () => {
  const status = {
    configured: true,
    currentVersion: '1.0.0',
    update: { version: '1.0.1', publishedAt: null, notes: null },
  };
  const check = vi.fn().mockResolvedValue(status);
  const offer = vi.fn();
  const options = { nativeRuntime: () => true, check, offer };
  await Promise.all([
    startStartupUpdateCheck(options),
    startStartupUpdateCheck(options),
  ]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(offer).toHaveBeenCalledWith(status.update);
  expect(getCachedDesktopUpdateStatus()).toBe(status);
});

test('an explicit refresh replaces the shared result without parallel stale checks', async () => {
  const firstStatus = {
    configured: true,
    currentVersion: '1.0.0',
    update: null,
  };
  const secondStatus = {
    configured: true,
    currentVersion: '1.0.0',
    update: { version: '1.0.1', publishedAt: null, notes: null },
  };
  const check = vi.fn()
    .mockResolvedValueOnce(firstStatus)
    .mockResolvedValueOnce(secondStatus);
  const offer = vi.fn();
  const options = { nativeRuntime: () => true, check, offer };

  await startStartupUpdateCheck(options);
  await startStartupUpdateCheck(options);
  expect(check).toHaveBeenCalledTimes(1);
  expect(getCachedDesktopUpdateStatus()).toBe(firstStatus);

  await refreshDesktopUpdateCheck(options);
  expect(check).toHaveBeenCalledTimes(2);
  expect(getCachedDesktopUpdateStatus()).toBe(secondStatus);
  expect(offer).toHaveBeenCalledTimes(1);
  expect(offer).toHaveBeenCalledWith(secondStatus.update);
});

test('a refresh requested during the startup check joins that check', async () => {
  let resolveCheck;
  const status = {
    configured: true,
    currentVersion: '1.0.0',
    update: null,
  };
  const check = vi.fn(() => new Promise((resolve) => {
    resolveCheck = resolve;
  }));
  const options = { nativeRuntime: () => true, check, offer: vi.fn() };
  const startup = startStartupUpdateCheck(options);
  const refresh = refreshDesktopUpdateCheck(options);
  expect(check).toHaveBeenCalledTimes(1);
  resolveCheck(status);
  await expect(Promise.all([startup, refresh])).resolves.toEqual([status, status]);
});

test('all update surfaces observe the same refresh and listener failures stay isolated', async () => {
  const statuses = [];
  const firstStatus = { configured: true, currentVersion: '1.0.0', update: null };
  const secondStatus = {
    configured: true,
    currentVersion: '1.0.0',
    update: { version: '1.0.1', publishedAt: null, notes: null },
  };
  const check = vi.fn()
    .mockResolvedValueOnce(firstStatus)
    .mockResolvedValueOnce(secondStatus);
  const unsubscribeBroken = subscribeDesktopUpdateStatus(() => {
    throw new Error('detached component');
  });
  const unsubscribe = subscribeDesktopUpdateStatus((status) => statuses.push(status));
  const options = { nativeRuntime: () => true, check, offer: vi.fn() };

  await startStartupUpdateCheck(options);
  const lateStatuses = [];
  const unsubscribeLate = subscribeDesktopUpdateStatus((status) => lateStatuses.push(status));
  expect(lateStatuses).toEqual([firstStatus]);
  await refreshDesktopUpdateCheck(options);
  expect(statuses).toEqual([firstStatus, secondStatus]);
  expect(lateStatuses).toEqual([firstStatus, secondStatus]);
  unsubscribe();
  unsubscribeLate();
  unsubscribeBroken();
});

test('startup update failures stay silent and browser mode never checks GitHub', async () => {
  const check = vi.fn().mockRejectedValue(new Error('private transport details'));
  await expect(startStartupUpdateCheck({
    nativeRuntime: () => true,
    check,
    offer: vi.fn(),
  })).resolves.toBeNull();
  resetStartupUpdateCheckForTests();
  await expect(startStartupUpdateCheck({
    nativeRuntime: () => false,
    check,
  })).resolves.toBeNull();
  expect(check).toHaveBeenCalledTimes(1);
});

test('a missing or broken toast surface cannot discard a valid signed status', async () => {
  const status = {
    configured: true,
    currentVersion: '1.0.0',
    update: { version: '1.0.1', publishedAt: null, notes: null },
  };
  await expect(startStartupUpdateCheck({
    nativeRuntime: () => true,
    check: vi.fn().mockResolvedValue(status),
    offer: vi.fn(() => { throw new Error('toast unavailable'); }),
  })).resolves.toBe(status);
  expect(getCachedDesktopUpdateStatus()).toBe(status);
});

test('the explicit toast action streams progress and offers cancellation', async () => {
  const toasts = [];
  const install = vi.fn().mockResolvedValue(undefined);
  const t = (key, fallback, values) => values?.version
    ? `${fallback}:${values.version}`
    : values?.percent !== undefined
      ? `${fallback}:${values.percent}`
      : fallback;
  offerDesktopUpdate({ version: '1.0.1' }, {
    t,
    install,
    showToast: (...args) => toasts.push(args),
  });
  expect(toasts[0][3]).toBe('app-update-available');
  toasts[0][4].onClick();
  expect(install).toHaveBeenCalledTimes(1);
  const [version, handlers, options] = install.mock.calls[0];
  expect(version).toBe('1.0.1');
  handlers.onProgress({ basisPoints: 4760 });
  expect(toasts.at(-1)).toEqual(expect.arrayContaining([
    expect.stringContaining('47'), 'info', expect.any(Number), 'app-update-install',
  ]));
  const cancelButton = toasts.at(-1)[4];
  cancelButton.onClick();
  expect(options.signal.aborted).toBe(true);
});
