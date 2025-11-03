import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * Checks availability of local Nvidia Parakeet ASR service.
 * Logic:
 * - If not Full mode (localStorage.is_full_version !== 'true'), mark unavailable.
 * - If Full mode, ping /api/parakeet/health with retries (for slow startup).
 * - Listens to storage events to react to startup-mode changes.
 *
 * @param {Object} options
 * @param {number} [options.retries=5] number of retries when in Full mode
 * @param {number} [options.intervalMs=3000] delay between retries
 * @returns {{ available: boolean, checking: boolean, error: string | null, refresh: () => void, isFullMode: boolean }}
 */
export default function useParakeetAvailability(options = {}) {
  const { retries = 5, intervalMs = 3000 } = options;
  const [isFullMode, setIsFullMode] = useState(() => {
    try {
      return localStorage.getItem('is_full_version') === 'true';
    } catch {
      return false;
    }
  });
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);

  const performCheck = useCallback(async () => {
    try {
      const API_BASE_URL = process.env.REACT_APP_API_BASE_URL || 'http://localhost:3031';
      setChecking(true);
      setError(null);

      // If not Full mode, it's unavailable regardless of health
      if (!isFullMode) {
        setAvailable(false);
        setChecking(false);
        return;
      }

      let attempt = 0;
      let ok = false;
      while (attempt <= retries && !ok) {
        attempt += 1;
        try {
          const controller = new AbortController();
          abortRef.current = controller;
          const resp = await fetch(`${API_BASE_URL}/api/parakeet/health`, {
            mode: 'cors',
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
          });
          if (resp.ok) {
            ok = true;
            break;
          }
        } catch (e) {
          // swallow and retry
        }
        if (attempt <= retries) {
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }

      setAvailable(ok);
      setChecking(false);
    } catch (e) {
      setAvailable(false);
      setChecking(false);
      setError(e?.message || 'errorCheckingParakeet');
    }
  }, [isFullMode, retries, intervalMs]);

  // Run on mount and when Full mode changes
  useEffect(() => {
    performCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullMode]);

  // Listen for storage changes from other parts (e.g., Header)
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === 'is_full_version') {
        setIsFullMode(e.newValue === 'true');
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const refresh = useCallback(() => {
    performCheck();
  }, [performCheck]);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return { available, checking, error, refresh, isFullMode };
}
