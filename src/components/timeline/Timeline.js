import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';

const GUTTER_PX = 100; // keep in sync with .track-label width

const RULER_PX = 24;
const ROW_H = 48;

// Default tracks used to initialize state; tracks are now user-managed
const DEFAULT_TRACKS = [
  { id: 't1', label: 'Track 1' },
  { id: 't2', label: 'Track 2' },
  { id: 't3', label: 'Track 3' },
  { id: 't4', label: 'Track 4' },
];

/**
 * Timeline v1.1
 * - Ruler + draggable playhead (scrub)
 * - User-managed universal tracks (add/reorder)
 * - Add clips; drag-to-move; edge-trim (L/R handles)
 * - Connected to Remotion via onSeek while interacting
 */
export default function Timeline({ currentTimeSec = 0, durationSec = 0, onSeek, clips: externalClips, onClipsChange }) {
  const scrollRef = useRef(null);
  const [tracks, setTracks] = useState(DEFAULT_TRACKS);
  const [internalClips, setInternalClips] = useState([]); // {id, trackId, startMs, endMs, kind, label}
  const allClips = externalClips ?? internalClips;
  const setClipsSafe = useCallback((updater) => {
    const prev = allClips;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (onClipsChange) onClipsChange(next); else setInternalClips(next);
  }, [allClips, onClipsChange]);
  const [zoomScale, setZoomScale] = useState(1); // 1 = fit to full duration
  const [viewportPx, setViewportPx] = useState(800);
  const [panSec, setPanSec] = useState(0);
  const [drag, setDrag] = useState(null); // {type:'move'|'trim-left'|'trim-right'|'scrub'|'pan', clipId?, offsetMs?, startX?, startPanSec?}
  const [ghostTimeSec, setGhostTimeSec] = useState(null); // local preview of playhead during interactions

  // rAF-throttled seek to avoid flooding Remotion
  const seekRaf = useRef(0);
  const seekLastSec = useRef(null);
  const scheduleSeek = useCallback((sec) => {
    seekLastSec.current = sec;
    if (seekRaf.current) return;
    seekRaf.current = requestAnimationFrame(() => {
      const v = seekLastSec.current;
      seekRaf.current = 0;
      if (typeof onSeek === 'function' && typeof v === 'number') onSeek(v);
    });
  }, [onSeek]);

  const fitPxPerSec = useMemo(() => (durationSec > 0 && viewportPx > 0) ? (viewportPx / durationSec) : 100, [viewportPx, durationSec]);
  const pxPerSec = fitPxPerSec * zoomScale;
  const viewportSec = useMemo(() => (pxPerSec > 0 ? viewportPx / pxPerSec : 0), [viewportPx, pxPerSec]);
  const labelStep = useMemo(() => Math.max(1, Math.ceil(80 / pxPerSec)), [pxPerSec]);
  const visibleLabels = useMemo(() => {
    const step = labelStep;
    const start = Math.max(0, Math.floor((panSec || 0) / step) * step);
    const end = Math.min(durationSec || 0, (panSec || 0) + (viewportSec || 0));
    const arr = [];
    for (let s = start; s <= end; s += step) arr.push(s);
    return arr;
  }, [labelStep, panSec, viewportSec, durationSec]);

  // Snapping helpers (outside of other hooks)
  const gridStepSec = useMemo(() => {
    const p = pxPerSec;
    if (p > 400) return 0.1;
    if (p > 200) return 0.25;
    if (p > 120) return 0.5;
    if (p > 60) return 1;
    if (p > 30) return 2;
    if (p > 15) return 5;
    return 10;
  }, [pxPerSec]);
  const snapThresholdSec = useMemo(() => 8 / Math.max(1, pxPerSec), [pxPerSec]);
  const snapTo = useCallback((targetSec, trackId, excludeId) => {
    const candidates = [];
    if (gridStepSec > 0) candidates.push(Math.round(targetSec / gridStepSec) * gridStepSec);
    (allClips || []).forEach((c) => {
      if (c.id === excludeId) return;
      // Snap to any clip edge (cross-track snapping is useful)
      candidates.push((c.startMs || 0) / 1000);
      candidates.push((c.endMs || 0) / 1000);
    });
    let best = targetSec;
    let bestDist = Infinity;
    for (const s of candidates) {
      const d = Math.abs(s - targetSec);
      if (d < bestDist && d <= snapThresholdSec) {
        best = s; bestDist = d;
      }
    }
    return best;
  }, [allClips, gridStepSec, snapThresholdSec]);



  // Measure viewport width to keep timeline fit without horizontal scroll
  useEffect(() => {
    const el = scrollRef.current; if (!el) return;
    const update = () => setViewportPx(Math.max(0, (el.clientWidth || 0) - GUTTER_PX));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep pan within bounds when zoom/duration/viewport changes
  useEffect(() => {
    const maxPan = Math.max(0, (durationSec || 0) - viewportSec);
    setPanSec((p) => clamp(p, 0, maxPan));
  }, [durationSec, viewportSec]);
  // Track management
  const addTrack = useCallback(() => {
    setTracks((prev) => {
      const n = prev.length + 1;
      return prev.concat({ id: `t${n}`, label: `Track ${n}` });
    });
  }, []);
  const moveTrack = useCallback((trackId, delta) => {
    setTracks((prev) => {
      const i = prev.findIndex(t => t.id === trackId);
      if (i < 0) return prev;
      const j = Math.max(0, Math.min(prev.length - 1, i + delta));
      if (i === j) return prev;
      const arr = prev.slice();
      const [item] = arr.splice(i, 1);
      arr.splice(j, 0, item);
      return arr;
    });
  }, []);




  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const timeFromClientX = useCallback((clientX) => {
    const el = scrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left - GUTTER_PX;
    const t = panSec + (x / pxPerSec);
    return clamp(t, 0, durationSec || 0);
  }, [pxPerSec, durationSec, panSec]);

  const handleSeekAtEvent = useCallback((e) => {
    const seconds = timeFromClientX(e.clientX);
    setGhostTimeSec(seconds);
    scheduleSeek(seconds);
  }, [scheduleSeek, timeFromClientX]);

  const addClip = (kind) => {
    const startMs = Math.round((currentTimeSec || 0) * 1000);
    const endMs = startMs + 3000; // 3s

    setClipsSafe((prev) => prev.concat({
      id: `${kind}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
      trackId: (tracks[0]?.id) || 't1',
      startMs,
      endMs,
      kind,
      label: kind.charAt(0).toUpperCase() + kind.slice(1)
    }));
  };

  // Global move/trim/scrub handlers
  useEffect(() => {
    if (!drag) return;
    const onMove = (e) => {
      if (drag.type === 'pan') {
        const dx = e.clientX - (drag.startX || 0);
        const newPan = (drag.startPanSec || 0) - (dx / pxPerSec);
        const maxPan = Math.max(0, (durationSec || 0) - viewportSec);
        setPanSec(clamp(newPan, 0, maxPan));
        return;
      }
      if (drag.type === 'scrub') {
        const s = timeFromClientX(e.clientX);
        scheduleSeek(s);
        return;
      }
      setClipsSafe((prev) => prev.map((c) => {
        if (c.id !== drag.clipId) return c;
        const pointerS = timeFromClientX(e.clientX);
        const pointerMs = Math.round(pointerS * 1000);
        const minLen = 100; // 0.1s
        if (drag.type === 'move') {
          const dur = c.endMs - c.startMs;
          const rawStartMs = pointerMs - drag.offsetMs;
          const rect = scrollRef.current?.getBoundingClientRect();
          let newTrackId = c.trackId;
          if (rect) {
            const yRel = e.clientY - rect.top - RULER_PX;
            const idx = Math.max(0, Math.min(tracks.length - 1, Math.floor(yRel / ROW_H)));
            newTrackId = tracks[idx]?.id || newTrackId;
          }
          // snapping: to grid & neighbor edges
          let newStartSec = snapTo(Math.max(0, rawStartMs/1000), newTrackId, c.id);
          let newStart = Math.round(newStartSec * 1000);
          newStart = Math.max(0, Math.min(newStart, Math.max(0, Math.round((durationSec||0)*1000) - dur)));
          const newEnd = newStart + dur;
          scheduleSeek(newStart/1000);
          return { ...c, startMs: newStart, endMs: newEnd, trackId: newTrackId };
        }
        if (drag.type === 'trim-left') {
          const snappedSec = snapTo(Math.max(0, pointerMs/1000), c.trackId, c.id);
          let ns = Math.round(Math.max(0, Math.min(snappedSec*1000, c.endMs - minLen)));
          const s = ns/1000; setGhostTimeSec(s); scheduleSeek(s);
          return { ...c, startMs: ns };
        }
        if (drag.type === 'trim-right') {
          const snappedSec = snapTo(Math.max(0, pointerMs/1000), c.trackId, c.id);
          let ne = Math.round(Math.max(c.startMs + minLen, Math.min(snappedSec*1000, Math.round((durationSec||0)*1000))));
          const s = ne/1000; setGhostTimeSec(s); scheduleSeek(s);
          return { ...c, endMs: ne };
        }
        return c;
      }));
    };
    const onUp = () => { setDrag(null); setGhostTimeSec(null); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag, onSeek, timeFromClientX, durationSec, pxPerSec, viewportSec]);

  return (
    <div className="timeline-container">
      <div className="timeline-toolbar">
        <div className="left">
          <button className="tl-btn" onClick={() => addClip('text')}>+ Text</button>
          <button className="tl-btn" onClick={() => addClip('music')}>+ Music</button>
          <button className="tl-btn" onClick={() => addClip('image')}>+ Image</button>
          <button className="tl-btn" onClick={() => addClip('video')}>+ Video</button>
          <button className="tl-btn" onClick={addTrack}>+ Track</button>
        </div>
        <div className="right">
          <button className="tl-btn" onClick={() => setZoomScale((z) => Math.max(1, z/1.5))}>-</button>
          <span className="zoom-label">{(zoomScale*100).toFixed(0)}%</span>
          <button className="tl-btn" onClick={() => setZoomScale((z) => Math.min(64, z*1.5))}>+</button>
        </div>
      </div>

      <div
        className="timeline-scroll"
        ref={scrollRef}
        onMouseDown={(e) => {
          if (e.altKey) {
            e.preventDefault();
            setDrag({ type: 'pan', startX: e.clientX, startPanSec: panSec });
          } else {
            setDrag({ type: 'scrub' });
            handleSeekAtEvent(e);
          }
        }}
        onWheel={(e) => {
          const el = scrollRef.current; if (!el) return;
          const rect = el.getBoundingClientRect();
          const x = e.clientX - rect.left;
          if (e.ctrlKey) {
            e.preventDefault();
            const anchorSec = panSec + (x / pxPerSec);
            const factor = e.deltaY > 0 ? (1/1.1) : 1.1;
            const newZoom = clamp(zoomScale * factor, 1, 64);
            const newPxPerSec = fitPxPerSec * newZoom;
            const newViewportSec = viewportPx / newPxPerSec;
            let newPan = anchorSec - (x / newPxPerSec);
            const maxPan = Math.max(0, (durationSec || 0) - newViewportSec);
            newPan = clamp(newPan, 0, maxPan);
            setZoomScale(newZoom);
            setPanSec(newPan);
          } else if (e.shiftKey || e.altKey) {
            e.preventDefault();
            const deltaSec = (e.deltaY * 0.5) / pxPerSec;
            const maxPan = Math.max(0, (durationSec || 0) - viewportSec);
            setPanSec((p) => clamp(p + deltaSec, 0, maxPan));
          }
        }}
        onClick={handleSeekAtEvent}
      >
        <div className="timeline-content" style={{ width: '100%' }}>
          {/* Ruler */}
          <div className="timeline-ruler">
            {visibleLabels.map((s) => (
              <div key={s} className="time-label" style={{ left: GUTTER_PX + ((s - panSec) * pxPerSec) }}>
                {Math.floor(s)}s
              </div>
            ))}
          </div>

          {/* Tracks */}
          <div className="timeline-tracks">
            {tracks.map((track, idx) => (
              <div className="track-row" key={track.id}>
                <div className="track-label">
                  <span>{track.label}</span>
                  <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 11 }}>#{idx+1}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button title="Move up" className="tl-btn" onClick={(e)=>{e.stopPropagation(); moveTrack(track.id, -1);}}>↑</button>
                    <button title="Move down" className="tl-btn" onClick={(e)=>{e.stopPropagation(); moveTrack(track.id, 1);}}>↓</button>
                  </div>
                </div>
                <div className="track-lane">
                  {allClips.filter(c => c.trackId === track.id).map((clip) => {
                    const left = ((clip.startMs / 1000) - panSec) * pxPerSec;
                    const width = Math.max(6, ((clip.endMs - clip.startMs) / 1000) * pxPerSec);
                    return (
                      <div
                        key={clip.id}
                        className={`clip clip-${clip.kind}`}
                        style={{ left, width }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const pointerS = timeFromClientX(e.clientX);
                          const offsetMs = Math.round(pointerS*1000) - clip.startMs;
                          setDrag({ type: 'move', clipId: clip.id, offsetMs });
                        }}
                      >
                        <div
                          className="clip-handle left"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDrag({ type: 'trim-left', clipId: clip.id });
                          }}
                        />
                        <span className="clip-label">{clip.label}</span>
                        <div
                          className="clip-handle right"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDrag({ type: 'trim-right', clipId: clip.id });
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Playhead */}
          <div className="playhead" style={{ left: GUTTER_PX + (((ghostTimeSec ?? currentTimeSec) || 0) - panSec) * pxPerSec }} />
        </div>
      </div>
    </div>
  );
}

