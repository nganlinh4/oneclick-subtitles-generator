/**
 * Synchronous host detection without importing the Tauri ESM bridge.
 *
 * Tauri's own `isTauri()` checks this exact global. Keeping the check in an import-free module
 * lets legacy browser configuration and Jest consumers detect the host without eagerly loading an
 * IPC implementation that they will never use.
 */
export const isDesktopRuntime = () => (
  typeof window !== 'undefined' && Boolean(window.isTauri)
);
