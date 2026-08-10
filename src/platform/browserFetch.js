import { isNativeMediaPlaybackUrl } from './mediaService';

const blockedFetch = (message, code) => {
  const error = new Error(message);
  error.name = 'SecurityError';
  error.code = code;
  return error;
};

const prototypeGetter = (constructor, property) => {
  let prototype = constructor?.prototype;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (typeof descriptor?.get === 'function') return descriptor.get;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
};

const normalizeFetchResource = (resource) => {
  if (typeof resource === 'string') {
    return Object.freeze({ address: resource, transportResource: resource });
  }

  try {
    const URLConstructor = globalThis.URL;
    const urlHrefGetter = typeof URLConstructor === 'function'
      ? prototypeGetter(URLConstructor, 'href')
      : null;
    if (urlHrefGetter && resource instanceof URLConstructor) {
      const address = urlHrefGetter.call(resource);
      if (typeof address === 'string') {
        return Object.freeze({ address, transportResource: address });
      }
    }
    const RequestConstructor = globalThis.Request;
    const requestUrlGetter = typeof RequestConstructor === 'function'
      ? prototypeGetter(RequestConstructor, 'url')
      : null;
    if (requestUrlGetter && resource instanceof RequestConstructor) {
      const address = requestUrlGetter.call(resource);
      if (typeof address === 'string') {
        return Object.freeze({ address, transportResource: resource });
      }
    }
  } catch {
    throw blockedFetch(
      'The browser resource address could not be verified',
      'unsafeBrowserFetchResource',
    );
  }

  throw blockedFetch(
    'The browser resource type is not allowed',
    'unsafeBrowserFetchResource',
  );
};

const isLoopbackAddress = (address) => {
  const URLConstructor = globalThis.URL;
  if (typeof URLConstructor !== 'function') return false;
  let parsed;
  try {
    parsed = new URLConstructor(address, 'https://osg.invalid/');
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '0.0.0.0'
    || hostname === '::'
    || hostname === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || /^::ffff:7f[0-9a-f]{2}:/.test(hostname)
    || /^::7f[0-9a-f]{2}:/.test(hostname);
};

export const fetchBrowserResource = (resource, init, {
  fetchImpl = globalThis.fetch,
} = {}) => {
  const { address, transportResource } = normalizeFetchResource(resource);
  if (isNativeMediaPlaybackUrl(address)) {
    throw blockedFetch(
      'Native playback capabilities cannot be fetched by the WebView',
      'nativeCapabilityFetchBlocked',
    );
  }
  if (isLoopbackAddress(address)) {
    throw blockedFetch(
      'Loopback resources cannot be fetched by the WebView',
      'loopbackFetchBlocked',
    );
  }
  return fetchImpl(transportResource, init);
};
