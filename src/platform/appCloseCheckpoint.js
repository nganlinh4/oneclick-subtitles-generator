import { validate as validateUuid, version as uuidVersion } from 'uuid';

import i18n from '../i18n/i18n';
import { flushDurableLyricsHistory } from './durableLyricsCheckpoint';
import { invokeDesktop } from './desktopRuntime';
import { isDesktopRuntime } from './runtimeEnvironment';

export const CLOSE_CHECKPOINT_HANDLER = '__OSG_FLUSH_BEFORE_CLOSE__';
export const CLOSE_CHECKPOINT_PENDING = '__OSG_PENDING_CLOSE_CHECKPOINT__';
export const CLOSE_CHECKPOINT_TIMEOUT_MS = 15_000;

const isNonce = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 4;
  } catch {
    return false;
  }
};

const timed = (operation, timeoutMs, schedule, cancel) => new Promise((resolve, reject) => {
  const timeout = schedule(() => {
    const error = new Error('The subtitle checkpoint did not finish before close timed out');
    error.code = 'closeCheckpointTimeout';
    reject(error);
  }, timeoutMs);
  Promise.resolve(operation).then(
    (value) => {
      cancel(timeout);
      resolve(value);
    },
    (error) => {
      cancel(timeout);
      reject(error);
    },
  );
});

/**
 * Install the one privileged shutdown handshake without granting the WebView Tauri event-listen or
 * window-close capabilities. Rust prevents the native close and evaluates this private callback;
 * only a matching one-shot nonce can arm the second close request.
 */
export const installAppCloseCheckpoint = ({
  nativeRuntime = isDesktopRuntime,
  invoke = invokeDesktop,
  flush = flushDurableLyricsHistory,
  host = typeof window === 'undefined' ? null : window,
  timeoutMs = CLOSE_CHECKPOINT_TIMEOUT_MS,
  schedule = setTimeout,
  cancel = clearTimeout,
  showFailure = () => host?.addToast?.(
    i18n.t(
      'subtitlesInput.saveFailed',
      'The subtitles could not be saved. Please try again.',
    ),
    'error',
    8000,
    'app-close-checkpoint',
  ),
} = {}) => {
  if (!nativeRuntime() || host === null) return () => undefined;
  if (typeof invoke !== 'function' || typeof flush !== 'function'
      || typeof schedule !== 'function' || typeof cancel !== 'function') {
    throw new TypeError('The close checkpoint requires reviewed dependencies');
  }

  let activeNonce = null;
  let disposed = false;
  const handle = async (nonce) => {
    if (disposed || !isNonce(nonce) || activeNonce !== null) return false;
    activeNonce = nonce;
    try {
      await timed(flush(), timeoutMs, schedule, cancel);
      const armed = await invoke('app_close_checkpoint_complete', { nonce });
      if (armed !== true) throw new Error('The native close checkpoint was not armed');
      if (host[CLOSE_CHECKPOINT_PENDING] === nonce) {
        delete host[CLOSE_CHECKPOINT_PENDING];
      }
      // Arming and closing are separate commands so the arm acknowledgement reaches JavaScript
      // before destroying the WebView that carries command responses. A lost response may mean the
      // native window closed successfully, but an explicit `false` means Rust rolled the one-shot
      // arm back and the still-open window needs to tell the user.
      void invoke('app_close_checkpoint_commit', { nonce }).then((closed) => {
        if (closed === true) return;
        try {
          showFailure();
        } catch {
          // Presentation failure never changes the native refusal.
        }
      }).catch(() => {
        try {
          showFailure();
        } catch {
          // Presentation failure never changes the native close decision.
        }
      });
      return true;
    } catch {
      try {
        const released = await invoke('app_close_checkpoint_failed', { nonce });
        if (released === true && host[CLOSE_CHECKPOINT_PENDING] === nonce) {
          delete host[CLOSE_CHECKPOINT_PENDING];
        }
      } catch {
        // A broken IPC boundary leaves both copies of the nonce intact. A later native close can
        // retry the exact checkpoint instead of manufacturing permission to exit.
      }
      try {
        showFailure();
      } catch {
        // Presentation failure never changes the close decision.
      }
      return false;
    } finally {
      activeNonce = null;
    }
  };
  const dispatch = (nonce) => { void handle(nonce); };
  host[CLOSE_CHECKPOINT_HANDLER] = dispatch;

  const pending = host[CLOSE_CHECKPOINT_PENDING];
  if (isNonce(pending)) dispatch(pending);

  return () => {
    disposed = true;
    if (host[CLOSE_CHECKPOINT_HANDLER] === dispatch) {
      delete host[CLOSE_CHECKPOINT_HANDLER];
    }
  };
};
