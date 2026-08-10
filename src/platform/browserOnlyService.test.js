import {
  BLOCKED_BROWSER_SERVICE_ORIGIN,
  BrowserOnlyServiceError,
  guardBrowserOnlyServiceOrigin,
  isLoopbackServiceUrl,
  requireBrowserOnlyService,
} from './browserOnlyService';

it('preserves browser service origins without a trailing slash', () => {
  expect(guardBrowserOnlyServiceOrigin('http://localhost:3031/', {
    nativeRuntime: () => false,
  })).toBe('http://localhost:3031');
  expect(guardBrowserOnlyServiceOrigin('ws://127.0.0.1:3032', {
    nativeRuntime: () => false,
  })).toBe('ws://127.0.0.1:3032');
});

it('replaces browser service origins with an unrouteable desktop sentinel', () => {
  expect(guardBrowserOnlyServiceOrigin('http://localhost:3031', {
    nativeRuntime: () => true,
  })).toBe(BLOCKED_BROWSER_SERVICE_ORIGIN);
});

it('fails closed when a browser-only operation is reached in Tauri', () => {
  expect(() => requireBrowserOnlyService({ nativeRuntime: () => true }))
    .toThrow(BrowserOnlyServiceError);
  expect(() => requireBrowserOnlyService({ nativeRuntime: () => false }))
    .not.toThrow();
});

it('rejects credentials, paths, and unsupported schemes in service origins', () => {
  for (const origin of [
    'file:///tmp/backend',
    'http://user:secret@localhost:3031',
    'http://localhost:3031/api',
  ]) {
    expect(() => guardBrowserOnlyServiceOrigin(origin, {
      nativeRuntime: () => false,
    })).toThrow(BrowserOnlyServiceError);
  }
});

it('recognizes loopback transports without treating native capability URLs specially', () => {
  expect(isLoopbackServiceUrl('http://localhost:3031/api/health')).toBe(true);
  expect(isLoopbackServiceUrl('ws://127.0.0.1:3032')).toBe(true);
  expect(isLoopbackServiceUrl('http://127.42.0.9:3031')).toBe(true);
  expect(isLoopbackServiceUrl('http://0.0.0.0:3031')).toBe(true);
  expect(isLoopbackServiceUrl('http://[::1]:3031')).toBe(true);
  expect(isLoopbackServiceUrl('https://example.com/video')).toBe(false);
  expect(isLoopbackServiceUrl('https://localhost.example.com/video')).toBe(false);
  expect(isLoopbackServiceUrl('blob:https://example.com/id')).toBe(false);
});
