import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * PlayPauseMorphType2
 *
 * A creative variant of the Play/Pause morph:
 *  - Uses a spring-like interpolation for a playful, elastic feel
 *  - Adds a subtle rotate/scale during morph
 *  - Emits a soft pulse ring on state changes
 *  - Stroke/Fill hybrid style for a distinct look
 *
 * Props: same as PlayPauseMorph
 */

const VIEW_BOX = '0 -960 960 960';

const PLAY_D = 'M275-248v-464q0-29.85 20.64-48.92Q316.29-780 343.48-780q8.68 0 18.1 2.5Q371-775 380-770l365 233q16.5 9 24.25 24.84T777-480q0 16.32-8 32.16Q761-432 745-423L380-190q-9 5-18.64 7.5t-18.22 2.5q-26.85 0-47.5-19.08Q275-218.15 275-248Z';
const PAUSE_D = 'M675.48-128q-56.48 0-95.98-39.31Q540-206.63 540-264v-433q0-55.97 39.32-95.99Q618.64-833 676.02-833 732-833 772-792.99q40 40.02 40 95.99v433q0 57.37-40.02 96.69Q731.96-128 675.48-128Zm-391.5 0Q228-128 188-167.31q-40-39.32-40-96.69v-433q0-55.97 40.02-95.99Q228.04-833 284.52-833t95.98 40.01Q420-752.97 420-697v433q0 57.37-39.32 96.69Q341.36-128 283.98-128Z';

// Simple helpers (duplicated to keep the file standalone)
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function meanSquaredDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - b[i].x;
    const dy = a[i].y - b[i].y;
    s += dx * dx + dy * dy;
  }
  return s / (a.length || 1);
}

function circularShift(arr, k) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[(i + k) % n];
  return out;
}

function reversed(arr) { return arr.slice().reverse(); }

function computeBreaks(points, isPause) {
  if (!isPause || !points || points.length < 4) return [];

  // Detect discontinuities by looking at large jumps between consecutive samples
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const n = points.length;

  const dists = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    dists[i] = Math.hypot(dx, dy);
  }

  // Threshold tuned to catch subpath jumps but ignore normal edge steps
  const threshold = Math.max(diag * 0.18, 12);

  const candidates = [];
  for (let i = 1; i < n; i++) if (dists[i] > threshold) candidates.push({ i, d: dists[i] });
  candidates.sort((a, b) => b.d - a.d);

  const breaks = [];
  const minGap = Math.max(4, Math.floor(n * 0.02));
  for (const c of candidates) {
    if (breaks.some((b) => Math.abs(b - c.i) < minGap)) continue;
    breaks.push(c.i);
    // We only expect one break for a pause icon (two bars), but keep it generic
    if (breaks.length >= 4) break;
  }

  return breaks.sort((a, b) => a - b);
}

// This is the core logic for finding the best way to map the points
// of one shape onto another to minimize travel distance during morphing.
function findBestAlignment(from, to) {
  let bestScore = Infinity;
  let bestAligned = from;

  const candidates = [from, reversed(from)];
  for (const cand of candidates) {
    for (let k = 0; k < cand.length; k++) {
      const shifted = circularShift(cand, k);
      const score = meanSquaredDistance(shifted, to);
      if (score < bestScore) {
        bestScore = score;
        bestAligned = shifted;
      }
    }
  }
  return bestAligned;
}

function useCanonicalAlignment(playPoints, pausePoints) {
  return useMemo(() => {
    if (!playPoints || !pausePoints) return { playAligned: null, pauseAligned: null };

    // Find the best way to map pause points onto play points
    const pauseAligned = findBestAlignment(pausePoints, playPoints);

    // For the reverse, we don't need to search again. We can apply the *inverse*
    // of the transformation we found above. This guarantees stability.
    const playAligned = findBestAlignment(playPoints, pauseAligned);

    return { playAligned, pauseAligned };

  }, [playPoints, pausePoints]);
}

function pointsToPath(points, breaks = [], isPause = false) {
  if (!points || points.length === 0) return '';
  const n = points.length;

  const segments = [];
  if (isPause && breaks.length > 0) {
    let starts = [0, ...breaks.filter((i) => i > 0 && i < n)].sort((a, b) => a - b);
    let ends = [...starts.slice(1), n];
    for (let s = 0; s < starts.length; s++) {
      const a = starts[s];
      const b = ends[s];
      if (b - a >= 3) segments.push([a, b, true]); // Close these segments
    }
  } else {
    segments.push([0, n, true]); // A single, closed path
  }

  const cmds = [];
  for (const [a, b, shouldClose] of segments) {
    cmds.push(`M ${points[a].x} ${points[a].y}`);
    for (let i = a + 1; i < b; i++) cmds.push(`L ${points[i].x} ${points[i].y}`);
    if (shouldClose) cmds.push('Z');
  }
  return cmds.join(' ');
}

function usePathSampler(playD, pauseD, samples) {
  const playRef = useRef(null);
  const pauseRef = useRef(null);
  const [playPoints, setPlayPoints] = useState(null);
  const [pausePoints, setPausePoints] = useState(null);
  const hidden = (
    <svg viewBox={VIEW_BOX} width={0} height={0} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} aria-hidden>
      <path ref={playRef} d={playD} />
      <path ref={pauseRef} d={pauseD} />
    </svg>
  );
  useLayoutEffect(() => {
    const p1 = playRef.current; const p2 = pauseRef.current;
    if (!p1 || !p2) return;
    const sample = (pathEl) => {
      const len = pathEl.getTotalLength();
      const pts = [];
      for (let i = 0; i < samples; i++) {
        const t = (i / samples) * len;
        const { x, y } = pathEl.getPointAtLength(t);
        pts.push({ x: +x.toFixed(2), y: +y.toFixed(2) });
      }
      return pts;
    };
    setPlayPoints(sample(p1));
    setPausePoints(sample(p2));
  }, [samples]);
  return { hiddenDefs: hidden, playPoints, pausePoints };
}

// Critically damped spring-ish interpolation with a tiny overshoot
function springInterpolation(t) {
  // Damped harmonic motion: e^{-d t} (cos(w t) + (d/w) sin(w t))
  // Choose parameters for subtle overshoot
  const damping = 7; // higher = less bounce
  const freq = 10; // lower = softer spring
  const exp = Math.exp(-damping * t);
  return 1 - exp * (Math.cos(freq * t) + (damping / freq) * Math.sin(freq * t));
}

export default function PlayPauseMorphType2({
  playing: controlledPlaying,
  onToggle,
  size = 48,
  color = 'currentColor',
  duration = 950, // even slower, for a gentler morph
  samples = 220,
  title = 'Play/Pause',
  className,
  style,
}) {
  const isControlled = typeof controlledPlaying === 'boolean';
  const [uncontrolledPlaying, setUncontrolledPlaying] = useState(false);
  const playing = isControlled ? controlledPlaying : uncontrolledPlaying;

  const { hiddenDefs, playPoints, pausePoints } = usePathSampler(PLAY_D, PAUSE_D, samples);
  const { playAligned, pauseAligned } = useCanonicalAlignment(playPoints, pausePoints);

  const [renderPts, setRenderPts] = useState(null);
  const [currentBreaks, setCurrentBreaks] = useState([]);
  const animRef = useRef(null);
  const [pulse, setPulse] = useState(0); // 0..1 recent toggle pulse

  // Set initial state without animation
  useEffect(() => {
    if (!playAligned || !pauseAligned) return;
    const initPts = playing ? pauseAligned : playAligned;
    setRenderPts(initPts);
    setCurrentBreaks(computeBreaks(initPts, playing));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playAligned, pauseAligned]);

  // Respond to playing change, kick off animation
  useEffect(() => {
    if (!playAligned || !pauseAligned || !renderPts) return;

    const from = playing ? playAligned : pauseAligned;
    const to = playing ? pauseAligned : playAligned;

    const animState = { from, to, start: performance.now(), duration };
    setCurrentBreaks(computeBreaks(to, playing));

    if (animRef.current) cancelAnimationFrame(animRef.current);

    const tick = (now) => {
      const { from, to, start, duration } = animState;
      const t = Math.min(1, (now - start) / duration);
      const e = springInterpolation(t);

      const next = from.map((p, i) => ({
        x: p.x + (to[i].x - p.x) * e,
        y: p.y + (to[i].y - p.y) * e,
      }));

      setRenderPts(next);

      if (t < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        // Final state
        setRenderPts(to);
        setCurrentBreaks(computeBreaks(to, playing));
      }
    };

    animRef.current = requestAnimationFrame(tick);

    // Pulse animation
    const t0 = performance.now();
    const PULSE_MS = 650;
    let pulseRaf;
    const pulseTick = (now) => {
      const tt = Math.min(1, (now - t0) / PULSE_MS);
      setPulse(1 - easeOutCubic(tt));
      if (tt < 1) pulseRaf = requestAnimationFrame(pulseTick);
    };
    pulseRaf = requestAnimationFrame(pulseTick);

    return () => {
      if (pulseRaf) cancelAnimationFrame(pulseRaf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playAligned, pauseAligned, duration]);

  // Click handler
  const handleClick = useCallback(() => {
    if (onToggle) onToggle();
    if (!isControlled) setUncontrolledPlaying((p) => !p);
  }, [onToggle, isControlled]);

  const pathD = useMemo(() => pointsToPath(renderPts || [], currentBreaks, playing), [renderPts, currentBreaks, playing]);

  // Visual transforms for playful feel
  const rot = useMemo(() => (playing ? 3 : -3), [playing]); // degrees
  const scale = useMemo(() => 1 + pulse * 0.06, [pulse]);
  const stroke = useMemo(() => (playing ? color : color), [playing, color]);
  const strokeWidth = useMemo(() => 28 + pulse * 6, [pulse]);

  // Pulse ring visual params (in viewBox coords roughly 960 square)
  const baseRadius = 320; // tuned for icon
  const ringR = baseRadius + pulse * 120;
  const ringOpacity = 0.35 * pulse;

  return (
    <div
      role="button"
      aria-label={title}
      onClick={handleClick}
      style={{ display: 'inline-flex', cursor: 'pointer', lineHeight: 0, ...style }}
      className={className}
      title={title}
    >
      {hiddenDefs}
      <svg
        viewBox={VIEW_BOX}
        width={size}
        height={size}
        style={{ display: 'block' }}
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* Pulse ring */}
        <g opacity={ringOpacity}>
          <circle cx={480} cy={-480} r={ringR} fill="none" stroke={color} strokeWidth={8} />
        </g>

        {/* Icon with transform and hybrid stroke/fill style */}
        <g style={{ transformOrigin: '480px -480px' }} transform={`rotate(${rot}) scale(${scale})`}>
          <path d={pathD} fill={color} fillOpacity={0.75} />
          <path d={pathD} fill="none" stroke={stroke} strokeLinejoin="round" strokeLinecap="round" strokeWidth={strokeWidth} />
        </g>
      </svg>
    </div>
  );
}

