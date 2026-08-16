import { useEffect, useRef, useState } from 'react';

/**
 * The natively composited frame, laid over the `<video>` it replaces while the user is judging it.
 *
 * This element is the whole visible consequence of the migration. What it shows is not an
 * approximation of the export — it IS an exported pixel: decoded video, crop, flip, canvas backfill
 * and the subtitle layer, blended by `crates/osg-compositor` in one pass and delivered as a single
 * image. The frame the user approves is therefore the frame they get, by construction rather than by
 * a test that a second renderer keeps having to pass.
 *
 * TWO ELEMENTS, ONE VISIBLE, and the reason is that a preview must never flash. An `<img>` whose
 * `src` changes goes blank while the new URL loads, and a blank frame in a subtitle editor reads as
 * "my subtitle disappeared" rather than as "the next frame is coming". So the frame being fetched
 * loads in a hidden element and only becomes the visible one once it has actually decoded. Scrubbing
 * therefore holds the previous real frame until the next real frame exists.
 *
 * `fallback` is what the surface shows when no native frame has decoded — before the first frame
 * arrives, and whenever the compositor is unavailable for this source. THE HANDOVER IS DECIDED HERE,
 * in one place, on the only fact that matters: whether a real frame is on screen. A caller deciding
 * it from "a frame was returned" would hide the fallback during the milliseconds the image is still
 * decoding, and a subtitle that blinks out on pause is precisely the kind of detail this migration is
 * not allowed to introduce.
 *
 * TWO LAYERS THROUGH ONE ELEMENT. During continuous playback the frame carries the subtitle layer
 * alone — transparent everywhere no cue covers, so the `<video>` beneath it plays through — and on
 * pause it carries the composited frame for the instant the user stopped on. The element does not
 * choose; it shows whatever decoded last, tagged with `data-layer` so which one is on screen is
 * observable rather than inferred.
 *
 * WHAT THE PLAYING LAYER DOES NOT GUARANTEE: the browser performs that final blend, over a frame its
 * own video decoder colour-managed on its own terms, so the result is close to the export rather than
 * identical to it. The composited layer is the one every decision is made against, and because the
 * previously decoded frame is held until the next has decoded, the approximation is replaced rather
 * than removed — never a blank, and never the last thing shown once playback stops.
 *
 * The URL is only ever an element load. It is never fetched, never read back, never turned into a
 * canvas: `connect-src` does not include the loopback capability server, and nothing here tries.
 */
const NativeCompositedFrame = ({
  frame,
  visible,
  onLoadError,
  fallback = null,
  className = '',
  style = null,
}) => {
  const [shown, setShown] = useState(null);
  const pendingRef = useRef(null);

  const nextUrl = frame === null || frame === undefined ? null : frame.url;
  const nextLayer = frame === null || frame === undefined ? null : (frame.layer ?? null);
  pendingRef.current = nextUrl;

  useEffect(() => {
    if (nextUrl === null) setShown(null);
  }, [nextUrl]);

  const showing = visible && shown !== null;
  const loading = visible && nextUrl !== null && nextUrl !== shown?.url;

  return (
    <>
      {showing && (
        <img
          className={`native-composited-frame ${className}`.trim()}
          src={shown.url}
          data-layer={shown.layer ?? undefined}
          alt=""
          draggable={false}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            pointerEvents: 'none',
            zIndex: 2,
            ...(style ?? {}),
          }}
        />
      )}
      {!showing && fallback}
      {loading && (
        <img
          key={nextUrl}
          className="native-composited-frame-pending"
          src={nextUrl}
          alt=""
          aria-hidden="true"
          style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
          onLoad={() => {
            // A frame that decoded after a newer one was already requested must not overwrite it.
            if (pendingRef.current === nextUrl) setShown({ url: nextUrl, layer: nextLayer });
          }}
          onError={() => {
            if (pendingRef.current === nextUrl && typeof onLoadError === 'function') onLoadError();
          }}
        />
      )}
    </>
  );
};

export default NativeCompositedFrame;
