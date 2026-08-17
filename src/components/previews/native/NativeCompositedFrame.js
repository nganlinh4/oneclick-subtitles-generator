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
 * THAT IS TRUE OF THE BYTES AND NOT OF WHAT REACHES THE EYE. The image is a full composition — 1920
 * wide, or 3840, or 7680 — laid out `objectFit: contain` into a panel a few hundred pixels across,
 * with no `image-rendering` hint, so the browser resamples every frame down with its own filter
 * before anything is visible. Hairline strokes, one-pixel shadow offsets and antialiased glyph edges
 * are therefore judged THROUGH that resampler and can look softer, thinner or differently aliased
 * here than in the file. Nothing on this side can remove the resample — the panel is smaller than
 * the composition — so it is stated rather than hidden: the pixel is exact, the picture of it is
 * scaled, and a judgement about sub-pixel detail belongs to the exported file.
 *
 * TWO ELEMENTS, ONE VISIBLE, and the reason is that a preview must never flash. An `<img>` whose
 * `src` changes goes blank while the new URL loads, and a blank frame in a subtitle editor reads as
 * "my subtitle disappeared" rather than as "the next frame is coming". So the frame being fetched
 * loads in a hidden element and only becomes the visible one once it has actually decoded. Scrubbing
 * therefore holds the previous real frame until the next real frame exists.
 *
 * THERE IS NO LONGER A FALLBACK, and that removal is the point rather than a simplification. This
 * element used to accept one — the CSS overlay that drew subtitles from `subtitleSettings` whenever
 * no native frame had decoded — and a second implementation that draws whenever the first cannot is
 * exactly the disagreement between preview and export this migration exists to end. When no frame is
 * on screen the `<video>` beneath shows, unsubtitled, and the surface STATES that the subtitle
 * preview is unavailable somewhere a cue never sits. Nothing here is allowed to fill the gap with an
 * approximation of one.
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
