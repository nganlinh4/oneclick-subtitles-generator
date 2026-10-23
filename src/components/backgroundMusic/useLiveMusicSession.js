// The native Gemini live-music session behind the PromptDJ iframe: start, prompt updates,
// transport controls and close, with the session closed on unmount.
import { useCallback, useEffect, useRef } from 'react';
import {
  getActiveGeminiCredentialId,
  initializeCredentialState,
} from '../../platform/credentialStateController';
import {
  applyLiveMusicControl,
  closeLiveMusicSession,
  startLiveMusicSession,
  updateLiveMusicPrompts,
} from '../../platform/liveMusicService';

const LIVE_CONTROLS = new Set(['play', 'pause', 'stop', 'resetContext']);

/**
 * @param {object} params
 * @param {(message: object, transfer?: Transferable[]) => void} params.postToPromptDj
 */
const useLiveMusicSession = ({ postToPromptDj }) => {
  const liveSessionRef = useRef(null);
  const liveStartRef = useRef(null);
  const closeAfterStartRef = useRef(false);

  const postFailure = useCallback((code, message) => {
    postToPromptDj({
      type: 'pm-dj-native-event',
      payload: { event: 'failed', error: { code, message } },
    });
  }, [postToPromptDj]);

  const onNativeStart = useCallback((weightedPrompts) => {
    if (liveStartRef.current || liveSessionRef.current) {
      postFailure('liveMusicUnavailable', 'The native live music service is unavailable.');
      return;
    }
    let terminal = false;
    const start = (async () => {
      try {
        await initializeCredentialState();
        const credentialId = getActiveGeminiCredentialId();
        if (!credentialId) {
          postToPromptDj({ type: 'pm-dj-native-init', available: false });
          postFailure('liveMusicCredentialUnavailable', 'A Gemini credential is required.');
          return;
        }
        const session = await startLiveMusicSession({ credentialId, weightedPrompts }, {
          onEvent: (payload) => {
            if (payload.event === 'closed' || payload.event === 'failed') {
              terminal = true;
              liveSessionRef.current = null;
            }
            postToPromptDj({ type: 'pm-dj-native-event', payload });
          },
          onAudio: (pcm) => {
            postToPromptDj({ type: 'pm-dj-native-audio', pcm }, [pcm]);
          },
          onProtocolError: () => {
            postFailure('liveMusicProtocolFailed', 'The native live music stream is invalid.');
          },
        });
        if (!terminal) liveSessionRef.current = session;
        if (closeAfterStartRef.current && !terminal) {
          closeAfterStartRef.current = false;
          await closeLiveMusicSession(session.id).catch(() => undefined);
        }
      } catch {
        postFailure('liveMusicUnavailable', 'The native live music service is unavailable.');
      }
    })();
    liveStartRef.current = start;
    start.finally(() => {
      if (liveStartRef.current === start) liveStartRef.current = null;
    });
  }, [postFailure, postToPromptDj]);

  const onNativeUpdate = useCallback((weightedPrompts) => {
    const session = liveSessionRef.current;
    if (!session) return;
    updateLiveMusicPrompts(session.id, weightedPrompts).catch(() => {
      postFailure('liveMusicUpdateFailed', 'The live music prompts could not be updated.');
    });
  }, [postFailure]);

  const onNativeControl = useCallback((control) => {
    const session = liveSessionRef.current;
    if (!session || !LIVE_CONTROLS.has(control)) return;
    applyLiveMusicControl(session.id, control).catch(() => {
      postFailure('liveMusicControlFailed', 'The live music control could not be applied.');
    });
  }, [postFailure]);

  const onNativeClose = useCallback(() => {
    const session = liveSessionRef.current;
    if (!session) {
      if (liveStartRef.current) closeAfterStartRef.current = true;
      return;
    }
    closeLiveMusicSession(session.id).catch(() => undefined);
  }, []);

  useEffect(() => () => {
    closeAfterStartRef.current = true;
    const session = liveSessionRef.current;
    if (session) closeLiveMusicSession(session.id).catch(() => undefined);
  }, []);

  return { onNativeStart, onNativeUpdate, onNativeControl, onNativeClose };
};

export default useLiveMusicSession;
