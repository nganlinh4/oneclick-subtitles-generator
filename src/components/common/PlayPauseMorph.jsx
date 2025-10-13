import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import PlayPauseMorphType2 from './PlayPauseMorphType2';


/**
 * PlayPauseMorph
 *
 * A dependency-free SVG morphing component that intelligently morphs between
 * the provided Play and Pause paths by:
 *  - Sampling each source path into N equidistant points along arc-length
 *  - Aligning the target to the source via MSE-based circular shift (with centroid-centering)
 *  - Interpolating points with requestAnimationFrame and easing
 *
 * Props:
 *  - playing?: boolean (controlled). If omitted, component is self-controlled on click
 *  - onToggle?: () => void (called on click)
 *  - size?: number (px) default 48
 *  - color?: string default 'currentColor'
 *  - duration?: number (ms) default 350
 *  - samples?: number (N points) default 200
 */

const VIEW_BOX = '0 -960 960 960';

// Provided paths
const PLAY_D = 'M275-248v-464q0-29.85 20.64-48.92Q316.29-780 343.48-780q8.68 0 18.1 2.5Q371-775 380-770l365 233q16.5 9 24.25 24.84T777-480q0 16.32-8 32.16Q761-432 745-423L380-190q-9 5-18.64 7.5t-18.22 2.5q-26.85 0-47.5-19.08Q275-218.15 275-248Z';
const PAUSE_D = 'M675.48-128q-56.48 0-95.98-39.31Q540-206.63 540-264v-433q0-55.97 39.32-95.99Q618.64-833 676.02-833 732-833 772-792.99q40 40.02 40 95.99v433q0 57.37-40.02 96.69Q731.96-128 675.48-128Zm-391.5 0Q228-128 188-167.31q-40-39.32-40-96.69v-433q0-55.97 40.02-95.99Q228.04-833 284.52-833t95.98 40.01Q420-752.97 420-697v433q0 57.37-39.32 96.69Q341.36-128 283.98-128Z';

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function pointsToPath(points, breaks = []) {
  if (!points || points.length === 0) return '';
  const n = points.length;
  let starts = [0, ...breaks.filter((i) => i > 0 && i < n)].sort((a, b) => a - b);
  let ends = [...starts.slice(1), n];

  // Build segments and keep only those with 3+ points
  const segments = [];
  for (let s = 0; s < starts.length; s++) {
    const a = starts[s];
    const b = ends[s];
    if (b - a >= 3) segments.push([a, b]);
  }

  // Fallback: if no usable segments, draw a single loop to avoid invisibility
  if (segments.length === 0) segments.push([0, n]);

  const cmds = [];
  for (const [a, b] of segments) {
    cmds.push(`M ${points[a].x} ${points[a].y}`);
    for (let i = a + 1; i < b; i++) cmds.push(`L ${points[i].x} ${points[i].y}`);
    cmds.push('Z');
  }
  return cmds.join(' ');
}

function centroid(points) {
  let sx = 0, sy = 0;
  for (const p of points) { sx += p.x; sy += p.y; }
  const n = points.length || 1;
  return { x: sx / n, y: sy / n };
}

function meanSquaredDistance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const dx = a[i].x - b[i].x;
    const dy = a[i].y - b[i].y;
    s += dx * dx + dy * dy;
  }
  return s / a.length;
}

function computeBreaks(points) {
  if (!points || points.length < 2) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const n = points.length;
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const threshold = Math.max(16, diag * 0.25); // be conservative to avoid over-splitting
  const dists = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    dists[i] = Math.hypot(dx, dy);
  }
  // Candidate break indices by size
  const candidates = [];
  for (let i = 1; i < n; i++) if (dists[i] > threshold) candidates.push({ i, d: dists[i] });
  candidates.sort((a, b) => b.d - a.d);

  const maxBreaks = 8;
  const minGap = 4; // ensure distance between breaks so segments have enough points
  const selected = [];
  for (const c of candidates) {
    if (selected.length >= maxBreaks) break;
    if (selected.some(s => Math.abs(s - c.i) < minGap)) continue;
    selected.push(c.i);
  }
  return selected.sort((a, b) => a - b);
}

function circularShift(arr, k) {
  const n = arr.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[(i + k) % n];
  return out;
}

function reversed(arr) {
  const out = arr.slice().reverse();
  return out;
}



// ---------- MSE-based circular shift alignment (with centroid-centering) ----------
function bestAlignType1(target, reference) {
  if (!target || !reference || target.length !== reference.length) return target || reference;

  const refC = centroid(reference);
  const refN = reference.map((p) => ({ x: p.x - refC.x, y: p.y - refC.y }));

  let bestScore = Infinity;
  let bestShift = 0;
  let bestIsReversed = false;

  const candidates = [target, reversed(target)];

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const candC = centroid(cand);
    const candN = cand.map((p) => ({ x: p.x - candC.x, y: p.y - candC.y }));
    for (let k = 0; k < candN.length; k++) {
      const shiftedN = circularShift(candN, k);
      const score = meanSquaredDistance(refN, shiftedN);
      if (score < bestScore) {
        bestScore = score;
        bestShift = k;
        bestIsReversed = (i === 1);
      }
    }
  }

  const finalCand = bestIsReversed ? candidates[1] : candidates[0];
  return circularShift(finalCand, bestShift);
}




function usePathSampler(playD, pauseD, samples) {
  const playRef = useRef(null);
  const pauseRef = useRef(null);
  const [playPoints, setPlayPoints] = useState(null);
  const [pausePoints, setPausePoints] = useState(null);

  // Create offscreen SVG paths for measuring
  const hidden = (
    <svg viewBox={VIEW_BOX} width={0} height={0} style={{ position: 'absolute', width: 0, height: 0, opacity: 0 }} aria-hidden>
      <path ref={playRef} d={playD} />
      <path ref={pauseRef} d={pauseD} />
    </svg>
  );

  useLayoutEffect(() => {
    const p1 = playRef.current;
    const p2 = pauseRef.current;
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



function PlayPauseMorphType1({
  playing: controlledPlaying,
  onToggle,
  size = 48,
  color = 'currentColor',
  duration = 350,
  samples = 200,
  title = 'Play/Pause',
  className,
  style,
}) {
  const isControlled = typeof controlledPlaying === 'boolean';
  const [uncontrolledPlaying, setUncontrolledPlaying] = useState(false);
  const playing = isControlled ? controlledPlaying : uncontrolledPlaying;

  const { hiddenDefs, playPoints, pausePoints } = usePathSampler(PLAY_D, PAUSE_D, samples);
  const [renderPts, setRenderPts] = useState(null);
  const [currentBreaks, setCurrentBreaks] = useState([]);
  const animRef = useRef(null);
  const animState = useRef({ from: null, to: null, start: 0, duration, breaks: [] });

  useEffect(() => {
    if (!playPoints || !pausePoints) return;
    const init = playing ? bestAlignType1(pausePoints, playPoints) : playPoints;
    setRenderPts(init);
    setCurrentBreaks(computeBreaks(init));
  }, [playPoints, pausePoints, playing]);

  const startAnim = useCallback((toTarget) => {
    if (!toTarget) return;
    const align = (fromRef) => bestAlignType1(toTarget, fromRef);
    if (!renderPts) {
      const snap = align(toTarget);
      setRenderPts(snap);
      setCurrentBreaks(computeBreaks(snap));
      return;
    }
    const from = renderPts;
    const to = align(from);
    animState.current = { from, to, start: performance.now(), duration, breaks: computeBreaks(from) };
    if (animRef.current) cancelAnimationFrame(animRef.current);
    const tick = (now) => {
      const { from, to, start, duration } = animState.current;
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);
      const next = from.map((p, i) => ({ x: p.x + (to[i].x - p.x) * e, y: p.y + (to[i].y - p.y) * e }));
      setRenderPts(next);
      if (t < 1) {
        animRef.current = requestAnimationFrame(tick);
      } else {
        setCurrentBreaks(computeBreaks(next));
      }
    };
    animRef.current = requestAnimationFrame(tick);
  }, [renderPts, duration]);

  useEffect(() => {
    if (!playPoints || !pausePoints || !renderPts) return;
    const target = playing ? pausePoints : playPoints;
    startAnim(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playPoints, pausePoints]);

  const handleClick = useCallback(() => {
    if (onToggle) onToggle();
    if (!isControlled) setUncontrolledPlaying((p) => !p);
  }, [onToggle, isControlled]);

  const pathD = useMemo(() => pointsToPath(renderPts || [], currentBreaks), [renderPts, currentBreaks]);

  return (
    <div role="button" aria-label={title} onClick={handleClick} style={{ display: 'inline-flex', cursor: 'pointer', lineHeight: 0, ...style }} className={className} title={title}>
      {hiddenDefs}
      <svg viewBox={VIEW_BOX} width={size} height={size} style={{ display: 'block' }} xmlns="http://www.w3.org/2000/svg">
        <path d={pathD} fill={color} fillRule="evenodd" />
      </svg>
    </div>
  );
}

export default function PlayPauseMorph(props) {
  const { morphType = 1, ...rest } = props;
  if (morphType === 2) {
    return <PlayPauseMorphType2 {...rest} />;
  }
  return <PlayPauseMorphType1 {...rest} />;
}
