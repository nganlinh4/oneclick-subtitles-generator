import { invoke } from '@tauri-apps/api/core';
import { isDesktopRuntime } from './runtimeEnvironment';

export { isDesktopRuntime } from './runtimeEnvironment';

export const DESKTOP_RUNTIME_UNAVAILABLE = 'desktopRuntimeUnavailable';
export const DESKTOP_COMMAND_FAILED = 'desktopCommandFailed';
/**
 * A native call's own promise never settled -- Tauri's IPC bridge neither resolved nor rejected
 * it. This is distinct from `DESKTOP_COMMAND_FAILED`: that code means Rust answered with a
 * refusal, while this one means no answer arrived at all below the typed command boundary, so the
 * call carries none of this codebase's own refusal codes. See `DESKTOP_COMMAND_TIMEOUT_MS`.
 */
export const DESKTOP_COMMAND_TIMED_OUT = 'desktopCommandTimedOut';

/**
 * How long a bounded native call may go unanswered before this boundary gives up on it.
 *
 * Most registered commands are a fast request/response: they validate, start a job and return a
 * snapshot, or read/write one durable record. A job's real duration is reported afterwards on its
 * own `Channel`, never by holding this call's promise open, so a call that has not settled by this
 * bound is not "still working" -- it is a stuck transport call, and whatever the customer's edit
 * was behind it silently never lands until something fires it closed.
 *
 * A HANDFUL OF COMMANDS ARE THE OPPOSITE: `select_media`, `select_media_candidate` and
 * `legacy_import_select` each hold their promise open for as long as a native file/folder picker
 * dialog stays on screen, which is bounded only by the customer's own patience -- easily minutes.
 * Racing every call against one bound by default would reject those mid-pick while the dialog is
 * still open, a strictly worse regression than the stuck-transport bug this exists to fix. This is
 * therefore opt-in per call (`{ timeoutMs }`), never a default; `invokeDesktop`/`invokeDesktopRaw`
 * wait forever unless a caller explicitly asks for a bound.
 */
export const DESKTOP_COMMAND_TIMEOUT_MS = 20_000;

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
 * Race one native call against a bound so a transport call that never resolves or rejects cannot
 * hold a customer's edit open forever.
 *
 * `Promise.race` cannot cancel the losing side -- a Tauri command has no cancellation token for a
 * bridge-level hang -- so the original call is left to finish, or not, in the background. That is
 * safe here: every mutating command this boundary reaches is compare-and-swap protected against a
 * late duplicate response (`project_track_commit`'s `expectedHistoryVersion`, `project_commit`'s
 * `state_version`, and so on), so a caller that retries after this fires never double-applies an
 * edit -- the loser of the two, whichever settles second, is rejected by that same guard instead.
 */
const raceTimeout = (settling, command, timeoutMs) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return settling;
  let timer = null;
  const clock = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DesktopRuntimeError(
        DESKTOP_COMMAND_TIMED_OUT,
        `Desktop command "${command}" did not respond in time`,
        command
      ));
    }, timeoutMs);
  });
  return Promise.race([settling, clock]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
};

/**
 * Invoke one explicitly permitted native command.
 *
 * This intentionally has no HTTP or browser fallback. Call sites that still support the legacy
 * web server must choose that fallback themselves so native migration remains visible and
 * testable instead of silently routing arbitrary requests through a global interceptor.
 */
export const invokeDesktop = async (
  command,
  args = {},
  { timeoutMs = Number.POSITIVE_INFINITY } = {}
) => {
  if (!isDesktopRuntime()) {
    throw new DesktopRuntimeError(
      DESKTOP_RUNTIME_UNAVAILABLE,
      'This operation requires the desktop runtime',
      command
    );
  }

  try {
    return await raceTimeout(invoke(command, args), command, timeoutMs);
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
export const invokeDesktopRaw = async (
  command,
  body,
  headers = {},
  { timeoutMs = Number.POSITIVE_INFINITY } = {}
) => {
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
    return await raceTimeout(invoke(command, body, { headers }), command, timeoutMs);
  } catch (error) {
    throw normalizeRawCommandError(command, error);
  }
};
