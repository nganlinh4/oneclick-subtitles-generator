import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

/**
 * Resolve whether privileged desktop capabilities are available. Browser-only inspection is a
 * deliberately limited mode and never probes a legacy local server.
 */
export const detectStartupMode = async () => {
  if (!isDesktopRuntime()) {
    return {
      backendAvailable: false,
      isVercelMode: true,
    };
  }

  const health = await invokeDesktop('app_health');
  return {
    backendAvailable: true,
    isVercelMode: false,
    health,
  };
};
