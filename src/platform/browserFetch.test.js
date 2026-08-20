import { fetchBrowserResource } from './browserFetch';

const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;
const captureError = (callback) => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw');
};

test('blocks native playback capabilities before invoking browser fetch', () => {
  const fetchImpl = vi.fn();
  expect(captureError(() => fetchBrowserResource(PLAYBACK_URL, undefined, { fetchImpl })))
    .toMatchObject({
      name: 'SecurityError',
      code: 'nativeCapabilityFetchBlocked',
    });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('blocks URL and Request capability objects without reading request bodies', () => {
  const fetchImpl = vi.fn();
  const request = new Request(PLAYBACK_URL, {
    method: 'POST',
    body: 'must-not-be-read',
  });

  expect(captureError(() => fetchBrowserResource(new URL(PLAYBACK_URL), undefined, { fetchImpl })))
    .toMatchObject({ code: 'nativeCapabilityFetchBlocked' });
  expect(captureError(() => fetchBrowserResource(request, undefined, { fetchImpl })))
    .toMatchObject({ code: 'nativeCapabilityFetchBlocked' });
  expect(request.bodyUsed).toBe(false);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('uses native URL and Request brands instead of hostile subclass accessors', () => {
  const fetchImpl = vi.fn();
  class MisleadingUrl extends URL {
    get href() {
      return 'blob:apparently-safe';
    }
  }
  class MisleadingRequest extends Request {
    get url() {
      throw new Error('hostile accessor');
    }
  }

  expect(captureError(() => fetchBrowserResource(
    new MisleadingUrl(PLAYBACK_URL),
    undefined,
    { fetchImpl },
  )))
    .toMatchObject({ code: 'nativeCapabilityFetchBlocked' });
  expect(captureError(() => fetchBrowserResource(
    new MisleadingRequest(PLAYBACK_URL),
    undefined,
    { fetchImpl },
  )))
    .toMatchObject({ code: 'nativeCapabilityFetchBlocked' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('canonicalizes an allowed URL before a hostile subclass can stringify another address', async () => {
  const response = Object.freeze({ ok: true });
  const fetchImpl = vi.fn(async () => response);
  class RedirectingUrl extends URL {
    get href() {
      return PLAYBACK_URL;
    }
  }
  const resource = new RedirectingUrl('https://example.com/audio.wav');

  await expect(fetchBrowserResource(resource, undefined, { fetchImpl })).resolves.toBe(response);
  expect(fetchImpl).toHaveBeenCalledWith('https://example.com/audio.wav', undefined);
});

test('fails closed for malformed, spoofed, and throwing resource objects', () => {
  const fetchImpl = vi.fn();
  const throwingResource = Object.create(Request.prototype);
  Object.defineProperty(throwingResource, 'url', {
    get() {
      throw new Error('must remain unread');
    },
  });

  for (const resource of [
    { url: PLAYBACK_URL },
    new String(PLAYBACK_URL),
    throwingResource,
  ]) {
    expect(captureError(() => fetchBrowserResource(resource, undefined, { fetchImpl })))
      .toMatchObject({ code: 'unsafeBrowserFetchResource' });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('blocks arbitrary loopback hosts even when they are not native capabilities', () => {
  const fetchImpl = vi.fn();
  for (const resource of [
    'http://localhost:45678/private',
    'http://127.42.0.9:45678/private',
    new URL('http://[::1]:45678/private'),
  ]) {
    expect(captureError(() => fetchBrowserResource(resource, undefined, { fetchImpl })))
      .toMatchObject({ code: 'loopbackFetchBlocked' });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('passes ordinary blob and HTTPS resources to the browser transport unchanged', async () => {
  const response = Object.freeze({ ok: true });
  const fetchImpl = vi.fn(async () => response);
  await expect(fetchBrowserResource('blob:audio', { cache: 'no-store' }, { fetchImpl }))
    .resolves.toBe(response);
  expect(fetchImpl).toHaveBeenCalledWith('blob:audio', { cache: 'no-store' });

  const request = new Request('https://example.com/audio.wav');
  await expect(fetchBrowserResource(request, undefined, { fetchImpl })).resolves.toBe(response);
  expect(fetchImpl).toHaveBeenLastCalledWith(request, undefined);
});
