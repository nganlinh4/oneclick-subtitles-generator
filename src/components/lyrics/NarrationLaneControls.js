import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { editNativeNarration } from '../../platform/nativeNarrationArtifacts';
import {
  getNativeNarrationArtifactId,
  isNativeNarrationResult,
} from '../../platform/nativeNarrationCapabilities';
import LiquidGlass from '../common/LiquidGlass';
import StandardSlider from '../common/StandardSlider';
import {
  arrangePlacement,
  computeAutoSpeed,
  placementToLyrics,
  resolvePlacements,
  PER_LINE_WEIGHT_DEFAULT,
} from './narrationLaneActions';

const SPEED_MIN = 0.5;
const SPEED_MAX = 2;
const SPEED_STEP = 0.05;
const formatSpeed = (v) => `${Number(v).toFixed(2)}×`;
const formatWeight = (v) => `${Math.round(Number(v) * 100)}%`;

/** Available window the narration must cover: last subtitle end minus the earliest clip start. */
const narrationWindow = (lyrics, segments) => {
  const ends = (lyrics || []).map((l) => l.end).filter(Number.isFinite);
  const starts = (segments || []).map((s) => s.start).filter(Number.isFinite);
  if (!ends.length || !starts.length) return 0;
  return Math.max(...ends) - Math.min(...starts);
};

/**
 * Narration-lane controls overlaid on the timeline, in the SGT-style staging workflow:
 *   [ ✨ Auto arrange ] [ ↕ Arrange ] [ speed ] [ per-line fit ] [ ⤓ Pull ] [ ↻ Reset ]
 *
 * Built from shared design-system primitives: a LiquidGlass pill, Material Symbols icons and
 * StandardSliders (like the volume pill).
 *
 * The lane is a staging track — everything here edits the staged placement / speeds WITHOUT moving
 * subtitles, until "Pull subtitles to narration" commits them (undoable) and refreshes playback.
 *  - Arrange: pack clips in order, allowing a small overlap. Placement only.
 *  - Auto arrange: pick a smart global speed (so the narration fits the video window) AND arrange
 *    AND turn on gentle per-line adaptive speed — the one-click "decide everything".
 *  - Speed slider: manual global speed. Per-line fit: how much each clip may speed up on its own.
 *
 * globalSpeed / placementStarts / perLineWeight are owned by the timeline (so the lane draw shares
 * them); per-line effective speeds are resolved from the three together.
 */
const NarrationLaneControls = ({
  narrationSegments,
  lyrics,
  onApplyTimings,
  globalSpeed = 1,
  setGlobalSpeed = () => {},
  placementStarts = null,
  setPlacementStarts = () => {},
  perLineWeight = 0,
  setPerLineWeight = () => {},
}) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [isSliderDragging, setIsSliderDragging] = useState(false);
  // onDragEnd fires after the final onChange with the prop still at its stale closure value, so we
  // commit audio from the latest values the sliders reported, not the props.
  const latestSpeedRef = useRef(globalSpeed);
  const latestWeightRef = useRef(perLineWeight);
  // Last "is anything staged?" value seen while NOT dragging — frozen during a drag (see render).
  const stagedRef = useRef(false);

  // Atempo every clip from its immutable backup, each to its own factor, then refresh playback.
  const applyAudioSpeeds = useCallback(async (speedForSeg) => {
    const segments = narrationSegments.filter((segment) => segment.filename);
    if (segments.length === 0) return;
    setBusy(true);
    try {
      const narrationResults = [
        ...(window.originalNarrations || []),
        ...(window.translatedNarrations || []),
        ...(window.groupedNarrations || []),
      ];
      const byArtifactId = new Map(narrationResults
        .filter(isNativeNarrationResult)
        .map((result) => [getNativeNarrationArtifactId(result), result]));
      for (const segment of segments) {
        const artifactId = getNativeNarrationArtifactId(segment);
        const source = byArtifactId.get(artifactId);
        if (!source) throw new Error('Native narration audio is unavailable');
        const replacement = await editNativeNarration(source, {
          normalizedStart: 0,
          normalizedEnd: 1,
          speedFactor: speedForSeg(segment),
        });
        window.dispatchEvent(new CustomEvent('native-narration-artifact-edited', {
          detail: { previousArtifactId: artifactId, result: replacement },
        }));
      }
      if (typeof window.resetAlignedNarration === 'function') window.resetAlignedNarration();
      window.dispatchEvent(new CustomEvent('narration-speed-modified', { detail: { source: 'timeline-speed', timestamp: Date.now() } }));
      // Regenerate the aligned narration so playback uses the new speeds (same as the refresh button).
      window.dispatchEvent(new CustomEvent('request-narration-refresh', { detail: { source: 'timeline-speed', timestamp: Date.now() } }));
    } catch {
      // non-fatal — leave the lane as-is on failure
    } finally {
      setBusy(false);
    }
  }, [narrationSegments]);

  // Apply the per-line effective speeds implied by a (placement, global speed, per-line weight).
  const applyResolvedAudio = useCallback(async (starts, speed, weight) => {
    const byId = new Map(resolvePlacements(narrationSegments, starts, speed, weight).map((p) => [p.id, p.speed]));
    await applyAudioSpeeds((seg) => byId.get(seg.id) ?? (speed || 1));
  }, [narrationSegments, applyAudioSpeeds]);

  // Global speed slider: live restage while dragging, commit audio on release.
  const handleSpeedChange = useCallback((value) => {
    latestSpeedRef.current = value;
    setGlobalSpeed(value);
  }, [setGlobalSpeed]);
  const handleSpeedCommit = useCallback(() => {
    setIsSliderDragging(false);
    applyResolvedAudio(placementStarts, latestSpeedRef.current, perLineWeight);
  }, [applyResolvedAudio, placementStarts, perLineWeight]);

  // Per-line fit slider: how much each clip may speed up on its own to fit its slot.
  const handleWeightChange = useCallback((value) => {
    latestWeightRef.current = value;
    setPerLineWeight(value);
  }, [setPerLineWeight]);
  const handleWeightCommit = useCallback(() => {
    setIsSliderDragging(false);
    applyResolvedAudio(placementStarts, globalSpeed, latestWeightRef.current);
  }, [applyResolvedAudio, placementStarts, globalSpeed]);

  // Arrange: stage a sequential placement (small allowed overlap) at the current speed. Placement only.
  const handleArrange = useCallback(() => {
    if (!narrationSegments.length) return;
    setPlacementStarts(arrangePlacement(narrationSegments, globalSpeed));
  }, [narrationSegments, globalSpeed, setPlacementStarts]);

  // Auto arrange: decide a smart global speed so the narration fits, arrange, and enable gentle
  // per-line adaptive speed — the one-click "do everything".
  const handleAutoArrange = useCallback(() => {
    if (!narrationSegments.length) return;
    const speed = computeAutoSpeed(narrationSegments, narrationWindow(lyrics, narrationSegments));
    const starts = arrangePlacement(narrationSegments, speed);
    latestSpeedRef.current = speed;
    latestWeightRef.current = PER_LINE_WEIGHT_DEFAULT;
    setGlobalSpeed(speed);
    setPerLineWeight(PER_LINE_WEIGHT_DEFAULT);
    setPlacementStarts(starts);
    applyResolvedAudio(starts, speed, PER_LINE_WEIGHT_DEFAULT);
  }, [narrationSegments, lyrics, setGlobalSpeed, setPerLineWeight, setPlacementStarts, applyResolvedAudio]);

  // Pull subtitles to narration: commit the staged placement (per-line speeds included) + refresh.
  const handlePull = useCallback(() => {
    if (!narrationSegments.length || typeof onApplyTimings !== 'function') return;
    onApplyTimings(placementToLyrics(lyrics, narrationSegments, placementStarts, globalSpeed, perLineWeight));
    setPlacementStarts(null); // subtitles now match the lane
    window.dispatchEvent(new CustomEvent('request-narration-refresh', { detail: { source: 'pull-subtitles', timestamp: Date.now() } }));
  }, [lyrics, narrationSegments, placementStarts, globalSpeed, perLineWeight, onApplyTimings, setPlacementStarts]);

  const handleReset = useCallback(() => {
    latestSpeedRef.current = 1;
    latestWeightRef.current = 0;
    setGlobalSpeed(1);
    setPerLineWeight(0);
    setPlacementStarts(null);
    applyResolvedAudio(null, 1, 0);
  }, [setGlobalSpeed, setPerLineWeight, setPlacementStarts, applyResolvedAudio]);

  if (!narrationSegments.length) return null;

  // Reset shows only when there's something to undo. Frozen while a slider is dragged so it doesn't
  // pop in/out mid-drag (and reflow the toolbar) — it settles on release.
  const liveStaged = (placementStarts && Object.keys(placementStarts).length > 0)
    || Math.abs(globalSpeed - 1) > 0.01 || perLineWeight > 0.001;
  if (!isSliderDragging) stagedRef.current = liveStaged;
  const showReset = stagedRef.current;

  return (
    <LiquidGlass
      width="auto"
      height={30}
      position="absolute"
      bottom="6px"
      left="8px"
      borderRadius="15px"
      className="narration-lane-controls theme-primary content-center"
      zIndex={6}
      effectIntensity={0.8}
      effectRadius={0.4}
      effectWidth={0.25}
      effectHeight={0.15}
      animateOnHover={true}
      hoverScale={1.03}
      aria-label={t('timeline.narrationLane', 'Narration lane controls')}
      style={{ transition: 'transform 0.2s ease, box-shadow 0.2s ease' }}
    >
      <div className="narration-lane-controls-row">
        <button
          type="button"
          className="narration-lane-btn"
          onClick={handleAutoArrange}
          disabled={busy}
          title={t('timeline.autoArrangeTip', 'Pick a smart narration speed and arrange so it fits the video timing — does everything in one click')}
        >
          <span className="material-symbols-rounded" aria-hidden="true">auto_awesome</span>
          {t('timeline.autoArrange', 'Auto arrange')}
        </button>

        <button
          type="button"
          className="narration-lane-btn"
          onClick={handleArrange}
          title={t('timeline.arrangeTip', 'Pack the clips on the lane in order, allowing a small overlap (no speed change)')}
        >
          <span className="material-symbols-rounded" aria-hidden="true">sort</span>
          {t('timeline.arrange', 'Arrange')}
        </button>

        <span className="narration-lane-divider" aria-hidden="true" />

        <div className="narration-lane-speed" title={t('timeline.narrationSpeedTip', 'Globally speed the narration audio (applies on release; 1.00× = natural)')}>
          <span className="material-symbols-rounded" aria-hidden="true">speed</span>
          <StandardSlider
            className="narration-lane-speed-slider"
            value={globalSpeed}
            onChange={handleSpeedChange}
            onDragStart={() => setIsSliderDragging(true)}
            onDragEnd={handleSpeedCommit}
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            size="XSmall"
            width="compact"
            state={busy ? 'Disabled' : 'Enabled'}
            showValueIndicator={false}
            showValueBadge
            valueBadgeFormatter={formatSpeed}
            ariaLabel={t('timeline.narrationSpeed', 'Narration speed')}
          />
          <span className="narration-lane-speed__value">{busy ? '…' : formatSpeed(globalSpeed)}</span>
        </div>

        <div className="narration-lane-speed" title={t('timeline.perLineFitTip', 'How much each clip may speed up on its own to fit its slot (small = gentle, keeps speech natural)')}>
          <span className="material-symbols-rounded" aria-hidden="true">tune</span>
          <StandardSlider
            className="narration-lane-speed-slider"
            value={perLineWeight}
            onChange={handleWeightChange}
            onDragStart={() => setIsSliderDragging(true)}
            onDragEnd={handleWeightCommit}
            min={0}
            max={1}
            step={0.05}
            size="XSmall"
            width="compact"
            state={busy ? 'Disabled' : 'Enabled'}
            showValueIndicator={false}
            showValueBadge
            valueBadgeFormatter={formatWeight}
            ariaLabel={t('timeline.perLineFit', 'Per-line fit')}
          />
          <span className="narration-lane-speed__value">{formatWeight(perLineWeight)}</span>
        </div>

        <span className="narration-lane-divider" aria-hidden="true" />

        <button
          type="button"
          className="narration-lane-btn"
          onClick={handlePull}
          disabled={busy}
          title={t('timeline.pullSubtitlesTip', 'Move the subtitle timings to match the narration lane, then refresh the narration')}
        >
          <span className="material-symbols-rounded" aria-hidden="true">download</span>
          {t('timeline.pullSubtitles', 'Pull subtitles to narration')}
        </button>

        {showReset && (
          <button
            type="button"
            className="narration-lane-btn"
            onClick={handleReset}
            disabled={busy}
            title={t('timeline.resetLaneTip', 'Restore natural speed and clear the staged arrangement')}
          >
            <span className="material-symbols-rounded" aria-hidden="true">restart_alt</span>
            {t('timeline.resetLane', 'Reset')}
          </button>
        )}
      </div>
    </LiquidGlass>
  );
};

export default NarrationLaneControls;
