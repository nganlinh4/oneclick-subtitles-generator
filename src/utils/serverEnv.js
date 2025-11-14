/**
 * Server environment detection utility
 * - Probes whether the local backend server is available
 * - Caches the result to avoid repeated network calls
 */

const SERVER_URL = 'http://localhost:3031';

let _cachedAvailable = null; // null = unknown, true/false once probed
let _inFlightPromise = null;
// Fast path: read previously detected value from Header.js
const readBackendAvailableFromLocalStorage = () => {
  try {
    const v = localStorage.getItem('backend_available');
    if (v === 'true') return true;
    if (v === 'false') return false;
  } catch {}
  return null;
};


/**
 * Probe if the backend server is reachable. Caches the result.
 * @returns {Promise<boolean>} true if server appears available
 */
export const probeServerAvailability = async () => {
  if (_cachedAvailable !== null) return _cachedAvailable;
  // Reuse cached detection from Header.js if available
  const fromLS = readBackendAvailableFromLocalStorage();
  if (fromLS !== null) {
    _cachedAvailable = fromLS;
    return _cachedAvailable;
  }
  if (_inFlightPromise) return _inFlightPromise;

  _inFlightPromise = (async () => {
    // Try a health endpoint first if present
    const tryEndpoints = [
      `${SERVER_URL}/api/health`,
      `${SERVER_URL}/health`,
      `${SERVER_URL}/api/save-subtitles`, // CORS preflight/OPTIONS often enabled
      `${SERVER_URL}/api/extract-video-segment`
    ];

    for (const url of tryEndpoints) {
      try {
        // Use a lightweight request; OPTIONS/HEAD/GET fallbacks
        let res = await fetch(url, { method: 'GET', cache: 'no-store' });
        if (!res.ok && res.status === 405) {
          // Method not allowed still proves server is there
          _cachedAvailable = true;
          return true;
        }
        if (res.ok) {
          _cachedAvailable = true;
          return true;
        }
      } catch (e1) {
        try {
          let res2 = await fetch(url, { method: 'OPTIONS' });
          if (res2 && (res2.ok || res2.status === 204 || res2.status === 200)) {
            _cachedAvailable = true;
            return true;
          }
        } catch {}
      }
    }

    _cachedAvailable = false;
    return false;
  })().finally(() => {
    _inFlightPromise = null;
  });

  return _inFlightPromise;
};

/**
 * Returns last known availability synchronously (null if not probed yet)
 */
export const getServerAvailabilityCached = () => _cachedAvailable;

/**
 * Convenience helper: true if running Vercel version (server not available)
 */
export const isFrontendOnly = async () => !(await probeServerAvailability());



/**
 * Synchronous check using Header.js cached value if present
 */
export const isServerAvailableSync = () => {
  const v = (() => { try { return localStorage.getItem('backend_available'); } catch { return null; } })();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return _cachedAvailable === true;
};

/**
 * Synchronous inverse helper
 */
export const isFrontendOnlySync = () => !isServerAvailableSync();
