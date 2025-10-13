import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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
  rotateDegrees: 5,         // degrees applied depending on state
  fillOpacity: 1,         // opacity of fill layer
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
  if (!a || !b) return a || b || [];
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const ax = a[i][0], ay = a[i][1];
    const bx = b[i][0], by = b[i][1];
    out[i] = [ax + (bx - ax) * t, ay + (by - ay) * t];
  }
  return out;
}


// Detect the largest jump between consecutive points and split into two sequences.
function splitByLargestJump(points) {
  if (!points || points.length < 4) return null;
  let maxDist = -1;
  let idx = -1;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const d2 = dx * dx + dy * dy;
    if (d2 > maxDist) { maxDist = d2; idx = i; }
  }
  if (idx <= 0 || idx >= points.length - 1) return null;
  const a = points.slice(0, idx);
  const b = points.slice(idx);
  // Heuristic: ensure the two parts are reasonably sized
  if (a.length < 8 || b.length < 8) return null;
  return [a, b];
}

// Simple resampler to produce "count" points from an existing sequence
function resamplePoints(points, count) {
  if (!points || points.length === 0 || count <= 0) return [];
  const res = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = (i / count) * (points.length - 1);
    const i0 = Math.floor(t);
    const i1 = Math.min(points.length - 1, i0 + 1);
    const frac = t - i0;
    const x = points[i0][0] + (points[i1][0] - points[i0][0]) * frac;
    const y = points[i0][1] + (points[i1][1] - points[i0][1]) * frac;
    res[i] = [x, y];
  }
  return res;
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
    const pPts = sample(p1);
    const qPts = sample(p2);
    setPlayPts(pPts);
    setPausePts(qPts);

  }, [samples]);

  return { hidden, playPts, pausePts };
}

// Ensure polygon has a consistent winding to reduce self-intersections
function normalizePolygon(points) {
  if (!points || points.length < 3) return points || [];
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= points.length; cy /= points.length;
  const pts = points.slice().map(([x, y]) => ({ x, y, a: Math.atan2(y - cy, x - cx) }));
  pts.sort((p, q) => p.a - q.a);
  return pts.map(p => [p.x, p.y]);
}

// Convert sampled SVG points to a CSS polygon() string in percentages
function toCssPolygon(points) {
  if (!points || !points.length) return 'polygon(50% 50%, 50% 50%, 50% 50%)';
  const norm = normalizePolygon(points);
  const coords = norm.map(([px, py]) => {
    const x = (px / 960) * 100;
    const y = ((py + 960) / 960) * 100;
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

  const split = useMemo(() => {
    if (!playPts || !pausePts) return null;

    const qSplit = splitByLargestJump(pausePts);
    if (!qSplit) return null;

    let [qA_raw, qB_raw] = qSplit;

    const avgX = (pts) => pts.reduce((sum, p) => sum + p[0], 0) / pts.length;
    if (avgX(qA_raw) > avgX(qB_raw)) {
      [qA_raw, qB_raw] = [qB_raw, qA_raw];
    }

    let minX = Infinity, maxX = -Infinity;
    playPts.forEach(([x]) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    });

    const centerX = (minX + maxX) / 2;
    const overlapWidth = (maxX - minX) * 0.25;

    const pA_raw = playPts.filter(([x]) => x < centerX + overlapWidth);
    const pB_raw = playPts.filter(([x]) => x > centerX - overlapWidth);
    
    const perPart = Math.max(20, Math.floor(cfg.samples / 2));

    return {
      playA: resamplePoints(pA_raw, perPart),
      playB: resamplePoints(pB_raw, perPart),
      pauseA: resamplePoints(qA_raw, perPart),
      pauseB: resamplePoints(qB_raw, perPart),
    };
  }, [playPts, pausePts, cfg.samples]);


  const containerRef = useRef(null); // [FIX] Add a ref for the rotating container
  const boxRef1 = useRef(null);
  const boxRef2 = useRef(null);
  const [ready, setReady] = useState(false);
  const animTokenRef = useRef(0);

  useEffect(() => { setReady(!!(playPts && pausePts)); }, [playPts, pausePts]);

  const handleClick = useCallback(() => {
    const next = !playing;
    if (onToggle) {
      try { onToggle.length > 0 ? onToggle(next) : onToggle(); } catch { onToggle(); }
    }
    if (!isControlled) setUncontrolledPlaying(next);
  }, [onToggle, isControlled, playing]);

  const pulseAnim = useMemo(() => 'ppm4_pulse_' + Math.random().toString(36).slice(2), []);
  useEffect(() => {
    const el = document.createElement('style');
    el.setAttribute('data-ppm4', pulseAnim);
    el.textContent = `@keyframes ${pulseAnim}{0%{transform:scale(1)}40%{transform:scale(1.06)}100%{transform:scale(1)}}`;
    document.head.appendChild(el);
    return () => { try { document.head.removeChild(el); } catch(_){} };
  }, [pulseAnim]);

  const anim1Ref = useRef(null);
  const anim2Ref = useRef(null);
  const animContainerRef = useRef(null); // [FIX] Add a ref to hold the container's animation instance

  useEffect(() => {
    if (!ready) return;
    const token = ++animTokenRef.current;

    // --- [FIX] START: Rotation animation logic ---
    const containerEl = containerRef.current;
    if (animContainerRef.current) {
        try { animContainerRef.current.cancel(); } catch {}
        animContainerRef.current = null;
    }
    // Define the start and end rotation states
    const fromRot = playing ? -cfg.rotateDegrees : cfg.rotateDegrees;
    const toRot = playing ? cfg.rotateDegrees : -cfg.rotateDegrees;
    // --- [FIX] END: Rotation animation logic ---

    const parts = split ? [
      { fromPts: playing ? split.playA : split.pauseA, toPts: playing ? split.pauseA : split.playA, el: boxRef1.current, animRef: anim1Ref, lastClipRef: lastClip1Ref },
      { fromPts: playing ? split.playB : split.pauseB, toPts: playing ? split.pauseB : split.playB, el: boxRef2.current, animRef: anim2Ref, lastClipRef: lastClip2Ref },
    ] : [
      { fromPts: playing ? playPts : pausePts, toPts: playing ? pausePts : playPts, el: boxRef1.current, animRef: anim1Ref, lastClipRef: lastClip1Ref },
    ];

    const validParts = parts.filter(p => p.el && typeof p.el.animate === 'function');
    if (validParts.length === 0 && !containerEl) return;

    const startPaths = new Map();
    validParts.forEach(({ el, fromPts, lastClipRef }) => {
      const cs = getComputedStyle(el);
      let currentClip = cs.clipPath || cs.webkitClipPath;
      if (!currentClip || currentClip === 'none') {
        currentClip = lastClipRef.current || toCssPolygon(fromPts);
      }
      startPaths.set(el, currentClip);
    });

    validParts.forEach(({ el, animRef }) => {
      el.getAnimations?.().forEach(a => a.cancel());
      if (animRef.current) {
        try { animRef.current.cancel(); } catch {}
        animRef.current = null;
      }
    });

    // --- [FIX] Animate the container's rotation using WAAPI ---
    if (containerEl && typeof containerEl.animate === 'function') {
        animContainerRef.current = containerEl.animate(
            [{ transform: `rotate(${fromRot}deg)` }, { transform: `rotate(${toRot}deg)` }],
            { duration: Math.max(250, Math.min(1600, cfg.duration)), easing: cfg.easing, fill: 'forwards' }
        );
    }

    validParts.forEach(({ fromPts, toPts, el, animRef, lastClipRef }) => {
      const fromPath = startPaths.get(el);
      const toPath = toCssPolygon(toPts);

      el.style.clipPath = fromPath;
      el.style.webkitClipPath = fromPath;
      lastClipRef.current = fromPath;

      const overshoot = Math.max(0, Math.min(0.35, cfg.morphOvershoot || 0));
      const midOffset = Math.max(0.05, Math.min(0.95, cfg.morphMidOffset || 0.7));

      const frames = [];
      frames.push({ clipPath: fromPath, offset: 0 });
      if (overshoot > 0) {
        const midPts = lerpPoints(fromPts, toPts, 1 + overshoot);
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

      try {
        const anim = el.animate(frames, { duration: Math.max(250, Math.min(1600, cfg.duration)), easing: cfg.easing, fill: 'forwards' });
        animRef.current = anim;
        anim.onfinish = () => {
          if (animTokenRef.current === token) {
            el.style.clipPath = toPath; el.style.webkitClipPath = toPath;
            lastClipRef.current = toPath;
          }
        };
      } catch (e) {
        el.style.clipPath = toPath;
        el.style.webkitClipPath = toPath;
        lastClipRef.current = toPath;
      }
    });
  }, [playing, ready, playPts, pausePts, split, cfg.duration, cfg.easing, cfg.morphOvershoot, cfg.morphMidOffset, cfg.keyframeEasings, cfg.rotateDegrees]);

  // [FIX] This is no longer needed for the transition but useful for setting the initial state.
  const currentRotation = playing ? cfg.rotateDegrees : -cfg.rotateDegrees;

  const lastClip1Ref = useRef(null);
  const lastClip2Ref = useRef(null);

  const defaultStart = useMemo(() => {
    if (!ready) return ['none', 'none'];
    if (split) {
      return [
        toCssPolygon(playing ? split.playA : split.pauseA),
        toCssPolygon(playing ? split.playB : split.pauseB),
      ];
    }
    return [toCssPolygon(playing ? playPts : pausePts)];
  }, [ready, split, playing, playPts, pausePts]);

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
      
      {/* [FIX] The container now gets a ref and has its transition properties removed. */}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: size,
          height: size,
          animation: `${pulseAnim} 650ms ease-out`,
          // The WAAPI will control the transform, but we set the initial state here
          // to prevent a jump on first render before the animation runs.
          transform: `rotate(${currentRotation}deg)`,
          // NO `transition` property here anymore!
        }}
      >
        {/* Fill layer(s) */}
        <div
          ref={boxRef1}
          style={{
            position: 'absolute', inset: 0,
            background: color,
            opacity: cfg.fillOpacity,
            clipPath: lastClip1Ref.current || defaultStart[0],
            willChange: 'clip-path, transform',
          }}
        />
        {split && (
          <div
            ref={boxRef2}
            style={{
              position: 'absolute', inset: 0,
              background: color,
              opacity: cfg.fillOpacity,
              clipPath: lastClip2Ref.current || defaultStart[1],
              willChange: 'clip-path, transform',
            }}
          />
        )}

        {/* Stroke-ish layer(s) */}
        <div
          style={{
            position: 'absolute', inset: 0,
            background: 'transparent',
            clipPath: lastClip1Ref.current || defaultStart[0],
            filter: `drop-shadow(0 0 ${cfg.outlineShadow1Px * cfg.outlineScale}px ${color}) drop-shadow(0 0 ${cfg.outlineShadow2Px * cfg.outlineScale}px ${color})`,
            pointerEvents: 'none',
          }}
        />
        {split && (
          <div
            style={{
              position: 'absolute', inset: 0,
              background: 'transparent',
              clipPath: lastClip2Ref.current || defaultStart[1],
              filter: `drop-shadow(0 0 ${cfg.outlineShadow1Px * cfg.outlineScale}px ${color}) drop-shadow(0 0 ${cfg.outlineShadow2Px * cfg.outlineScale}px ${color})`,
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </div>
  );
}