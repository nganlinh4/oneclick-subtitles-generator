import {
  LegacyImportServiceError,
  createLegacyImportService,
  installLegacyImportKeyboardAction,
  normalizeLegacyImportReport,
  normalizeLegacyImportStatus,
} from './legacyImportService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(),
}));

const SOURCE_ID = '01890f47-e323-7c62-9f73-123456789abc';
const SECOND_SOURCE_ID = '01890f47-e324-7f71-8a64-abcdef012345';
const emptyCounts = (overrides = {}) => ({
  pending: 0,
  imported: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});
const summary = (overrides = {}) => ({
  sourceId: SOURCE_ID,
  state: 'complete',
  settings: emptyCounts({ imported: 2 }),
  credentials: emptyCounts({ skipped: 1 }),
  artifacts: emptyCounts({ imported: 3 }),
  ignored: emptyCounts({ skipped: 4 }),
  ...overrides,
});
const report = (overrides = {}) => ({
  summary: summary(),
  sourceRetained: true,
  alreadyImported: false,
  ...overrides,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('legacy import response boundary', () => {
  test('copies and deeply freezes only the exact path-free report schema', () => {
    const raw = report();
    const normalized = normalizeLegacyImportReport(raw);

    expect(normalized).toEqual(raw);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.summary)).toBe(true);
    expect(Object.isFrozen(normalized.summary.settings)).toBe(true);
    expect(JSON.stringify(normalized)).not.toMatch(/path|url|fileName|directory/i);

    raw.summary.settings.imported = 999;
    expect(normalized.summary.settings.imported).toBe(2);
  });

  test.each([
    report({ sourcePath: 'C:\\Users\\private\\legacy' }),
    report({ summary: summary({ sourceUrl: 'file:///Users/private/legacy' }) }),
    report({ summary: summary({ artifacts: { ...emptyCounts(), path: '/private/artifact' } }) }),
    report({ summary: summary({ sourceId: 'C:\\Users\\private\\legacy' }) }),
    report({ sourceRetained: false }),
    report({ alreadyImported: true, summary: summary({ state: 'failed' }) }),
    report({ summary: summary({ state: 'running' }) }),
    report({ summary: summary({ settings: emptyCounts({ imported: 20_001 }) }) }),
    report({ summary: summary({
      settings: emptyCounts({ imported: 10_001 }),
      artifacts: emptyCounts({ imported: 10_000 }),
    }) }),
    report({ summary: summary({ state: 'complete', artifacts: emptyCounts({ failed: 1 }) }) }),
  ])('rejects malformed, contradictory, unbounded, or path-bearing reports %#', (value) => {
    expect(() => normalizeLegacyImportReport(value)).toThrow(LegacyImportServiceError);
  });

  test('rejects hidden, symbolic, and accessor-backed metadata instead of copying it', () => {
    const hidden = report();
    Object.defineProperty(hidden, 'sourcePath', {
      value: 'C:\\Users\\private\\legacy',
      enumerable: false,
    });
    expect(() => normalizeLegacyImportReport(hidden)).toThrow(LegacyImportServiceError);

    const symbolic = report();
    symbolic[Symbol('sourcePath')] = '/Users/private/legacy';
    expect(() => normalizeLegacyImportReport(symbolic)).toThrow(LegacyImportServiceError);

    const accessor = report();
    Object.defineProperty(accessor.summary.settings, 'imported', {
      get: () => 2,
      enumerable: true,
    });
    expect(() => normalizeLegacyImportReport(accessor)).toThrow(LegacyImportServiceError);
  });

  test('validates bounded unique status history while allowing an active import summary', () => {
    const status = normalizeLegacyImportStatus([
      summary({ state: 'running', settings: emptyCounts({ pending: 1 }) }),
      summary({ sourceId: SECOND_SOURCE_ID }),
    ]);
    expect(status).toHaveLength(2);
    expect(Object.isFrozen(status)).toBe(true);
    expect(status[0].state).toBe('running');

    expect(() => normalizeLegacyImportStatus([
      summary(),
      summary(),
    ])).toThrow(LegacyImportServiceError);
    expect(() => normalizeLegacyImportStatus(Array.from(
      { length: 65 },
      (_, index) => summary({ sourceId: `01890f47-${(0xe300 + index).toString(16)}-7000-8000-000000000000` })
    ))).toThrow(LegacyImportServiceError);
  });
});

describe('legacy import service', () => {
  test('uses only the two fixed commands and accepts native picker cancellation', async () => {
    const invokeCommand = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce([summary()]);
    const service = createLegacyImportService({
      nativeRuntime: () => true,
      invokeCommand,
    });

    await expect(service.importLegacyData()).resolves.toBeNull();
    await expect(service.getLegacyImportStatus()).resolves.toEqual([summary()]);
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'legacy_import_select', {});
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'legacy_import_status', {});
  });

  test('prevents concurrent picker/import operations before a second IPC invocation', async () => {
    const pending = deferred();
    const invokeCommand = vi.fn().mockReturnValueOnce(pending.promise);
    const service = createLegacyImportService({
      nativeRuntime: () => true,
      invokeCommand,
    });

    const first = service.importLegacyData();
    expect(service.isImportInProgress()).toBe(true);
    await expect(service.importLegacyData()).rejects.toMatchObject({
      name: 'LegacyImportServiceError',
      code: 'legacyImportBusy',
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    pending.resolve(report());
    await expect(first).resolves.toEqual(report());
    expect(service.isImportInProgress()).toBe(false);
  });

  test('fails closed outside Tauri and sanitizes transport diagnostics without retaining a cause', async () => {
    const invokeCommand = vi.fn();
    const browserService = createLegacyImportService({
      nativeRuntime: () => false,
      invokeCommand,
    });
    await expect(browserService.importLegacyData()).rejects.toMatchObject({
      code: 'desktopRuntimeUnavailable',
    });
    expect(invokeCommand).not.toHaveBeenCalled();

    const privatePath = 'C:\\Users\\private\\legacy';
    const nativeService = createLegacyImportService({
      nativeRuntime: () => true,
      invokeCommand: vi.fn().mockRejectedValue({
        code: 'invalidLegacyImport',
        message: privatePath,
        path: privatePath,
      }),
    });
    let caught;
    try {
      await nativeService.importLegacyData();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'invalidLegacyImport',
      message: 'The legacy data import could not be completed',
    });
    expect(caught.cause).toBeUndefined();
    expect(JSON.stringify(caught)).not.toContain(privatePath);
  });
});

describe('legacy import keyboard action', () => {
  const installationKey = Symbol.for('osg.legacyImportKeyboardAction.v1');
  const cleanups = [];
  const t = (key, values = {}) => `${key}:${JSON.stringify(values)}`;

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
    delete globalThis[installationKey];
  });

  const install = (options = {}) => {
    const cleanup = installLegacyImportKeyboardAction({
      nativeRuntime: () => true,
      eventTarget: document,
      platform: 'Win32',
      t,
      ...options,
    });
    cleanups.push(cleanup);
    return cleanup;
  };

  const dispatch = (overrides = {}) => {
    const event = new KeyboardEvent('keydown', {
      code: 'KeyI',
      altKey: true,
      shiftKey: true,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...overrides,
    });
    const accepted = document.dispatchEvent(event);
    return { event, accepted };
  };

  test('installs only in desktop mode and is idempotent for repeated startup calls', async () => {
    const service = { importLegacyData: vi.fn().mockResolvedValue(null) };
    const notify = vi.fn();
    const browserCleanup = installLegacyImportKeyboardAction({
      nativeRuntime: () => false,
      eventTarget: document,
      service,
      notify,
      platform: 'Win32',
      t,
    });
    dispatch();
    expect(service.importLegacyData).not.toHaveBeenCalled();
    browserCleanup();

    const firstCleanup = install({ service, notify });
    const secondCleanup = install({ service, notify });
    expect(secondCleanup).toBe(firstCleanup);
    const { accepted } = dispatch();
    expect(accepted).toBe(false);
    await vi.waitFor(() => expect(service.importLegacyData).toHaveBeenCalledTimes(1));
  });

  test('replaces a stale HMR installation and cleanup removes the active listener', () => {
    const staleCleanup = vi.fn();
    globalThis[installationKey] = {
      owner: Symbol('stale-module'),
      eventTarget: document,
      cleanup: staleCleanup,
    };
    const service = { importLegacyData: vi.fn().mockResolvedValue(null) };
    const cleanup = install({ service, notify: vi.fn() });
    expect(staleCleanup).toHaveBeenCalledOnce();

    cleanup();
    dispatch();
    expect(service.importLegacyData).not.toHaveBeenCalled();
  });

  test('requires Ctrl on Windows/Linux and Command on macOS with no competing primary modifier', async () => {
    const windowsService = { importLegacyData: vi.fn().mockResolvedValue(null) };
    install({ service: windowsService, notify: vi.fn(), platform: 'Linux x86_64' });
    dispatch({ ctrlKey: false, metaKey: true });
    dispatch({ ctrlKey: true, metaKey: true });
    expect(windowsService.importLegacyData).not.toHaveBeenCalled();
    dispatch();
    await vi.waitFor(() => expect(windowsService.importLegacyData).toHaveBeenCalledOnce());

    cleanups.pop()();
    const macService = { importLegacyData: vi.fn().mockResolvedValue(null) };
    install({ service: macService, notify: vi.fn(), platform: 'MacIntel' });
    dispatch();
    dispatch({ ctrlKey: true, metaKey: true });
    expect(macService.importLegacyData).not.toHaveBeenCalled();
    dispatch({ ctrlKey: false, metaKey: true });
    await vi.waitFor(() => expect(macService.importLegacyData).toHaveBeenCalledOnce());
  });

  test('ignores repeats, composition, wrong keys, and previously handled events', () => {
    const service = { importLegacyData: vi.fn().mockResolvedValue(null) };
    install({ service, notify: vi.fn() });
    dispatch({ repeat: true });
    dispatch({ isComposing: true });
    dispatch({ code: 'KeyM' });
    const handled = new KeyboardEvent('keydown', {
      code: 'KeyI', altKey: true, shiftKey: true, ctrlKey: true, cancelable: true,
    });
    handled.preventDefault();
    document.dispatchEvent(handled);
    expect(service.importLegacyData).not.toHaveBeenCalled();
  });

  test('surfaces localized picker, completion, cancellation, and safe error status', async () => {
    const notify = vi.fn();
    const service = {
      importLegacyData: vi.fn()
        .mockResolvedValueOnce(report())
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new LegacyImportServiceError('invalidLegacyImport')),
    };
    install({ service, notify });

    dispatch();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.complete:{"imported":5,"skipped":5}',
      'success',
      12_000
    ));
    expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.selectFolder:{}',
      'info',
      120_000
    );

    dispatch();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.cancelled:{}',
      'info',
      4_000
    ));

    dispatch();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.invalid:{}',
      'error',
      10_000
    ));
  });

  test('surfaces already-imported and partial-failure summaries without identifiers', async () => {
    const notify = vi.fn();
    const service = {
      importLegacyData: vi.fn()
        .mockResolvedValueOnce(report({ alreadyImported: true }))
        .mockResolvedValueOnce(report({
          summary: summary({
            state: 'failed',
            artifacts: emptyCounts({ failed: 2 }),
          }),
        })),
    };
    install({ service, notify });

    dispatch();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.alreadyImported:{}',
      'info',
      8_000
    ));
    dispatch();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(
      'common.legacyImport.failedItems:{"count":2}',
      'warning',
      12_000
    ));
    expect(JSON.stringify(notify.mock.calls)).not.toContain(SOURCE_ID);
  });
});
