import {
  offerDesktopUpdate,
  resetStartupUpdateCheckForTests,
  startStartupUpdateCheck,
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
