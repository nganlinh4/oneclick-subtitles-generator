import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './runtimeEnvironment';

export { isDesktopRuntime } from './runtimeEnvironment';

export const DESKTOP_RUNTIME_UNAVAILABLE = 'desktopRuntimeUnavailable';
export const DESKTOP_COMMAND_FAILED = 'desktopCommandFailed';

export class DesktopRuntimeError extends Error {
  constructor(code, message, command, cause) {
    super(message);
    this.name = 'DesktopRuntimeError';
    this.code = code;
    this.command = command;
    this.cause = cause;
  }
}

const normalizeCommandError = (command, error) => {
  if (error instanceof DesktopRuntimeError) {
    return error;
  }

  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : DESKTOP_COMMAND_FAILED;
    const message = typeof error.message === 'string'
      ? error.message
      : `Desktop command "${command}" failed`;
    return new DesktopRuntimeError(code, message, command, error);
  }

  const message = typeof error === 'string'
    ? error
    : `Desktop command "${command}" failed`;
  return new DesktopRuntimeError(DESKTOP_COMMAND_FAILED, message, command, error);
};

const normalizeRawCommandError = (command, error) => {
  const code = typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : DESKTOP_COMMAND_FAILED;
  // Raw IPC can contain private media bytes. Never retain a transport error/cause that could have
  // captured its request arguments, even when a custom bridge implementation misbehaves.
  return new DesktopRuntimeError(
    code,
    'The desktop binary operation could not be completed',
    command
  );
};

/**
 * Invoke one explicitly permitted native command.
 *
 * This intentionally has no HTTP or browser fallback. Call sites that still support the legacy
 * web server must choose that fallback themselves so native migration remains visible and
 * testable instead of silently routing arbitrary requests through a global interceptor.
 */
export const invokeDesktop = async (command, args = {}) => {
  if (!isDesktopRuntime()) {
    throw new DesktopRuntimeError(
      DESKTOP_RUNTIME_UNAVAILABLE,
      'This operation requires the desktop runtime',
      command
    );
  }

  try {
    return await invoke(command, args);
  } catch (error) {
    throw normalizeCommandError(command, error);
  }
};

/**
 * Invoke an explicitly permitted command with Tauri's raw binary request body.
 *
 * The caller owns format and size validation. This boundary deliberately has no JSON conversion,
 * base64 fallback, or error-cause retention.
 */
export const invokeDesktopRaw = async (command, body, headers = {}) => {
  if (!isDesktopRuntime()) {
    throw new DesktopRuntimeError(
      DESKTOP_RUNTIME_UNAVAILABLE,
      'This operation requires the desktop runtime',
      command
    );
  }
  if (!(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
    throw new DesktopRuntimeError(
      DESKTOP_COMMAND_FAILED,
      'The desktop binary request is invalid',
      command
    );
  }

  try {
    return await invoke(command, body, { headers });
  } catch (error) {
    throw normalizeRawCommandError(command, error);
  }
};
