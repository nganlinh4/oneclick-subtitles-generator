/**
 * One editor surface's client of the native compositor.
 *
 * `src/platform/nativePreviewFrames.js` already owns coalescing, bounding, cancellation and the
 * refusal vocabulary. What is left — and what this hook is — is the React lifetime around it:
 *
 *   - **One surface per binding.** A surface is created for a `(projectId, mediaId)` pair and closed
 *     when that pair changes, when the graphics device is lost, or when the component unmounts.
 *     `close()` is called exactly once per surface, and nothing writes React state after it, so a
 *     late native response cannot resurrect a torn-down preview.
 *   - **Generations, not guesses.** Every request remembers the surface generation it was issued on.
 *     A response from an older generation is dropped rather than applied, which is the only thing
 *     that stops a project switch mid-render from painting the previous project's frame.
 *   - **Supersession is silent, refusal is loud.** `superseded` and `cancelled` outcomes settle
 *     without touching the screen, because they mean a newer frame is already on its way. A genuine
 *     refusal becomes a typed, explainable error — never a blank frame, which a user would read as
 *     an empty subtitle rather than as a failure.
 *   - **A dead URL is a miss, not a failure.** The native frame registry has its own bound and its
 *     own expiry, so a URL this hook still holds can stop resolving. That arrives as an element load
 *     error; the transport's documented answer is `forget(cacheKey)` and ask again, exactly once per
 *     key, and only then report.
 *
 * Nothing here logs, and no error carries a native path, a native message, or the user's subtitle
 * text: a failure is reduced to a stable code the caller translates.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  NATIVE_PREVIEW_DEFAULT_LAYER,
  createNativePreviewSurface,
} from '../../../platform/nativePreviewFrames';

/**
 * The native refusal code that means the GPU adapter went away rather than that the request was
 * wrong.
 *
 * A lost device invalidates every native frame the surface is holding URLs for, so the answer is to
 * release the surface and start a new generation rather than to retry against a dead one. Getting
 * this string wrong is silent in exactly the worst way: a lost device arrives as an ordinary
 * refusal, the surface is never released, and every later request renders against a device that is
 * gone.
 *
 * It is therefore not a guess and not a set of plausible spellings. It is `PreviewRefusal::code` in
 * `apps/desktop/src-tauri/src/preview/refusal.rs`, and the test beside this file reads that file to
 * prove it — from the other side, `preview::tests::layers` pins the same literal — so the two ends
 * cannot drift apart without a test failing.
 */
export const NATIVE_PREVIEW_DEVICE_LOST_CODES = Object.freeze(['previewDeviceLost']);

const deviceLost = new Set(NATIVE_PREVIEW_DEVICE_LOST_CODES);

/** The frame URL resolved but the element could not load it, twice. The registry dropped it. */
export const NATIVE_PREVIEW_FRAME_EXPIRED = 'nativePreviewFrameExpired';

/**
 * Every piece of visible state carries the binding it was produced for.
 *
 * That tag is what makes a project switch clean without a reset that races the switch: nothing is
 * cleared, it simply stops being owned, so the previous project's frame and the previous project's
 * refusal both stop being reported the moment the binding changes. Clearing on teardown instead
 * would either lose a refusal that is still true — a lost device does not un-lose itself when the
 * surface it killed is released — or leave a stale one showing over a binding it never described.
 */
const IDLE = Object.freeze({ status: 'idle', frame: null, error: null, binding: null });

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * Reduce a transport error to what may cross into the UI: a stable code and, when the bridge already
 * sanitised one, the native code. The message and stack are dropped rather than shown.
 */
const explain = (error) => Object.freeze({
  code: isNonEmptyString(error?.code) ? error.code : 'nativePreviewRejected',
  nativeCode: isNonEmptyString(error?.nativeCode) ? error.nativeCode : null,
});

/**
 * Request the natively composited frame for one instant.
 *
 * `request` is what `useNativePreviewRequest` produced — the render request, the face, the expected
 * composition size, the staged atlas and the frame index — and must be stable across renders that
 * mean the same frame; the caller memoises it, and its identity is what decides whether a new native
 * render is asked for. `active` gates requesting without tearing the surface down, so pausing after a
 * play does not throw away a cache the user is about to scrub through.
 *
 * `layer` selects between the composited frame and the subtitle pass alone. Changing it asks for a
 * new frame rather than reinterpreting the one on screen — they are two different pictures — and the
 * frame already showing is held until the new one arrives, so the handover has no gap in it.
 */
const useNativePreviewFrame = ({
  active = true,
  projectId = null,
  mediaId = null,
  request = null,
  layer = NATIVE_PREVIEW_DEFAULT_LAYER,
}) => {
  const [state, setState] = useState(IDLE);
  const [surfaceEpoch, setSurfaceEpoch] = useState(0);
  const [retryToken, setRetryToken] = useState(0);
  /**
   * The binding whose graphics device went away, if any.
   *
   * Keying the loss to the binding rather than holding a bare flag is what makes recovery fall out
   * of ordinary use: opening another project or another media file clears it, because that is a
   * different binding. It also makes the failure terminal for the binding it happened on, which is
   * the point — a surface that released a lost device and immediately reopened one against the same
   * device would refuse, release and reopen forever, and this hook holds no clock to slow that down.
   */
  const [lostBinding, setLostBinding] = useState(null);

  const stateRef = useRef(IDLE);
  const heldRef = useRef(null);
  const generationRef = useRef(0);
  const retriedRef = useRef(new Set());
  const liveRef = useRef(false);
  const bindingRef = useRef(null);

  stateRef.current = state;

  // Declared before the surface effect so its cleanup runs first: on unmount the surface teardown
  // below must already see a dead component, or it would write state after release.
  useEffect(() => {
    liveRef.current = true;
    return () => {
      liveRef.current = false;
    };
  }, []);

  const bindingKey = isNonEmptyString(projectId) && isNonEmptyString(mediaId)
    ? `${projectId}|${mediaId}`
    : null;
  bindingRef.current = bindingKey;

  useEffect(() => {
    if (bindingKey === null || lostBinding === bindingKey) {
      heldRef.current = null;
      return undefined;
    }
    generationRef.current += 1;
    const held = Object.freeze({
      surface: createNativePreviewSurface(),
      generation: generationRef.current,
    });
    heldRef.current = held;
    retriedRef.current = new Set();
    return () => {
      heldRef.current = null;
      // Exactly once per surface: this cleanup is the only caller, and React runs it once per
      // effect instance whether the binding changed, the epoch advanced, or the tree unmounted.
      held.surface.close();
      // The URLs this surface handed out address frames it no longer owns, so the picture goes.
      // The explanation does not: a refusal that released the surface is still the true answer for
      // this binding, and the binding tag retires it when the binding itself is replaced.
      if (liveRef.current) {
        setState((previous) => ({
          ...previous,
          status: previous.status === 'error' ? 'error' : 'idle',
          frame: null,
        }));
      }
    };
  }, [bindingKey, surfaceEpoch, lostBinding]);

  const isCurrent = useCallback(
    (generation) => liveRef.current && heldRef.current?.generation === generation,
    [],
  );

  useEffect(() => {
    const held = heldRef.current;
    if (!active || held === null || request === null) {
      return undefined;
    }
    const { surface, generation } = held;
    let superseded = false;
    setState((previous) => ({
      status: 'pending',
      frame: previous.binding === bindingKey ? previous.frame : null,
      error: null,
      binding: bindingKey,
    }));
    surface.requestFrame({ ...request, layer }).then(
      (outcome) => {
        // `superseded` and `cancelled` mean a newer frame is already owed to this surface, so they
        // settle without repainting. Only a `ready` outcome reaches the screen.
        if (superseded || outcome.status !== 'ready' || !isCurrent(generation)) return;
        setState({ status: 'ready', frame: outcome, error: null, binding: bindingKey });
      },
      (error) => {
        if (superseded || !isCurrent(generation)) return;
        const explained = explain(error);
        setState({ status: 'error', frame: null, error: explained, binding: bindingKey });
        if (explained.nativeCode !== null && deviceLost.has(explained.nativeCode)) {
          setLostBinding(bindingKey);
        }
      },
    );
    return () => {
      superseded = true;
    };
  }, [active, bindingKey, surfaceEpoch, lostBinding, retryToken, request, layer, isCurrent]);

  /**
   * The `<img>` could not load the URL the transport handed over.
   *
   * First time for a given key: drop it and ask again, which is what the transport documents for a
   * frame the native registry has evicted or expired. Second time: report, because retrying a URL
   * that has now failed twice would be a poll, and this module deliberately holds no clock.
   */
  const onFrameLoadError = useCallback(() => {
    const held = heldRef.current;
    const { frame, binding } = stateRef.current;
    // A load error that arrives after a project switch describes a frame this surface never issued.
    if (held === null || frame === null || binding !== bindingRef.current) return;
    if (retriedRef.current.has(frame.cacheKey)) {
      setState((previous) => ({
        status: 'error',
        frame: null,
        error: Object.freeze({ code: NATIVE_PREVIEW_FRAME_EXPIRED, nativeCode: null }),
        binding: previous.binding,
      }));
      return;
    }
    retriedRef.current.add(frame.cacheKey);
    held.surface.forget(frame.cacheKey);
    setState((previous) => ({ status: 'pending', frame: null, error: null, binding: previous.binding }));
    setRetryToken((token) => token + 1);
  }, []);

  /**
   * Release the surface and start a new generation, clearing a recorded device loss.
   *
   * This is the deliberate act that reopens a binding a lost device closed: recovery is something a
   * caller asks for, never something this hook retries into.
   */
  const releaseSurface = useCallback(() => {
    setLostBinding(null);
    setSurfaceEpoch((epoch) => epoch + 1);
  }, []);

  // Only what this binding produced is reported. Anything left over from the previous project or
  // the previous media is not cleared, it is simply not owned, which cannot race the switch.
  const owned = state.binding === bindingKey && bindingKey !== null;
  return {
    status: owned ? state.status : 'idle',
    frame: owned ? state.frame : null,
    error: owned ? state.error : null,
    onFrameLoadError,
    releaseSurface,
  };
};

export default useNativePreviewFrame;
