import {
  FONT_COVERAGE_PROBES,
  FONT_READY_TIMEOUT_MS,
  MANAGED_UI_FONT_FAMILY,
  revealDesktopWindowWhenReady,
  waitForFont,
} from './uiFontBootstrap';

describe('uiFontBootstrap', () => {
  afterEach(() => {
    delete window.__OSG_MANAGED_UI_FONT__;
    delete window.__OSG_MANAGED_UI_FONT_READY__;
    document.documentElement.classList.remove('osg-managed-ui-font-ready');
    vi.useRealTimers();
  });

  it('waits for the managed family before revealing the desktop window', async () => {
    window.__OSG_MANAGED_UI_FONT__ = true;
    window.__OSG_MANAGED_UI_FONT_READY__ = Promise.resolve(true);
    let finishLoading;
    const loading = new Promise((resolve) => {
      finishLoading = resolve;
    });
    const fonts = { load: vi.fn(() => loading), check: vi.fn(() => true) };
    const show = vi.fn();
    const reveal = revealDesktopWindowWhenReady({
      nativeRuntime: () => true,
      wait: () => waitForFont({ fonts, timeoutMs: 30_000 }),
      show,
    });

    await vi.waitFor(() => {
      expect(fonts.load).toHaveBeenCalledTimes(FONT_COVERAGE_PROBES.length);
    });
    expect(fonts.load.mock.calls.map(([, text]) => text)).toEqual(FONT_COVERAGE_PROBES);
    expect(show).not.toHaveBeenCalled();
    finishLoading([{}]);
    await expect(reveal).resolves.toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(fonts.check).toHaveBeenCalledTimes(FONT_COVERAGE_PROBES.length);
    expect(document.documentElement).toHaveClass('osg-managed-ui-font-ready');
  });

  it('reveals immediately when the verified package is unavailable', async () => {
    window.__OSG_MANAGED_UI_FONT__ = false;
    const fonts = { load: vi.fn() };
    const show = vi.fn();
    await expect(revealDesktopWindowWhenReady({
      nativeRuntime: () => true,
      wait: () => waitForFont({ fonts }),
      show,
    })).resolves.toBe(true);
    expect(fonts.load).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveClass('osg-managed-ui-font-ready');
  });

  it('bounds font readiness so a broken WebView font API cannot hide the app forever', async () => {
    vi.useFakeTimers();
    window.__OSG_MANAGED_UI_FONT__ = true;
    window.__OSG_MANAGED_UI_FONT_READY__ = Promise.resolve(true);
    const fonts = { load: vi.fn(() => new Promise(() => {})) };
    const show = vi.fn();
    const reveal = revealDesktopWindowWhenReady({
      nativeRuntime: () => true,
      wait: () => waitForFont({ fonts }),
      show,
    });

    await vi.advanceTimersByTimeAsync(FONT_READY_TIMEOUT_MS);
    await expect(reveal).resolves.toBe(true);
    expect(show).toHaveBeenCalledOnce();
    expect(document.documentElement).not.toHaveClass('osg-managed-ui-font-ready');
  });

  it('does not mistake an empty FontFaceSet result for a loaded managed font', async () => {
    window.__OSG_MANAGED_UI_FONT__ = true;
    window.__OSG_MANAGED_UI_FONT_READY__ = Promise.resolve(true);
    const fonts = { load: vi.fn(async () => []), check: vi.fn(() => true) };

    await expect(waitForFont({ fonts })).resolves.toBe(false);
    expect(fonts.check).not.toHaveBeenCalled();
  });

  it('waits for DOM-safe stylesheet installation before asking the FontFaceSet', async () => {
    window.__OSG_MANAGED_UI_FONT__ = true;
    let finishInstalling;
    window.__OSG_MANAGED_UI_FONT_READY__ = new Promise((resolve) => {
      finishInstalling = resolve;
    });
    const fonts = { load: vi.fn(async () => [{}]), check: vi.fn(() => true) };
    const waiting = waitForFont({ fonts, timeoutMs: 30_000 });

    await Promise.resolve();
    expect(fonts.load).not.toHaveBeenCalled();
    finishInstalling(true);
    await expect(waiting).resolves.toBe(true);
    expect(fonts.load).toHaveBeenCalledWith(
      `400 16px "${MANAGED_UI_FONT_FAMILY}"`,
      FONT_COVERAGE_PROBES[0],
    );
  });

  it('does not call a desktop API in browser mode', async () => {
    const wait = vi.fn();
    const show = vi.fn();
    await expect(revealDesktopWindowWhenReady({
      nativeRuntime: () => false,
      wait,
      show,
    })).resolves.toBe(false);
    expect(wait).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
});
