import { isDesktopRuntime } from './runtimeEnvironment';

export const BLOCKED_BROWSER_SERVICE_ORIGIN = 'osg-browser-only://unavailable';

const supportedProtocols = new Set(['http:', 'https:', 'ws:', 'wss:']);

export class BrowserOnlyServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrowserOnlyServiceError';
    this.code = code;
  }
}

const invalidOrigin = () => new BrowserOnlyServiceError(
  'invalidBrowserServiceOrigin',
  'The browser-only service origin is invalid'
);

export const guardBrowserOnlyServiceOrigin = (origin, {
  nativeRuntime = isDesktopRuntime,
} = {}) => {
  if (typeof origin !== 'string' || origin.length === 0) throw invalidOrigin();

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalidOrigin();
  }
  if (!supportedProtocols.has(parsed.protocol)
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.pathname !== '/'
      || parsed.search !== ''
      || parsed.hash !== '') {
    throw invalidOrigin();
  }

  return nativeRuntime()
    ? BLOCKED_BROWSER_SERVICE_ORIGIN
    : origin.replace(/\/$/, '');
};

export const requireBrowserOnlyService = ({
  nativeRuntime = isDesktopRuntime,
} = {}) => {
  if (nativeRuntime()) {
    throw new BrowserOnlyServiceError(
      'browserOnlyServiceUnavailable',
      'This compatibility service is unavailable in the desktop runtime'
    );
  }
};

export const isLoopbackServiceUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return supportedProtocols.has(parsed.protocol)
      && (hostname === 'localhost'
        || hostname === '0.0.0.0'
        || hostname === '[::1]'
        || hostname === '[0:0:0:0:0:0:0:1]'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname));
  } catch {
    return false;
  }
};
