import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/* global URL */

import {
  EXPORT_ANIMATION_PARITY_CASES,
  validateExportAnimationParityMatrix,
} from './exportAnimationParityOracle.js';

const journey = readFileSync(
  new URL('../journeys/exportAnimationParityMatrix.journey.js', import.meta.url),
  'utf8',
);
const mainControls = readFileSync(
  new URL('../../src/components/previews/VideoBottomControls.js', import.meta.url),
  'utf8',
);
const standardSlider = readFileSync(
  new URL('../../src/components/common/StandardSlider.js', import.meta.url),
  'utf8',
);
const renderControls = readFileSync(
  new URL('../../src/components/previews/NativeRenderPreview.js', import.meta.url),
  'utf8',
);
const workflowHelpers = readFileSync(
  new URL('./workflow.js', import.meta.url),
  'utf8',
);

const exportedHelper = (name) => {
  const start = workflowHelpers.indexOf(`export const ${name} =`);
  assert.ok(start >= 0, `${name} helper is absent`);
  const next = workflowHelpers.indexOf('\nexport const ', start + 1);
  return workflowHelpers.slice(start, next < 0 ? workflowHelpers.length : next);
};

test('the journey contains exactly the reviewed ten-case public matrix', () => {
  assert.equal(validateExportAnimationParityMatrix().length, 10);
  assert.deepEqual(
    EXPORT_ANIMATION_PARITY_CASES.map(entry => entry.animationType).sort(),
    [
      'bounce', 'fade', 'flip', 'rotate', 'scale', 'slide-down', 'slide-left', 'slide-right',
      'slide-up', 'typewriter',
    ],
  );
  assert.match(journey, /results\.length, 10/u);
  assert.match(journey, /const row = rows\[0\]/u);
});

test('the journey cannot mutate private app or media state', () => {
  for (const [label, forbidden] of [
    ['prototype setter', /Object\.getOwnPropertyDescriptor|HTMLInputElement\.prototype/u],
    ['synthetic event', /dispatchEvent|new\s+(?:InputEvent|Event)\s*\(/u],
    ['direct media seek', /\.currentTime\s*=/u],
    ['direct media playback', /(?:video|media|element|target)\.(?:play|pause)\s*\(/u],
    ['browser storage mutation', /\b(?:localStorage|sessionStorage|indexedDB)\b/u],
    ['private control mutation', /\.(?:selected|value)\s*=|setAttribute\s*\(/u],
    ['React internals', /__react|reactProps|reactFiber/iu],
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand|executeAsync/u],
    ['fullscreen request', /requestFullscreen|exitFullscreen/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['window movement', /setPosition|maximize|minimize|setFocus/u],
  ]) {
    assert.doesNotMatch(journey, forbidden, `journey contains forbidden ${label}`);
  }
  assert.doesNotMatch(journey, /\bseekPreviewTo\b/u, 'a direct-seek shared helper was imported');
  const workflowImport = /import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/support\/workflow\.js['"]/u.exec(journey);
  assert.ok(workflowImport, 'the reviewed workflow import is absent');
  assert.deepEqual(
    workflowImport[1].split(',').map(value => value.trim()).filter(Boolean).sort(),
    ['importSubtitleDocument', 'openProjectWithMedia'],
    'the journey imported an unreviewed workflow helper',
  );
});

test('preview admission distinguishes decoded-source time from the exported scene clock', () => {
  assert.match(journey, /canvas\?\.dataset\.osgSourceMediaTime/u);
  assert.match(journey, /canvas\?\.dataset\.osgTransportTime/u);
  assert.match(journey, /canvas\?\.dataset\.osgSourceClockProvenance/u);
  assert.match(journey, /canvas\?\.dataset\.osgSceneTime/u);
  assert.match(journey, /Number\.isFinite\(state\.transportTime\)/u);
  assert.match(journey, /state\.sourceClockProvenance === 'rvfc'/u);
  assert.match(journey, /state\.sourceMediaTime === null/u);
  assert.match(journey, /Number\.isFinite\(state\.sceneTime\)/u);
  assert.match(
    journey,
    /Math\.abs\(state\.sceneTime - seconds\) <= \(1 \/ \(2 \* EXPORT_PARITY_FPS\)\)/u,
  );
});

test('the two imported setup helpers cannot hide product-state mutation', () => {
  const openMedia = exportedHelper('openProjectWithMedia');
  const selectMedia = exportedHelper('selectStagedMediaFile');
  const importDocument = exportedHelper('importSubtitleDocument');
  assert.match(openMedia, /selectStagedMediaFile\(\)/u);
  assert.match(selectMedia, /clickControl\('\[data-input-tab="file-upload"\]'\)/u);
  assert.match(selectMedia, /clickControl\('\.file-upload-input'\)/u);
  assert.match(importDocument, /\.srt-upload-button-container/u);
  assert.match(importDocument, /new File\(/u);
  assert.match(importDocument, /new DataTransfer\(/u);
  assert.match(importDocument, /new DragEvent\(/u);
  for (const [label, forbidden] of [
    ['direct media seek', /\.currentTime\s*=/u],
    ['direct media playback', /\.(?:play|pause)\s*\(/u],
    ['browser storage mutation', /\b(?:localStorage|sessionStorage|indexedDB)\b/u],
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['React internals', /__react|reactProps|reactFiber/iu],
  ]) {
    assert.doesNotMatch(openMedia, forbidden, `openProjectWithMedia contains ${label}`);
    assert.doesNotMatch(selectMedia, forbidden, `selectStagedMediaFile contains ${label}`);
    assert.doesNotMatch(importDocument, forbidden, `importSubtitleDocument contains ${label}`);
  }
});

test('all authorship and frame movement crosses visible keyboard/pointer controls', () => {
  assert.match(journey, /browser\.action\('pointer'\)/u);
  assert.match(journey, /browser\.keys\(key\)/u);
  assert.match(journey, /data-osg-control="range"/u);
  assert.match(journey, /#subtitle-glow-color/u);
  assert.match(journey, /#subtitle-gradient-start-color/u);
  assert.match(journey, /#subtitle-stroke-color/u);
  assert.match(journey, /browser\.keys\('Enter'\)/u);
  assert.match(journey, /\[data-osg-preset="default"\]/u);
  assert.match(mainControls, /data-osg-control="seek"/u);
  assert.match(mainControls, /role="slider"/u);
  assert.match(mainControls, /ArrowLeft.*ArrowRight|ArrowRight.*ArrowLeft/su);
  assert.match(renderControls, /data-osg-control="seek"/u);
  assert.match(renderControls, /onInput=\{\(event\) => seek\(event\.currentTarget\.value\)\}/u);
  assert.match(renderControls, /useVideoSeekCoordinator/u);
  assert.match(standardSlider, /data-osg-control=.*'range'/u);
  assert.match(standardSlider, /handleKeyboardChange/u);
});

test('the observation is region-scoped, time-bound and independently decoded', () => {
  for (const required of [
    'mainSourcePath',
    'renderSourcePath',
    'independentSourcePath',
    'analyzeSubtitleParityRgba',
    'decodeFrameRgba',
    'mainExport',
    'phaseBinding',
    'compareFramePixels',
    'sha256File',
  ]) assert.match(journey, new RegExp(`\\b${required}\\b`, 'u'));
  assert.match(journey, /extractFrame\(selectedSource, exactFrameSeconds\(frame\)/u);
  assert.match(journey, /channelDeltaThreshold: 12/u);
  assert.match(journey, /mainKeySequence/u);
  assert.match(journey, /renderKeySequence/u);
  assert.match(journey, /mainSourceSelected/u);
  assert.match(journey, /renderSourceSelected/u);
  assert.match(journey, /measureAudioSignal/u);
  assert.match(journey, /durableCustomerIdentity/u);
  assert.match(journey, /resolveManagedArtifact/u);
  assert.match(journey, /durableOwnership/u);
  assert.match(journey, /sourceFiles/u);
  assert.match(journey, /exportOwnership/u);
  assert.match(journey, /selectedSourceIdentity/u);
});

test('the transient ledger begins before setup and observes preview status attributes', () => {
  assert.ok(
    journey.indexOf('await installProblemLedger()') < journey.indexOf('await openProjectWithMedia()'),
    'error ledger must exist before media and subtitle setup',
  );
  assert.match(journey, /mutation\.type === 'attributes'/u);
  assert.match(journey, /attributeOldValue:\s*true/u);
  assert.match(journey, /mutation\.oldValue/u);
  assert.match(journey, /data-osg-preview-code/u);
  assert.match(journey, /previewRefusals/u);
});

test('the only OS boundary is fail-closed staging below the disposable run root', () => {
  assert.match(journey, /OSG_E2E_MEDIA_SELECTION/u);
  assert.match(journey, /OSG_E2E_MEDIA_DESTINATION/u);
  assert.match(journey, /pathInside\(root, destination, 'save destination'\)/u);
  assert.match(journey, /pathInside\(root, selectedSource, 'selected media'\)/u);
  assert.match(journey, /fail-closed staged dialog/u);
});

// An adversarial audit found that the two headline SSIM floors were defended by nothing: relaxing
// EXPORT_PARITY_WYSIWYG_FLOOR from 0.95 to 0.50, or the Main/Render floor from 0.90 to 0.50, left
// all 45 parity tests green. Every OTHER threshold in this oracle is defended by a mutation case
// that fails when it is relaxed, so the two constants most likely to be quietly loosened were
// exactly the two with no enforcement. This pins each threshold's literal value so that relaxing
// one is impossible to do silently -- it forces an edit here, which is the review the project's
// anti-oracle-weakening rule requires. Raising a floor (tightening) also trips this deliberately:
// a stricter oracle still deserves the same explicit sign-off.
test('every parity threshold is pinned so a relaxation cannot pass unnoticed', () => {
  const oracle = readFileSync(new URL('./exportAnimationParityOracle.js', import.meta.url), 'utf8');
  for (const [name, value] of [
    ['EXPORT_PARITY_WYSIWYG_FLOOR', '0.95'],
    ['EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR', '0.91'],
    ['EXPORT_PARITY_MAIN_RENDER_ROTATED_FLOOR', '0.87'],
    ['EXPORT_PARITY_MAIN_RENDER_FLOOR', '0.90'],
    ['EXPORT_PARITY_SOURCE_IDENTITY_FLOOR', '0.90'],
    ['MIN_EXPORT_MASK_COVERAGE', '0.55'],
    ['EXPORT_PARITY_CENTROID_DISPLACEMENT_PX', '30'],
    ['MAX_ROI_MEAN_DISTANCE', '30'],
    ['MAX_ROI_CHANGED_RATIO', '0.65'],
    ['MAX_EXPORT_MASK_RATIO', '0.35'],
    ['STRONG_PLACEMENT_MASK_PIXELS', '6_000'],
    ['STRONG_SURFACE_MASK_PIXELS', '3_000'],
    ['MIN_SURFACE_MASK_OVERLAP', '0.30'],
  ]) {
    // The decimal point must reach the REGEX as an escaped dot, which needs a literal backslash in
    // the string: '\.' in a JS string literal is just '.', so the naive form left the point as an
    // unescaped wildcard that would have accepted 0X95 in place of 0.95.
    const declaration = new RegExp(`(?:export )?const ${name} = ${value.replace('.', '\\.')};`, 'u');
    assert.match(oracle, declaration, `${name} must stay pinned at ${value}`);
  }
});

// The placement claim must be judged against the FARTHER of the two preview surfaces. Taking the
// closer one hands back the exact defect a WYSIWYG oracle exists to catch -- an export that tracks
// Render while drifting from Main scored a perfect 0px, and on the preserved matrix that let a 60px
// joint translation pass unseen.
test('export placement is judged against the worst surface, never the best', () => {
  const oracle = readFileSync(new URL('./exportAnimationParityOracle.js', import.meta.url), 'utf8');
  assert.match(oracle, /const \[worstSurface, worstDistance\] = placementPairs\.reduce/u);
  assert.match(oracle, /candidate\[1\] > best\[1\] \? candidate : best/u);
  assert.doesNotMatch(oracle, /candidate\[1\] < best\[1\] \? candidate : best/u);
});
