import {
  APP_FONT_PREFERENCE,
  PREFERRED_LANGUAGE_PREFERENCE,
  initializeEffectiveAppFont,
  createEnumeratedUiPreference,
} from './nativeUiPreferences';

const createStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
  };
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

it('reads a missing or hostile mirror without turning the fallback into user intent', () => {
  const missing = createStorage();
  const hostile = createStorage({ app_font: 'not-a-font' });

  expect(APP_FONT_PREFERENCE.readMirror('google-sans', { storage: missing }))
    .toBe('google-sans');
  expect(APP_FONT_PREFERENCE.readMirror('google-sans', { storage: hostile }))
    .toBe('google-sans');
  expect(missing.setItem).not.toHaveBeenCalled();
  expect(hostile.setItem).not.toHaveBeenCalled();
});

it('paints a returning-user font at startup without mounting settings or persisting a fallback', () => {
  const root = { style: { setProperty: vi.fn() } };
  const returning = createStorage({ app_font: 'system-ui' });

  expect(initializeEffectiveAppFont({ storage: returning, root })).toBe('system-ui');
  expect(root.style.setProperty.mock.calls).toEqual([
    ['--font-primary', 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif'],
    ['--font-title', 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif'],
  ]);
  expect(returning.setItem).not.toHaveBeenCalled();

  root.style.setProperty.mockClear();
  const firstLaunch = createStorage();
  expect(initializeEffectiveAppFont({ storage: firstLaunch, root })).toBe('google-sans');
  expect(root.style.setProperty).toHaveBeenCalledTimes(2);
  expect(firstLaunch.setItem).not.toHaveBeenCalled();
});

it('commits native authority before the mirror and UI callback', async () => {
  const order = [];
  const storage = createStorage();
  storage.setItem.mockImplementation(() => order.push('mirror'));
  let releaseNative;
  const invokeCommand = vi.fn(() => new Promise((resolve) => {
    releaseNative = () => {
      order.push('native');
      resolve();
    };
  }));
  const apply = vi.fn(() => order.push('ui'));

  const pending = APP_FONT_PREFERENCE.commit('system-ui', {
    invokeCommand, storage, apply,
  });
  await Promise.resolve();
  expect(order).toEqual([]);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();

  releaseNative();
  await expect(pending).resolves.toBe('system-ui');
  expect(invokeCommand).toHaveBeenCalledExactlyOnceWith('setting_set', {
    key: 'app_font', value: 'system-ui',
  });
  expect(order).toEqual(['native', 'mirror', 'ui']);
});

it('a rejected or invalid native choice leaves every mirror and UI callback untouched', async () => {
  const storage = createStorage({ preferred_language: 'en' });
  const apply = vi.fn();
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();
  const failure = new Error('native refusal');
  const rejectedInvoke = vi.fn().mockRejectedValue(failure);

  await expect(PREFERRED_LANGUAGE_PREFERENCE.commit('ko', {
    invokeCommand: rejectedInvoke, storage, apply, publish, onProjectionWarning,
  })).rejects.toBe(failure);
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(apply).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  expect(onProjectionWarning).not.toHaveBeenCalled();

  const invalidInvoke = vi.fn();
  await expect(PREFERRED_LANGUAGE_PREFERENCE.commit('../ko', {
    invokeCommand: invalidInvoke, storage, apply,
  })).rejects.toThrow(/Unsupported preferred_language preference/);
  expect(invalidInvoke).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  expect(() => createEnumeratedUiPreference({ key: 'bad key', values: ['x'] }))
    .toThrow(/bounded native preference key/);
});

it('keeps applying after browser mirror storage throws following deferred native success', async () => {
  const native = deferred();
  const storage = { setItem: vi.fn(() => { throw new Error('storage denied'); }) };
  const apply = vi.fn();
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();

  const pending = APP_FONT_PREFERENCE.commit('system-ui', {
    invokeCommand: vi.fn(() => native.promise),
    storage,
    apply,
    publish,
    onProjectionWarning,
  });
  await Promise.resolve();
  expect(storage.setItem).not.toHaveBeenCalled();

  native.resolve();
  await expect(pending).resolves.toBe('system-ui');
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith('app_font', 'system-ui');
  expect(apply).toHaveBeenCalledExactlyOnceWith('system-ui');
  expect(publish).toHaveBeenCalledExactlyOnceWith('system-ui');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'system-ui',
    failedProjections: ['browserMirror'],
  });
});

it('waits for a rejected UI projection, then still publishes durable language authority', async () => {
  const applyResult = deferred();
  const storage = createStorage();
  const publish = vi.fn();
  const onProjectionWarning = vi.fn();

  const pending = PREFERRED_LANGUAGE_PREFERENCE.commit('ko', {
    invokeCommand: vi.fn().mockResolvedValue(undefined),
    storage,
    apply: vi.fn(() => applyResult.promise),
    publish,
    onProjectionWarning,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(storage.getItem('preferred_language')).toBe('ko');
  expect(publish).not.toHaveBeenCalled();

  applyResult.reject(new Error('i18n repaint failed'));
  await expect(pending).resolves.toBe('ko');
  expect(publish).toHaveBeenCalledExactlyOnceWith('ko');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'ko',
    failedProjections: ['effectiveUi'],
  });
});

it('contains publication failure after every earlier projection succeeded', async () => {
  const storage = createStorage();
  const apply = vi.fn();
  const publish = vi.fn(() => { throw new Error('event refused'); });
  const onProjectionWarning = vi.fn();

  await expect(APP_FONT_PREFERENCE.commit('noto-sans', {
    invokeCommand: vi.fn().mockResolvedValue(undefined),
    storage,
    apply,
    publish,
    onProjectionWarning,
  })).resolves.toBe('noto-sans');

  expect(storage.getItem('app_font')).toBe('noto-sans');
  expect(apply).toHaveBeenCalledExactlyOnceWith('noto-sans');
  expect(onProjectionWarning).toHaveBeenCalledExactlyOnceWith({
    status: 'committed-with-projection-warning',
    value: 'noto-sans',
    failedProjections: ['publication'],
  });
});
