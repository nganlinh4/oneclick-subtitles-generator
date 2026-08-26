import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  ANIMATION_CASES,
  ANIMATION_EASING_VALUES,
  ANIMATION_TYPE_VALUES,
  MATERIAL_GROUPS,
} from './subtitleMaterialAnimationOracle.js';

const read = path => readFileSync(resolve(import.meta.dirname, '..', path), 'utf8');
const journey = read('journeys/subtitleMaterialAndAnimation.journey.js');
const nativeMediaOracle = read('support/nativeMediaOracle.js');
const presetButtons = read('../src/components/subtitleCustomization/PresetButtonsGrid.js');
const publicControls = [
  'TextControls.js',
  'BackgroundControls.js',
  'EffectsControls.js',
  'PositionControls.js',
  'AnimationControls.js',
].map(file => read(`../src/components/subtitleCustomization/${file}`)).join('\n');

test('pinned Node directly imports the canonical canvas animation maths', async () => {
  const module = await import('../../src/components/previews/canvas/canvasSubtitleMath.js');
  assert.equal(typeof module.activeCueAtFrom, 'function');
  assert.equal(typeof module.easeSubtitle, 'function');
});

test('material journey names every stable public control it claims to cover', () => {
  const selectors = MATERIAL_GROUPS.flatMap(group => group.actions.map(action => action.selector));
  for (const selector of [
    '#font-size-slider', '#subtitle-text-color', '#render-text-align', '#line-height-slider',
    '#letter-spacing-slider', '#render-text-transform', '#subtitle-background-color',
    '#background-opacity-slider', '#border-radius-slider', '#border-width-slider',
    '#subtitle-border-color', '#subtitle-border-style', '#text-shadow-enabled',
    '#subtitle-text-shadow-color', '#shadow-blur-slider', '#shadow-offset-slider',
    '#glow-enabled', '#subtitle-glow-color', '#glow-intensity-slider', '#gradient-enabled',
    '#subtitle-gradient-start-color', '#subtitle-gradient-end-color',
    '#subtitle-gradient-direction', '#stroke-enabled', '#subtitle-stroke-color',
    '#stroke-width-slider', '#subtitle-position', '#position-x-slider', '#position-y-slider',
    '#max-width-slider', '#margin-bottom-slider', '#margin-top-slider', '#margin-left-slider',
    '#margin-right-slider', '#fade-in-duration-slider', '#fade-out-duration-slider',
  ]) {
    assert.ok(selectors.includes(selector), `missing public control ${selector}`);
  }
  assert.match(presetButtons, /data-osg-preset=\{preset\}/u);
  assert.match(journey, /\[data-osg-preset="gaming"\]/u);
  const allSelectors = new Set([
    ...selectors,
    '#subtitle-animation-type',
    '#subtitle-animation-easing',
  ]);
  for (const selector of allSelectors) {
    assert.ok(selector.startsWith('#'));
    assert.ok(publicControls.includes(`id="${selector.slice(1)}"`), (
      `journey selector ${selector} is absent from the shipped customization controls`
    ));
  }
  assert.ok(MATERIAL_GROUPS[0].actions.some(action => action.token === 'align-justify'));
  assert.match(publicControls, /\{ value: 'justify'/u);
});

test('animation journey uses the exact ten-type and seven-easing public vocabularies', () => {
  assert.equal(ANIMATION_TYPE_VALUES.length, 10);
  assert.equal(ANIMATION_EASING_VALUES.length, 7);
  assert.equal(ANIMATION_CASES.length, 16);
  assert.equal(ANIMATION_CASES.filter(item => item.sweep === 'easing-anchor').length, 7);
  assert.deepEqual(new Set(ANIMATION_CASES.map(item => item.type)), new Set(ANIMATION_TYPE_VALUES));
  assert.deepEqual(new Set(ANIMATION_CASES.map(item => item.easing)), new Set(ANIMATION_EASING_VALUES));
  assert.match(journey, /#subtitle-animation-type/u);
  assert.match(journey, /#subtitle-animation-easing/u);
  assert.match(journey, /samplesByPhase/u);
  assert.match(journey, /continuitySamples/u);
  assert.match(journey, /captureSourceControl/u);
  assert.match(journey, /captureSourceCanvasBaselines/u);
  assert.match(journey, /repeated ready-empty Canvas source frame was not deterministic/u);
  assert.doesNotMatch(journey, /savePreviewSourceFrame/u);
  assert.match(journey, /measureFrameSignal/u);
  assert.match(journey, /compareFramePixels/u);
  assert.match(journey, /compareFramePixelGeometry/u);
  assert.match(journey, /compareFrameDominantDifferenceComponent/u);
  assert.match(journey, /capture: frame\.geometry\.capture/u);
  assert.match(journey, /captured frame omitted its transport clock/u);
  assert.match(journey, /decoded-source PTS does not agree with its provenance/u);
  assert.match(journey, /sourceClockProvenance === 'rvfc'/u);
  assert.match(journey, /assertComparableCapture/u);
  assert.match(journey, /maximumRelativeCropDeltaPixels:\s*1/u);
  assert.match(journey, /Canvas-relative/u);
  assert.match(nativeMediaOracle, /window:\s*\{ width: geometry\.windowWidth, height: geometry\.windowHeight \}/u);
  assert.match(nativeMediaOracle, /after\.clock\.revision === geometry\.clock\.revision/u);
  assert.match(nativeMediaOracle, /the preview changed while WebDriver captured its compositor frame/u);
  assert.match(journey, /maximumClockDeltaSeconds:\s*0\.02/u);
  assert.match(journey, /frameEdgeFringePixels:\s*3/u);
  assert.match(journey, /dominantHaloPixels:\s*32/u);
  assert.match(journey, /phaseTransitions/u);
  assert.match(journey, /deterministic 24x14 ROI/u);
  assert.match(journey, /tainted-operation-trace/u);
  assert.match(journey, /hasGlyphInk/u);
  assert.match(journey, /patchContextMethod\('drawImage'/u);
  assert.match(journey, /visual: visualSample\(\)/u);
});

test('Canvas prototype instrumentation restores idempotently on setup and playback failures', () => {
  const start = journey.slice(
    journey.indexOf('const startAnimationWitness'),
    journey.indexOf('const markAnimationWitnessTransition'),
  );
  assert.ok(start.length > 0, 'animation witness source is absent');
  assert.ok(start.indexOf('witness.cleanup = () =>') < start.indexOf("patchContextMethod('clearRect'"), (
    'cleanup must exist before the first Canvas prototype patch'
  ));
  assert.match(start, /if \(cleaned\) return/u);
  assert.match(start, /while \(restorers\.length > 0\) restorers\.pop\(\)\(\)/u);
  assert.match(start, /catch \(error\) \{\s*witness\.cleanup\(\);\s*throw error;/u);
  assert.match(journey, /const witnessThroughCue = async \(\) => \{[\s\S]*?try \{[\s\S]*?finally \{\s*await cleanupAnimationWitness\(\);/u);
  assert.match(journey, /window\.__OSG_E2E_ANIMATION_WITNESS__\?\.cleanup\?\.\(\)/u);
});

test('live font/preset transition records recoverable buffering and complete pixel publications', () => {
  assert.match(journey, /'abort', 'emptied', 'error', 'playing', 'stalled', 'waiting'/u);
  assert.doesNotMatch(journey, /assert\.deepEqual\(witness\.mediaEvents, \[\]/u);
  assert.match(journey, /markAnimationWitnessTransition/u);
  assert.match(journey, /verifyLiveFontPresetTransition/u);
  assert.match(journey, /transientTransitions: gamingWitness\.transientTransitions/u);
  assert.match(journey, /attributeFilter: \['data-osg-frame-revision'\]/u);
  assert.match(journey, /publications: gamingWitness\.publications/u);
  assert.match(journey, /beforeFontFamily: beforeGamingScene\.scene\.customization\.fontFamily/u);
  assert.match(journey, /afterFontFamily: gamingScene\.scene\.customization\.fontFamily/u);
  assert.match(journey, /mediaEvents: temporal\.mediaEvents/u);
  assert.match(journey, /try \{[\s\S]*?gamingTransition = await markAnimationWitnessTransition\(\)[\s\S]*?finally \{\s*await cleanupAnimationWitness\(\);/u);
});

test('source controls are captured from the typed ready-empty Canvas before subtitle import', () => {
  assert.match(journey, /status = 'ready'/u);
  assert.match(journey, /requireOverlay = true/u);
  assert.match(journey, /state\.preview\?\.status === status/u);
  assert.match(journey, /cue: '',\s*status: 'empty',\s*requireOverlay: false/u);
  assert.ok(journey.indexOf('captureSourceCanvasBaselines(root)') < journey.indexOf('importSubtitleDocument('));
  assert.match(journey, /sourceMediaTime: finiteDatasetNumber/u);
  assert.match(journey, /transportTime: finiteDatasetNumber/u);
  assert.match(journey, /sceneTime: finiteDatasetNumber/u);
  assert.match(journey, /Math\.abs\(state\.canvas\.sceneTime - seconds\) <= 0\.05/u);
  assert.match(journey, /Math\.abs\(state\.canvas\.transportTime - reachableSeconds\) <= 0\.000_001/u);
  assert.match(journey, /state\.canvas\.sourceClockProvenance === 'rvfc'/u);
  assert.match(journey, /state\.canvas\.sourceMediaTime === null/u);
  assert.ok(
    journey.indexOf('state = await publicSeek(MATERIAL_TIME, true);', journey.indexOf('gamingTransitionProof'))
      < journey.indexOf("captureNativeFrame(root, '00-gaming-active-material-baseline')"),
    'the live preset witness must restore the 8s source instant before material comparisons',
  );
  assert.doesNotMatch(
    journey,
    /waitForReady\(\{ paused: true, cue: null, context: 'initial Render preview' \}\)/u,
  );
});

test('fade-boundary actions require fresh pixels without pretending the static overlay cache rebuilt', () => {
  assert.match(journey, /const samplesDynamicAnimationPhase = Number\.isFinite\(spec\.atSeconds\)/u);
  assert.match(journey, /overlay: !samplesDynamicAnimationPhase/u);
  assert.match(journey, /const frameChange = verifyCustomizationTransition\([\s\S]*?beforePath: beforeFrame\.path[\s\S]*?afterPath: nextFrame\.path/u);
});

test('journey drives the public WebView without native dialogs, product-state injection or fullscreen', () => {
  assert.doesNotMatch(journey, /__TAURI__|invokeDesktop|invokeCommand|executeAsync/u);
  assert.doesNotMatch(journey, /select_media|open_document|save_document|dialog_paths/u);
  assert.doesNotMatch(journey, /requestFullscreen|exitFullscreen|data-osg-control=\?"fullscreen/u);
  assert.doesNotMatch(journey, /video\.currentTime\s*=|\.play\(\)|\.pause\(\)/u);
  assert.doesNotMatch(journey, /dispatchEvent|Object\.getOwnPropertyDescriptor\(HTMLInputElement/u);
  assert.doesNotMatch(journey, /normalize-space\(\.\)|normalize-space\(text|contains\(text\(\)/u);
  assert.match(journey, /actuateNativeRange/u);
  assert.match(journey, /Math\.abs\(observed - target\)/u);
  assert.match(journey, /browser\.keys\('Enter'\)/u);
  assert.match(journey, /data-osg-control="seek"/u);
  assert.match(journey, /data-osg-control="play-pause"/u);
  assert.doesNotMatch(journey, /publicSeek\(17\.25/u, 'continuous playback must not jump over the cue');
});

test('journey arms refusal capture before setup and requires complete cumulative scenes', () => {
  assert.ok(journey.indexOf('await installVisibleErrorLedger()') < journey.indexOf('await openProjectWithMedia()'));
  assert.match(journey, /mutation\.type === 'attributes'/u);
  assert.match(journey, /attributeOldValue: true/u);
  assert.match(journey, /mutation\.oldValue/u);
  assert.match(journey, /data-osg-preview-code/u);
  assert.match(journey, /data-osg-cue-index/u);
  assert.match(journey, /recordedRefusals/u);
  assert.match(journey, /transientTransitions/u);
  assert.match(journey, /isDeepStrictEqual\(scene\?\.scene\?\.customization, expectedCustomization\)/u);
  assert.match(journey, /soleDurableRenderScene/u);
  assert.doesNotMatch(journey, /durableRenderScenes\(root\)\.at\(-1\)/u);
  assert.match(journey, /expectedFinalCustomization/u);
  assert.match(journey, /00:00:02,000 --> 00:00:14,000/u);
});

test('evidence is bounded to seven material and three representative animation screenshots', () => {
  assert.equal(MATERIAL_GROUPS.length, 7);
  assert.equal(ANIMATION_CASES.filter(item => item.captureEvidence).length, 3);
  assert.match(journey, /copyWorkflowArtifact/u);
  assert.match(journey, /describeCustomizationNativeFrame/u);
  assert.match(journey, /Arabic العربية مرحبا/u);
  assert.match(journey, /Tiếng Việt/u);
  assert.match(journey, /한국어/u);
  assert.match(journey, /👨‍👩‍👧‍👦/u);
});
