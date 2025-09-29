import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * PlayPauseMorphType4
 *
 * Goal: Visual style inspired by Type 2 (rotate/scale, hybrid feel)
 * with the robust morphing of Type 3 (clip-path polygon + Web Animations API).
 * - No requestAnimationFrame loops for morphing
 * - Uses WAAPI to animate CSS clip-path polygon between play/pause shapes
 * - Graceful fallback to SVG crossfade if clip-path/WAAPI unsupported
 *
 * Tuning in one place: edit TYPE4_DEFAULTS below or pass a `config` prop to override.
 */

export const TYPE4_DEFAULTS = {
  duration: 700,            // ms morph duration
  samples: 150,             // number of sampled points along the path
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  rotateDegrees: 3,         // degrees applied depending on state
  fillOpacity: 0.8,         // opacity of fill layer
  outlineScale: 1,          // scales the drop-shadow “stroke” intensity
  outlineShadow1Px: 1,      // base px for first shadow
  outlineShadow2Px: 2,      // base px for second shadow
  fallbackCrossfadeMs: 250, // ms for fallback crossfade
  // Morph behavior knobs
  morphOvershoot: 0.0,      // 0..0.35 extrapolation beyond target for elastic feel
  morphMidOffset: 0.7,      // 0..1 position of the overshoot keyframe
  keyframeEasings: null,    // optional array like ['ease-out','ease-in']
};
// Utility to build intermediate polygon with overshoot
function lerpPoints(a, b, t) {
  if (!a || !b || a.length !== b.length) return a || b || [];
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const ax = a[i][0], ay = a[i][1];
    const bx = b[i][0], by = b[i][1];
    out[i] = [ax + (bx - ax) * t, ay + (by - ay) * t];
  }
  return out;
}


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
    setPlayPts(sample(p1));
    setPausePts(sample(p2));
  }, [samples]);

  return { hidden, playPts, pausePts };
}

// Convert sampled SVG points to a CSS polygon() string in percentages
function toCssPolygon(points) {
  if (!points || !points.length) return 'polygon(50% 50%, 50% 50%, 50% 50%)';
  const coords = points.map(([px, py]) => {
    const x = (px / 960) * 100;
    const y = ((-py) / 960) * 100; // invert Y axis from SVG to CSS
    return `${x.toFixed(2)}% ${y.toFixed(2)}%`;
  });
  return `polygon(${coords.join(', ')})`;
}

export default function PlayPauseMorphType4({
  playing: controlledPlaying,
  onToggle,
  size = 48,
  color = 'currentColor',
  title = 'Play/Pause',
  className,
  style,
  config,
}) {
  const isControlled = typeof controlledPlaying === 'boolean';
  const [uncontrolledPlaying, setUncontrolledPlaying] = useState(false);
  const playing = isControlled ? controlledPlaying : uncontrolledPlaying;

  const cfg = useMemo(() => ({ ...TYPE4_DEFAULTS, ...(config || {}) }), [config]);

  const { hidden, playPts, pausePts } = useSampledPoints(PLAY_D, PAUSE_D, cfg.samples);

  const boxRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { setReady(!!(playPts && pausePts)); }, [playPts, pausePts]);

  const handleClick = useCallback(() => {
    if (onToggle) onToggle();
    if (!isControlled) setUncontrolledPlaying((p) => !p);
  }, [onToggle, isControlled]);

  // Pulse CSS keyframe injection
  const pulseAnim = useMemo(() => 'ppm4_pulse_' + Math.random().toString(36).slice(2), []);
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-ppm4', pulseAnim);
    el.textContent = `@keyframes ${pulseAnim}{0%{transform:scale(1)}40%{transform:scale(1.06)}100%{transform:scale(1)}}`;
    document.head.appendChild(el);
    return () => { try { document.head.removeChild(el); } catch(_){} };
  }, [pulseAnim]);

  // Animate clip-path via WAAPI when playing changes
  useEffect(() => {
    if (!ready) return;
    const el = boxRef.current;
    if (!el || !el.animate) return;

    // Arrays of points for direction
    const fromPtsArr = playing ? playPts : pausePts;
    const toPtsArr = playing ? pausePts : playPts;

    // Build keyframes: optional overshoot mid-shape
    const overshoot = Math.max(0, Math.min(0.35, cfg.morphOvershoot || 0));
    const midOffset = Math.max(0.05, Math.min(0.95, cfg.morphMidOffset || 0.7));

    const fromPath = toCssPolygon(fromPtsArr);
    const toPath = toCssPolygon(toPtsArr);

    const frames = [];
    frames.push({ clipPath: fromPath, offset: 0 });
    if (overshoot > 0) {
      const midPts = lerpPoints(fromPtsArr, toPtsArr, 1 + overshoot);
      const midPath = toCssPolygon(midPts);
      const midFrame = { clipPath: midPath, offset: midOffset };
      if (Array.isArray(cfg.keyframeEasings) && cfg.keyframeEasings[0]) midFrame.easing = cfg.keyframeEasings[0];
      frames.push(midFrame);
    }
    const endFrame = { clipPath: toPath, offset: 1 };
    if (Array.isArray(cfg.keyframeEasings)) {
      const idx = overshoot > 0 ? 1 : 0;
      if (cfg.keyframeEasings[idx]) endFrame.easing = cfg.keyframeEasings[idx];
    }
    frames.push(endFrame);

    // Ensure initial state
    const cs = getComputedStyle(el);
    const currentClip = cs.clipPath || cs.webkitClipPath;
    if (!currentClip || currentClip === 'none') {
      el.style.clipPath = fromPath;
      el.style.webkitClipPath = fromPath;
    }

    try {
      const anim = el.animate(
        frames,
        { duration: Math.max(250, Math.min(1600, cfg.duration)), easing: cfg.easing, fill: 'forwards' }
      );
      anim.onfinish = () => { el.style.clipPath = toPath; el.style.webkitClipPath = toPath; };
    } catch (e) {
      el.style.clipPath = toPath;
      el.style.webkitClipPath = toPath;
    }
  }, [playing, ready, playPts, pausePts, cfg.duration, cfg.easing, cfg.morphOvershoot, cfg.morphMidOffset, cfg.keyframeEasings]);

  const initialClip = useMemo(() => toCssPolygon(playing ? pausePts : playPts), [playing, playPts, pausePts]);

  const supportsClip = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('clip-path', 'polygon(0 0, 100% 0, 100% 100%)');
  const supportsWAAPI = typeof document !== 'undefined' && !!(HTMLElement.prototype.animate);
  const canDoClipAnim = supportsClip && supportsWAAPI;

  // Slight rotation like Type 2 (configurable)
  const rot = useMemo(() => (playing ? cfg.rotateDegrees : -cfg.rotateDegrees), [playing, cfg.rotateDegrees]);

  return (
    <div
      role="button"
      aria-label={title}
      onClick={handleClick}
      style={{ display: 'inline-flex', cursor: 'pointer', lineHeight: 0, position: 'relative', width: size, height: size, ...style }}
      className={className}
      title={title}
    >
      {hidden}

      {/* Morphing shape via clip-path polygon */}
      {canDoClipAnim && ready ? (
        <div style={{ position: 'relative', width: size, height: size, transform: `rotate(${rot}deg)`, animation: `${pulseAnim} 650ms ease-out` }}>
          {/* Fill layer (semi-transparent like Type 2) */}
          <div
            ref={boxRef}
            style={{
              position: 'absolute', inset: 0,
              background: color,
              opacity: cfg.fillOpacity,
              clipPath: initialClip,
              willChange: 'clip-path, transform',
            }}
          />
          {/* Stroke-ish layer using drop-shadow along the clip edge */}
          <div
            style={{
              position: 'absolute', inset: 0,
              background: 'transparent',
              clipPath: initialClip,
              filter: `drop-shadow(0 0 ${cfg.outlineShadow1Px * cfg.outlineScale}px ${color}) drop-shadow(0 0 ${cfg.outlineShadow2Px * cfg.outlineScale}px ${color})`,
              pointerEvents: 'none',
            }}
          />
        </div>
      ) : (
        // Fallback: SVG crossfade
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

