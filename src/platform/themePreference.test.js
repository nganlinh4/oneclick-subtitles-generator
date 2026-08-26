import {
  applySystemThemeIfUnpinned,
  commitThemePreference,
  initializeEffectiveTheme,
  subscribeToEffectiveSystemTheme,
} from './themePreference';

const createRoot = () => ({ setAttribute: vi.fn() });
const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
};

it('paints a system fallback without creating a browser or native preference', () => {
  const root = createRoot();
  const storage = createStorage();
  const invokeCommand = vi.fn();

  expect(initializeEffectiveTheme({ resolveTheme: () => 'dark', root })).toBe('dark');

  expect(root.setAttribute).toHaveBeenCalledExactlyOnceWith('data-theme', 'dark');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(invokeCommand).not.toHaveBeenCalled();
});

it('follows system changes only while the preference is absent', () => {
  const root = createRoot();
  const unpinned = createStorage();
  const pinned = createStorage({ theme: 'light' });

  expect(applySystemThemeIfUnpinned('dark', { storage: unpinned, root })).toBe('dark');
  expect(applySystemThemeIfUnpinned('dark', { storage: pinned, root })).toBeNull();
  expect(unpinned.setItem).not.toHaveBeenCalled();
  expect(pinned.setItem).not.toHaveBeenCalled();
  expect(root.setAttribute).toHaveBeenCalledTimes(1);
});

it('a system-theme subscription never persists its effective fallback', () => {
  const root = createRoot();
  const storage = createStorage();
  const onTheme = vi.fn();
  let listener;
  const cleanup = vi.fn();

  expect(subscribeToEffectiveSystemTheme(onTheme, {
    storage,
    root,
    listen: vi.fn((callback) => {
      listener = callback;
      return cleanup;
    }),
  })).toBe(cleanup);
  listener('dark');

  expect(onTheme).toHaveBeenCalledExactlyOnceWith('dark');
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(root.setAttribute).toHaveBeenCalledExactlyOnceWith('data-theme', 'dark');
});

it('commits explicit intent natively before publishing any WebView mirror', async () => {
  const order = [];
  const storage = { setItem: vi.fn(() => order.push('storage')) };
  const root = { setAttribute: vi.fn(() => order.push('dom')) };
  const publish = vi.fn(() => order.push('event'));
  let releaseNative;
  const invokeCommand = vi.fn(() => new Promise((resolve) => {
    releaseNative = () => {
      order.push('native');
      resolve();
    };
  }));

  const pending = commitThemePreference('light', {
    invokeCommand, storage, root, publish,
  });
  await Promise.resolve();
  expect(order).toEqual([]);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(root.setAttribute).not.toHaveBeenCalled();
  releaseNative();
  await expect(pending).resolves.toBe('light');

  expect(invokeCommand).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'theme', value: 'light',
  });
  expect(order).toEqual(['native', 'storage', 'dom', 'event']);
});

it('a rejected native write leaves every WebView mirror untouched', async () => {
  const storage = createStorage();
  const root = createRoot();
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();
  const failure = new Error('native write rejected');

  await expect(commitThemePreference('dark', {
    invokeCommand: vi.fn().mockRejectedValue(failure),
    storage,
    root,
    publish,
    onProjectionWarning,
  })).rejects.toBe(failure);

  expect(storage.setItem).not.toHaveBeenCalled();
  expect(root.setAttribute).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(onProjectionWarning).not.toHaveBeenCalled();
});

it('still paints and publishes a durable theme when browser storage throws', async () => {
  const storage = { setItem: vi.fn(() => { throw new Error('storage denied'); }) };
  const root = createRoot();
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();

  await expect(commitThemePreference('light', {
    invokeCommand: vi.fn().mockResolvedValue(undefined),
    storage,
    root,
    publish,
    onProjectionWarning,
  })).resolves.toBe('light');

  expect(root.setAttribute).toHaveBeenCalledExactlyOnceWith('data-theme', 'light');
  expect(publish).toHaveBeenCalledExactlyOnceWith('light');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'light',
    failedProjections: ['browserMirror'],
  });
});

it('still publishes a durable theme when its immediate DOM projection throws', async () => {
  const storage = createStorage();
  const root = { setAttribute: vi.fn(() => { throw new Error('DOM refused'); }) };
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();

  await expect(commitThemePreference('dark', {
    invokeCommand: vi.fn().mockResolvedValue(undefined),
    storage,
    root,
    publish,
    onProjectionWarning,
  })).resolves.toBe('dark');

  expect(storage.getItem('theme')).toBe('dark');
  expect(publish).toHaveBeenCalledExactlyOnceWith('dark');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'dark',
    failedProjections: ['effectiveUi'],
  });
});

it('contains a theme publication throw after storage and DOM already reconciled', async () => {
  const storage = createStorage();
  const root = createRoot();
  const publish = vi.fn(() => { throw new Error('storage event refused'); });
  const onProjectionWarning = vi.fn();

  await expect(commitThemePreference('light', {
    invokeCommand: vi.fn().mockResolvedValue(undefined),
    storage,
    root,
    publish,
    onProjectionWarning,
  })).resolves.toBe('light');

  expect(storage.getItem('theme')).toBe('light');
  expect(root.setAttribute).toHaveBeenCalledExactlyOnceWith('data-theme', 'light');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'light',
    failedProjections: ['publication'],
  });
});
