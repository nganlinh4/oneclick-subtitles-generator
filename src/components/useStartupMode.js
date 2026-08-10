import { useState, useEffect } from 'react';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { detectStartupMode } from '../platform/startupService';

/**
 * Tracks whether the app runs in Vercel/hosted "npm start" mode (no local backend features) vs a
 * normal local run. Heavy-engine availability is no longer a global flag — it's per-engine via
 * useEngineStatus. Seeds from localStorage, mirrors cross-tab `storage` changes, and resolves an
 * uncached browser mode or revalidates the deterministic native desktop mode.
 *
 * @returns {{ isVercelMode: boolean }}
 */
const useStartupMode = () => {
    const [isVercelMode, setIsVercelMode] = useState(() => {
        try {
            return localStorage.getItem('is_vercel_mode') === 'true';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        let aborted = false;
        const onStorage = (e) => {
            if (e.key === 'is_vercel_mode') {
                setIsVercelMode(e.newValue === 'true');
            }
        };
        window.addEventListener('storage', onStorage);

        (async () => {
            try {
                const exists = localStorage.getItem('is_vercel_mode');
                if (isDesktopRuntime() || exists === null) {
                    const startupMode = await detectStartupMode();
                    if (!aborted && startupMode.backendAvailable) {
                        setIsVercelMode(startupMode.isVercelMode);
                        try {
                            localStorage.setItem('is_vercel_mode', startupMode.isVercelMode ? 'true' : 'false');
                        } catch {
                            // Compatibility metadata is optional in the native runtime.
                        }
                    }
                }
            } catch {
                // Startup detection is retried by the native health path.
            }
        })();

        return () => {
            aborted = true;
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    return { isVercelMode };
};

export default useStartupMode;
