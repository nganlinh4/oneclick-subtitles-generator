import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

const journey = read('journeys/timelineAdvancedEditing.journey.js');
const lyricItem = read('../src/components/lyrics/LyricItem.js');
const lyricsHeader = read('../src/components/lyrics/LyricsHeader.js');
const rangeActionBar = read('../src/components/lyrics/TimelineRangeActionBar.js');
const zoomControls = read('../src/components/lyrics/TimelineZoomControls.js');
const liquidGlass = read('../src/components/common/LiquidGlass.js');
const editorDrag = read('../src/hooks/useLyricsEditorDrag.js');
const editorHelpers = read('../src/hooks/useLyricsEditorHelpers.js');
const editorHook = read('../src/hooks/useLyricsEditor.js');
const timelineDomain = read('../src/components/lyrics/utils/timelineDomain.js');
const durableLyricsHistory = read('../src/platform/durableLyricsHistory.js');
const otherEditingJourney = read('journeys/editorCueCrudAndHistory.journey.js');
const boundaryJourney = read('journeys/timelineBoundary.journey.js');

test('every advanced control the journey drives is a real, shipped public control', () => {
  assert.match(lyricItem, /className=\{`time-control start-time/u);
  assert.match(lyricItem, /className=\{`time-control end-time/u);
  assert.match(lyricItem, /onMouseDown=\{\(e\) => onMouseDown\(e, index, 'start'\)\}/u);
  assert.match(lyricItem, /onMouseDown=\{\(e\) => onMouseDown\(e, index, 'end'\)\}/u);
  assert.match(journey, /\.time-control\.\$\{field === 'start' \? 'start-time' : 'end-time'\}/u);

  assert.match(lyricsHeader, /className=\{`sticky-toggle \$\{isSticky \? 'active' : ''\}`\}/u);
  assert.match(journey, /'\.sticky-toggle'/u);

  assert.match(rangeActionBar, /drag_indicator/u);
  assert.match(rangeActionBar, /onPointerDown=\{handleMovePointerDown\}/u);
  // The bar is a fixed three-button sequence (regenerate, clear, move); the journey's own comment
  // records why position is the only public way to reach the un-classed move handle.
  assert.match(rangeActionBar, /Regenerate subtitles/u);
  assert.match(rangeActionBar, /delete<\/span>/u);
  assert.match(journey, /range-action-bar button:nth-child\(3\)/u);
  assert.match(journey, /carries no class of its own/u);

  assert.match(liquidGlass, /className=\{`liquid-glass \$\{className\}`\}/u);
  assert.match(zoomControls, /aria-label=\{t\('timeline\.dragToZoom'/u);
  assert.match(journey, /'\.timeline-container > \.liquid-glass'/u);
});

test('the three boundary clamps the journey asserts are the ones the product actually implements', () => {
  assert.match(editorDrag, /newValue = Math\.max\(0, newValue\)/u);
  assert.match(editorDrag, /Math\.min\(duration \|\| 9999, newValue\)/u);
  assert.match(editorHelpers, /Math\.max\(0, l\.start \+ delta\)/u);
  assert.match(timelineDomain, /domain\.selectableEnd - boundedRange\.end/u);
  assert.match(journey, /clamps to zero/u);
  assert.match(journey, /clamp.*to real media duration|clamp exactly to duration/isu);
  // Duration must come from the real <video>, never a guessed constant.
  assert.match(journey, /video\.duration/u);
  assert.doesNotMatch(journey, /duration\s*=\s*19/u);

  // The cascade's own delta clamp (once the unclamped gap this journey used to leave unproven):
  // the shared cascade delta reuses clampTimelineMoveDelta, the same helper the range move uses,
  // rather than flooring/ceiling each cascaded cue independently.
  assert.match(editorDrag, /import \{ clampTimelineMoveDelta \} from '\.\.\/components\/lyrics\/utils\/timelineDomain'/u);
  assert.match(editorDrag, /isSticky && delta > 0/u);
  assert.match(journey, /CASCADE_BOUNDARY_OVERSHOOT_SECONDS/u);
  assert.match(journey, /cascade boundary clamp/u);
  assert.match(journey, /did not clamp exactly to duration/u);
});

test('sticky cascade is exercised deliberately, starting from the product\'s own default-on state', () => {
  assert.match(editorHook, /const \[isSticky, setIsSticky\] = useState\(true\)/u);
  assert.doesNotMatch(journey, /useState\(true\)/u);
  assert.match(journey, /sticky timing is not on by default/u);
  assert.match(editorDrag, /i > index && isSticky/u);
  assert.match(journey, /cascade applies only to cues after the one being dragged/u);
});

test('undo/redo is walked across a MIXED sequence with revision reasons read from SQLite', () => {
  assert.match(durableLyricsHistory, /TIMING_DRAG: 'timing drag'/u);
  assert.match(durableLyricsHistory, /MOVE_RANGE: 'move range'/u);
  assert.match(durableLyricsHistory, /LYRICS_EDITOR_REVISION_PREFIX = 'OSG lyrics editor v1:'/u);
  assert.match(journey, /'OSG lyrics editor v1: timing drag'/u);
  assert.match(journey, /'OSG lyrics editor v1: move range'/u);
  assert.match(journey, /latestRevisionReason/u);
  const undoCalls = journey.match(/await undoTo\(/gu) ?? [];
  const redoCalls = journey.match(/await redoTo\(/gu) ?? [];
  assert.equal(undoCalls.length, 4, 'the journey must walk exactly four undos across the mixed sequence');
  assert.equal(redoCalls.length, 4, 'the journey must walk exactly four redos across the mixed sequence');
  assert.match(journey, /durableState/u);
  assert.match(journey, /\.cues/u);
});

test('the journey targets its own advanced-editing ground, not the already-green CRUD or boundary journeys', () => {
  // editorCueCrudAndHistory already owns insert/delete/merge/split/save/checkpoint/reset.
  for (const control of [
    '.insert-lyric-button', '.merge-lyrics-button', '.split-sub-btn', '.empty-insert-lyric-btn',
    '.lyrics-save-btn', '.checkpoint-btn', '.reset-btn', '.delete-lyric-btn', '.edit-lyric-btn',
  ]) {
    assert.ok(otherEditingJourney.includes(control), `fixture check: ${control} is owned by editorCueCrudAndHistory`);
    assert.doesNotMatch(journey, new RegExp(control.replace('.', '\\.'), 'u'), (
      `timelineAdvancedEditing duplicates the already-covered control ${control}`
    ));
  }
  // timelineBoundary already owns Ctrl+A-then-delete-everything and ASR-driven regeneration.
  assert.match(boundaryJourney, /ensureEngineReady/u);
  assert.doesNotMatch(journey, /ensureEngineReady/u);
  assert.doesNotMatch(journey, /generate-subtitles|process-subtitles/u);
  assert.doesNotMatch(journey, /\\uE009.*'a'.*\\uE000|ctrlKey.*key.*'a'/isu);
});

test('the journey is credential-free and never reaches a provider or native dialog', () => {
  assert.doesNotMatch(journey, /gemini|api[_-]?key|oauth|client[_-]?secret|bearer/iu);
  assert.doesNotMatch(journey, /__TAURI_INTERNALS__|invoke\(/u);
  assert.doesNotMatch(journey, /select_media|open_document|save_document|dialog_paths/u);
  assert.doesNotMatch(journey, /requestFullscreen|exitFullscreen/u);
});

test('evidence is bounded and every meaningful step is captured with a durable and a visible check', () => {
  const captures = journey.match(/captureWorkflowStep\(/gu) ?? [];
  assert.ok(captures.length >= 6 && captures.length <= 10, (
    `expected a bounded 6-10 workflow steps, found ${captures.length}`
  ));
  assert.match(journey, /waitForDurableCueRecords/u);
  assert.match(journey, /visibleCueTexts/u);
  assert.match(journey, /assertUnchanged/u);
  assert.match(journey, /boundedErrors/u);
});
