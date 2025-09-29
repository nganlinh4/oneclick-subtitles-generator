import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * PlayPauseMorphType3 (Web Animations API via CSS clip-path path morph)
 *
 * True morphing using CSS clip-path: path('...') animated with the Web Animations API.
 * Avoids rAF and SMIL, relies on the browser's compositor. We convert SVG path
 * samples into a CSS path polygon and animate clip-path between states.
 */

const VIEW_BOX = '0 -960 960 960';

const PLAY_D = 'M275-248v-464q0-29.85 20.64-48.92Q316.29-780 343.48-780q8.68 0 18.1 2.5Q371-775 380-770l365 233q16.5 9 24.25 24.84T777-480q0 16.32-8 32.16Q761-432 745-423L380-190q-9 5-18.64 7.5t-18.22 2.5q-26.85 0-47.5-19.08Q275-218.15 275-248Z';
const PAUSE_D = 'M675.48-128q-56.48 0-95.98-39.31Q540-206.63 540-264v-433q0-55.97 39.32-95.99Q618.64-833 676.02-833 732-833 772-792.99q40 40.02 40 95.99v433q0 57.37-40.02 96.69Q731.96-128 675.48-128Zm-391.5 0Q228-128 188-167.31q-40-39.32-40-96.69v-433q0-55.97 40.02-95.99Q228.04-833 284.52-833t95.98 40.01Q420-752.97 420-697v433q0 57.37-39.32 96.69Q341.36-128 283.98-128Z';

function useSampledPoints(playD, pauseD, samples) {
  const playRef = useRef(null);
  const pauseRef = useRef(null);
  const [playPts, setPlayPts] = useState(null);
  const [pausePts, setPausePts] = useState(null);

  const hidden = (
    <svg viewBox={VIEW_BOX} width={1} height={1} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, left: -9999, top: -9999 }} aria-hidden focusable="false">
      <path ref={playRef} d={playD} />
      <path ref={pauseRef} d={pauseD} />
    </svg>
  );

  useLayoutEffect(() => {
    const p1 = playRef.current; const p2 = pauseRef.current;
    if (!p1 || !p2) return;
    const sample = (pathEl) => {
      let len = 0;
      try { len = pathEl.getTotalLength(); } catch { len = 0; }
      if (!len || !isFinite(len)) len = 1;
      const pts = [];
      for (let i = 0; i < samples; i++) {
        const t = (i / samples) * len;
        const { x, y } = pathEl.getPointAtLength(t);
        pts.push([+x, +y]);
      }
      return pts;
    };
    // No rAF dependency
    setPlayPts(sample(p1));
    setPausePts(sample(p2));
  }, [samples]);

  return { hidden, playPts, pausePts };
}

// Convert sampled SVG points to a CSS polygon() string in percentages (widely supported)
function toCssPolygon(points) {
  if (!points || !points.length) return 'polygon(50% 50%, 50% 50%, 50% 50%)';
  const coords = points.map(([px, py]) => {
    const x = (px / 960) * 100;
    const y = ((-py) / 960) * 100; // invert Y axis from SVG to CSS
    return `${x.toFixed(2)}% ${y.toFixed(2)}%`;
  });
  return `polygon(${coords.join(', ')})`;
}

export default function PlayPauseMorphType3({
  playing: controlledPlaying,
  onToggle,
  size = 48,
  color = 'currentColor',
  duration = 500,
  samples = 180,
  title = 'Play/Pause',
  className,
  style,
}) {
  const isControlled = typeof controlledPlaying === 'boolean';
  const [uncontrolledPlaying, setUncontrolledPlaying] = useState(false);
  const playing = isControlled ? controlledPlaying : uncontrolledPlaying;

  const { hidden, playPts, pausePts } = useSampledPoints(PLAY_D, PAUSE_D, samples);

  const boxRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { setReady(!!(playPts && pausePts)); }, [playPts, pausePts]);

  const handleClick = useCallback(() => {
    if (onToggle) onToggle();
    if (!isControlled) setUncontrolledPlaying((p) => !p);
  }, [onToggle, isControlled]);

  // Animate clip-path via WAAPI when playing changes
  useEffect(() => {
    if (!ready) return;
    const el = boxRef.current;
    if (!el || !el.animate) return;

    const fromPath = toCssPolygon(playing ? playPts : pausePts);
    const toPath = toCssPolygon(playing ? pausePts : playPts);

    // Set initial to ensure a jump-free start
    const cs = getComputedStyle(el);
    const currentClip = cs.clipPath || cs.webkitClipPath;
    if (!currentClip || currentClip === 'none') {
      el.style.clipPath = fromPath;
      // vendor prefix for older Chromium
      el.style.webkitClipPath = fromPath;
    }

    try {
      const anim = el.animate(
        [
          { clipPath: fromPath },
          { clipPath: toPath }
        ],
        { duration: Math.max(180, Math.min(1500, duration)), easing: 'cubic-bezier(0.2, 0.0, 0.0, 1)', fill: 'forwards' }
      );
      // Ensure end state sticks
      anim.onfinish = () => { el.style.clipPath = toPath; el.style.webkitClipPath = toPath; };
    } catch (e) {
      // Fallback: snap to end
      el.style.clipPath = toPath;
      el.style.webkitClipPath = toPath;
    }
  }, [playing, ready, playPts, pausePts, duration]);

  const initialClip = useMemo(() => toCssPolygon(playing ? pausePts : playPts), [playing, playPts, pausePts]);

  const supportsClip = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('clip-path', 'polygon(0 0, 100% 0, 100% 100%)');
  const supportsWAAPI = typeof document !== 'undefined' && !!(HTMLElement.prototype.animate);
  const canDoClipAnim = supportsClip && supportsWAAPI;

  // Render
  return (
    <div
      role="button"
      aria-label={title}
      onClick={handleClick}
      style={{ display: 'inline-flex', cursor: 'pointer', lineHeight: 0, ...style }}
      className={className}
      title={title}
    >
      {hidden}
      {canDoClipAnim && ready ? (
        <div
          ref={boxRef}
          style={{
            width: size,
            height: size,
            background: color,
            clipPath: initialClip,
            willChange: 'clip-path, transform',
            transform: `rotate(${playing ? 2 : -2}deg)`,
          }}
        />
      ) : (
        // Fallback: simple crossfade inside an SVG (no white square)
        <svg viewBox={VIEW_BOX} width={size} height={size} style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
          <g>
            <path d={PAUSE_D} fill={color} opacity={playing ? 1 : 0} style={{ transition: 'opacity 250ms ease-out' }} />
            <path d={PLAY_D} fill={color} opacity={playing ? 0 : 1} style={{ transition: 'opacity 250ms ease-out' }} />
          </g>
        </svg>
      )}
    </div>
  );
}

