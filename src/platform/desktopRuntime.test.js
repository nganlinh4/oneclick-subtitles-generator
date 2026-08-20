import { invoke } from '@tauri-apps/api/core';
import {
  DESKTOP_RUNTIME_UNAVAILABLE,
  DesktopRuntimeError,
  invokeDesktop,
  invokeDesktopRaw,
  isDesktopRuntime,
} from './desktopRuntime';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

beforeEach(() => {
  invoke.mockReset();
  delete window.isTauri;
});

afterEach(() => {
  delete window.isTauri;
});

it('reports whether the native host is present', () => {
  window.isTauri = true;
  expect(isDesktopRuntime()).toBe(true);
});

it('fails closed instead of attempting an IPC call in a browser', async () => {
  await expect(invokeDesktop('app_health')).rejects.toMatchObject({
    code: DESKTOP_RUNTIME_UNAVAILABLE,
    command: 'app_health',
  });
  expect(invoke).not.toHaveBeenCalled();
});

it('passes command arguments to Tauri unchanged', async () => {
  window.isTauri = true;
  invoke.mockResolvedValue({ platform: 'windows' });

  await expect(invokeDesktop('app_health', { probe: true })).resolves.toEqual({
    platform: 'windows',
  });
  expect(invoke).toHaveBeenCalledWith('app_health', { probe: true });
});

it('normalizes serialized Rust command errors', async () => {
  window.isTauri = true;
  invoke.mockRejectedValue({ code: 'invalidPath', message: 'The path is invalid' });

  await expect(invokeDesktop('select_media')).rejects.toEqual(
    expect.objectContaining({
      name: 'DesktopRuntimeError',
      code: 'invalidPath',
      command: 'select_media',
      message: 'The path is invalid',
    })
  );
});

it('retains already normalized errors', async () => {
  window.isTauri = true;
  const error = new DesktopRuntimeError('cancelled', 'Cancelled', 'select_media');
  invoke.mockRejectedValue(error);

  await expect(invokeDesktop('select_media')).rejects.toBe(error);
});

it('passes raw bytes and headers without JSON conversion', async () => {
  window.isTauri = true;
  const bytes = new Uint8Array([1, 2, 3]);
  invoke.mockResolvedValue({ asset: { id: 'opaque' } });

  await expect(invokeDesktopRaw(
    'media_blob_import',
    bytes,
    { 'x-osg-content-type': 'audio/webm' }
  )).resolves.toEqual({ asset: { id: 'opaque' } });
  expect(invoke).toHaveBeenCalledWith(
    'media_blob_import',
    bytes,
    { headers: { 'x-osg-content-type': 'audio/webm' } }
  );
});

it('rejects non-binary raw requests and never retains transport diagnostics', async () => {
  window.isTauri = true;
  await expect(invokeDesktopRaw('media_blob_import', [1, 2, 3]))
    .rejects.toMatchObject({ message: 'The desktop binary request is invalid' });
  expect(invoke).not.toHaveBeenCalled();

  invoke.mockRejectedValue({
    code: 'invalidInput',
    message: 'private audio diagnostic',
    request: new Uint8Array([9, 8, 7]),
  });
  const error = await invokeDesktopRaw(
    'media_blob_import',
    new ArrayBuffer(4)
  ).catch((failure) => failure);
  expect(error).toMatchObject({
    code: 'invalidInput',
    message: 'The desktop binary operation could not be completed',
    cause: undefined,
  });
  expect(JSON.stringify(error)).not.toContain('private audio');
  expect(JSON.stringify(error)).not.toContain('9,8,7');
});
