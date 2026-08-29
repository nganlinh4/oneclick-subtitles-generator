import { strict as assert } from 'node:assert';
import test from 'node:test';

/* global structuredClone */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { activeCueAtFrom, easeSubtitle } from '../../src/components/previews/canvas/canvasSubtitleMath.js';
import {
  EXPORT_ANIMATION_PARITY_CASES,
  EXPORT_PARITY_FPS,
  EXPORT_PARITY_MAIN_RENDER_ROTATED_FLOOR,
  EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR,
  analyzeSubtitleParityRgba,
  verifyExportAnimationParityObservation,
} from './exportAnimationParityOracle.js';
import {
  HEIGHT,
  WIDTH,
  baseline,
  case03Definition,
  goodRegion,
  paint,
  realSsim,
  rgba,
  rotateDefinition,
  scoresFor,
} from './exportAnimationParityOracle.mutationFixtures.js';
import { decodeFrameRgba } from './nativeMediaOracle.js';

/**
 * Adversarial mutation suite for exportAnimationParityOracle.js.
 *
 * This does not re-test the oracle's happy path (exportAnimationParityOracle.test.mjs already does
 * that with hand-fed literals). It synthesizes or perturbs frame fixtures that encode SEVEN defect
 * classes a real regression could produce, and asserts the oracle rejects each one at its currently
 * calibrated thresholds.
 *
 * An earlier review pass found two holes here (a wide-box translation escaping placement checks,
 * and case 03's default sample offset landing at a near-zero eased alpha); both are now closed --
 * see the "defect 3b [FIXED]" and "case 03 fix" tests below, which assert the closed behaviour
 * directly instead of carrying a separate holes ledger for issues that no longer exist.
 *
 * Where real preserved evidence frames exist under %LOCALAPPDATA%\OSG-Development\cache\evidence
 * (a specific developer machine's cache, never present in CI), the suite perturbs COPIES of them for
 * extra realism; those tests are gated on existsSync and skip cleanly when the cache is absent. The
 * portable core of the suite uses synthetic RGBA buffers plus real FFmpeg SSIM (the same engine
 * `compareFrames` already gives the product) computed over minimal, dependency-free PPM files, since
 * this checkout has no pngjs installed (see the final report for that finding).
 */

test('sanity: the untouched baseline passes for both a plain and a rotated case', () => {
  verifyExportAnimationParityObservation(baseline());
  verifyExportAnimationParityObservation(baseline(rotateDefinition));
});

// =================================================================================================
// 1. Blank output (no ink at all) on any surface.
// =================================================================================================

test('defect 1: fully blank main/render/export is rejected on a plain case', () => {
  const blank = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT,
    independentSource: rgba(), mainSource: rgba(), renderSource: rgba(),
    main: rgba(), render: rgba(), exported: rgba(),
  });
  assert.equal(blank.roiPixels, 0, 'sanity: a genuinely blank frame must yield an empty ROI');
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(), regions: { entry: blank, exit: goodRegion() },
  }), /subtitle mask has only 0 pixels/u);
});

test('defect 1: fully blank main/render/export is rejected on the ROTATED case (0.92/0.87 floor path)', () => {
  const blank = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT,
    independentSource: rgba(), mainSource: rgba(), renderSource: rgba(),
    main: rgba(), render: rgba(), exported: rgba(),
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(rotateDefinition), regions: { entry: blank, exit: goodRegion() },
  }), /subtitle mask has only 0 pixels/u);
});

// =================================================================================================
// 2. Source-only output (video pixels, zero subtitle ink) -- export equals its own clean source
//    while Main/Render both carry real ink.
// =================================================================================================

test('defect 2: export frame identical to its independent source (source-only) is rejected', () => {
  const independentSource = rgba();
  const mainSource = rgba();
  const renderSource = rgba();
  const ink = { left: 150, top: 250, right: 330, bottom: 280 };
  const main = paint(rgba(), WIDTH, ink);
  const render = paint(rgba(), WIDTH, ink);
  const exported = rgba(); // source-only: export never painted the subtitle
  const region = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
  });
  assert.equal(region.exportMaskPixels, 0);
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(), regions: { entry: region, exit: goodRegion() },
  }), /export has no subtitle signal/u);
});

test('defect 2b: perfect agreement with one preview surface cannot hide abandonment of the other', () => {
  const observation = baseline();
  const entry = structuredClone(observation.regions.entry);
  entry.exportMainMaskCoverage = 1;
  entry.exportRenderMaskCoverage = 0;
  assert.throws(() => verifyExportAnimationParityObservation({
    ...observation,
    regions: { ...observation.regions, entry },
  }), /weaker surface subtitle mask/u);
});

// =================================================================================================
// 3. Wrong placement: ink translated by a meaningful offset, INCLUDING the ROTATED 0.92/0.87 floor.
//    This is the highest-risk relaxation named in the review brief.
// =================================================================================================

test('defect 3a: a NARROW (16px) translated export is rejected -- coverage collapses to zero', () => {
  const independentSource = rgba();
  const mainSource = rgba();
  const renderSource = rgba();
  const narrow = { left: 220, top: 300, right: 236, bottom: 308 };
  const main = paint(rgba(), WIDTH, narrow);
  const render = paint(rgba(), WIDTH, narrow);
  for (const shift of [20, 40, 45]) {
    const shifted = { left: narrow.left + shift, top: narrow.top, right: narrow.right + shift, bottom: narrow.bottom };
    const exported = paint(rgba(), WIDTH, shifted);
    const region = analyzeSubtitleParityRgba({
      width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
    });
    assert.equal(region.exportMainMaskCoverage, 0, `shift=${shift}px must fully evacuate the original mask`);
    assert.throws(() => verifyExportAnimationParityObservation({
      ...baseline(rotateDefinition), regions: { entry: region, exit: goodRegion() },
    }), /covers only .* of the stronger surface subtitle mask/u, `shift=${shift}px must be rejected`);
  }
});

// Computed once at module scope (not inside a test body) so both the documenting `test()` below and
// the sibling top-level `test.todo()` that demonstrates the hole can reference the same measurement
// without registering a test from inside another test's callback.
const wideBoxTranslation = (() => {
  // A 300x30 ink box (9,000px) is the same order of magnitude as the REAL preserved evidence for the
  // rotate case (measured 9,500px union mask below), and well inside a plausible single-line subtitle
  // width on a 480px-wide export. See "real-evidence" section below for the non-synthetic version of
  // this same finding against actual captured pixels.
  const wideBox = { left: 90, top: 300, right: 390, bottom: 330 };
  const shiftAmount = 40; // exactly the "meaningful offset" floor named in the review brief
  const independentSource = rgba();
  const mainSource = rgba();
  const renderSource = rgba();
  const main = paint(rgba(), WIDTH, wideBox);
  const render = paint(rgba(), WIDTH, wideBox);
  const shifted = {
    left: wideBox.left + shiftAmount, top: wideBox.top,
    right: wideBox.right + shiftAmount, bottom: wideBox.bottom,
  };
  const exported = paint(rgba(), WIDTH, shifted);
  const region = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
  });
  // Real, measured FFmpeg SSIM for Main(correct) vs Export(translated 40px) on this exact fixture.
  const measuredSsim = realSsim(main, exported);
  const observation = {
    ...baseline(rotateDefinition),
    scores: scoresFor(measuredSsim, measuredSsim),
    regions: { entry: region, exit: goodRegion() },
  };
  return { region, measuredSsim, observation };
})();

test('defect 3b [FIXED]: a WIDE (300px) subtitle box translated 40px still satisfies every OLD '
  + 'region/pairs check AND real FFmpeg SSIM (documents why those alone were blind to a localized '
  + 'translation), but the full observation is now rejected by the placement-agreement check', () => {
  const { region, measuredSsim, observation } = wideBoxTranslation;

  // Every check that existed BEFORE this commit still passes on this exact fixture -- the review's
  // finding about mask coverage / ROI distance / whole-frame SSIM being individually fooled by a
  // wide box remains true and is why a dedicated placement check was needed rather than tightening
  // one of these.
  assert.ok(region.exportMainMaskCoverage > 0.55, 'documents the coverage floor being satisfied');
  assert.ok(region.pairs.mainExport.meanRgbDistance < 30, 'documents the ROI mean-distance cap being satisfied');
  assert.ok(region.pairs.mainExport.changedRatio < 0.65, 'documents the ROI changed-ratio cap being satisfied');
  assert.ok(measuredSsim > EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR, 'documents real SSIM clearing the rotated floor');
  // The new instrument: the 40px shift is entirely horizontal, so mainMaskCentroid and
  // exportMaskCentroid disagree by exactly the shift amount, comfortably over the 30px cap.
  assert.ok(region.mainMaskCentroid && region.exportMaskCentroid, 'centroids must be measured');
  const measuredDisplacement = Math.hypot(
    region.mainMaskCentroid.x - region.exportMaskCentroid.x,
    region.mainMaskCentroid.y - region.exportMaskCentroid.y,
  );
  assert.ok(Math.abs(measuredDisplacement - 40) < 0.5, (
    `documents the measured centroid displacement (${measuredDisplacement}px) matching the 40px shift`
  ));

  assert.throws(
    () => verifyExportAnimationParityObservation(observation),
    /placement/iu,
    'the new centroid placement-agreement check must reject the 40px wide-box translation',
  );
});

test('defect 3c: the SAME wide-box translation crosses the coverage floor once the shift exceeds '
  + "roughly the box's own width (characterizes the exact hole boundary from 3b)", () => {
  const wideBox = { left: 90, top: 300, right: 390, bottom: 330 }; // 300px wide
  const independentSource = rgba();
  const mainSource = rgba();
  const renderSource = rgba();
  const main = paint(rgba(), WIDTH, wideBox);
  const render = paint(rgba(), WIDTH, wideBox);
  const coverageAt = (shiftAmount) => {
    const shifted = {
      left: wideBox.left + shiftAmount, top: wideBox.top,
      right: wideBox.right + shiftAmount, bottom: wideBox.bottom,
    };
    const exported = paint(rgba(), WIDTH, shifted);
    return analyzeSubtitleParityRgba({
      width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
    }).exportMainMaskCoverage;
  };
  assert.ok(coverageAt(40) > 0.55, 'below the crossover the mutation still passes (see 3b)');
  assert.ok(coverageAt(100) > 0.55, 'still passes at 100px for a 300px-wide box');
  assert.ok(coverageAt(200) < 0.55, 'only a shift comparable to the box width finally trips the floor');
  const shifted200 = {
    left: wideBox.left + 200, top: wideBox.top, right: wideBox.right + 200, bottom: wideBox.bottom,
  };
  const exported200 = paint(rgba(), WIDTH, shifted200);
  const region200 = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported: exported200,
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(rotateDefinition), regions: { entry: region200, exit: goodRegion() },
  }), /covers only .* of the stronger surface subtitle mask/u);
});

// ---- real preserved evidence for the rotate case (gated: only runs on a machine that has it) ----

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const evidenceRoot = LOCALAPPDATA
  ? join(LOCALAPPDATA, 'OSG-Development', 'cache', 'evidence', 'export-animation-parity-matrix', 'attempts')
  : null;
const newestRotateEvidence = (() => {
  if (evidenceRoot === null || !existsSync(evidenceRoot)) return null;
  let best = null;
  for (const entry of readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(evidenceRoot, entry.name, '09-rotate-gradient-glow-entry-decoded-export.png');
    if (existsSync(candidate)) best = join(evidenceRoot, entry.name);
  }
  return best;
})();

test('defect 3d [real evidence]: an ink-only 45px translation of the REAL captured rotate-case '
  + 'frames is rejected -- corroborates 3a/3b were not synthetic artifacts', {
  skip: newestRotateEvidence === null
    ? 'no preserved export-animation-parity-matrix evidence on this machine'
    : false,
}, () => {
  const dir = newestRotateEvidence;
  const dec = (name) => decodeFrameRgba(join(dir, name), { width: WIDTH, height: HEIGHT });
  const independentSource = dec('09-rotate-gradient-glow-entry-independent-source.png');
  const mainSource = dec('09-rotate-gradient-glow-entry-main-source-only.png');
  const renderSource = dec('09-rotate-gradient-glow-entry-render-source-only.png');
  const main = dec('09-rotate-gradient-glow-entry-main-preview.png');
  const render = dec('09-rotate-gradient-glow-entry-render-preview.png');
  const exported = dec('09-rotate-gradient-glow-entry-decoded-export.png');

  const sanity = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
  });
  assert.ok(sanity.subtitleMaskPixels > 1_000, 'sanity: the real rotate-case frame carries real ink');

  // Move only the ink pixels (>=18 delta from source) by 45px; leave everything else untouched --
  // this reproduces "wrong placement", not "different scene".
  const translateInkOnly = (background, inkSource, inkAgainst, dx, dy, threshold = 18) => {
    const out = Uint8Array.from(background);
    for (let y = 0; y < HEIGHT; y += 1) {
      for (let x = 0; x < WIDTH; x += 1) {
        const offset = (y * WIDTH + x) * 4;
        const delta = Math.max(
          Math.abs(inkSource[offset] - inkAgainst[offset]),
          Math.abs(inkSource[offset + 1] - inkAgainst[offset + 1]),
          Math.abs(inkSource[offset + 2] - inkAgainst[offset + 2]),
        );
        if (delta < threshold) continue;
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || tx >= WIDTH || ty < 0 || ty >= HEIGHT) continue;
        const targetOffset = (ty * WIDTH + tx) * 4;
        out[targetOffset] = inkSource[offset];
        out[targetOffset + 1] = inkSource[offset + 1];
        out[targetOffset + 2] = inkSource[offset + 2];
        out[targetOffset + 3] = 255;
      }
    }
    return out;
  };
  const translated = translateInkOnly(independentSource, exported, independentSource, 45, 0);
  const region = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported: translated,
  });
  const realSsimVsMain = realSsim(main, translated);
  const realSsimVsRender = realSsim(render, translated);

  assert.ok(region.exportMainMaskCoverage < 0.55, `real-evidence coverage ${region.exportMainMaskCoverage} must trip the floor`);
  assert.ok(realSsimVsMain < EXPORT_PARITY_MAIN_RENDER_ROTATED_FLOOR, `real SSIM ${realSsimVsMain} must trip the rotated Main floor`);
  assert.ok(realSsimVsRender < EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR, `real SSIM ${realSsimVsRender} must trip the rotated WYSIWYG floor`);

  // The SSIM checks run before the region/coverage checks inside verifyExportAnimationParityObservation,
  // so whichever of the two independently-broken measurements is evaluated first is what surfaces in
  // the thrown message; both are separately confirmed broken above.
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(rotateDefinition),
    scores: scoresFor(realSsimVsRender, realSsimVsMain),
    regions: { entry: region, exit: goodRegion() },
  }), /covers only .* of the stronger surface subtitle mask|SSIM .* is below/u);
});

// =================================================================================================
// 4. Wrong frame: export bound to a visibly different instant (different eased alpha / far mask
//    size than what the phase actually calls for).
// =================================================================================================

test('defect 4a: phaseBinding naming a different frame number than the reviewed definition is rejected', () => {
  const wrong = structuredClone(baseline());
  wrong.phaseBinding.frames.entry += 30; // a full second away at 30fps
  assert.throws(() => verifyExportAnimationParityObservation(wrong), /bound to the wrong frame/u);
});

test('defect 4b: an exit sample that is really a holding-phase frame (implausible mask ratio) is rejected', () => {
  const hugeMask = goodRegion({
    subtitleMaskPixels: 60_000,
    subtitleMaskRatio: 60_000 / (WIDTH * HEIGHT), // 0.347 > MAX_SUBTITLE_MASK_RATIO (0.25)
    roiPixels: 65_000,
    roiRatio: 65_000 / (WIDTH * HEIGHT),
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(), regions: { entry: goodRegion(), exit: hugeMask },
  }), /subtitle mask ratio .* is implausible/u);
});

// =================================================================================================
// 5. Wrong alpha: ink at roughly half or roughly double the expected eased opacity.
// =================================================================================================

test('defect 5a: export ink at half the Main/Render colour intensity is rejected', () => {
  const independentSource = rgba(WIDTH, HEIGHT, 12);
  const mainSource = rgba(WIDTH, HEIGHT, 12);
  const renderSource = rgba(WIDTH, HEIGHT, 12);
  const box = { left: 150, top: 250, right: 330, bottom: 280 };
  const main = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: 245 });
  const render = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: 245 });
  // "Half alpha": export's ink colour sits halfway between source (12) and full ink (245).
  const exported = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: Math.round((12 + 245) / 2) });
  const region = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
  });
  assert.ok(region.pairs.mainExport.meanRgbDistance > 30, 'half-alpha ink must exceed the ROI mean-distance cap');
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(), regions: { entry: region, exit: goodRegion() },
  }), /mean ROI distance .* is too high/u);
});

test('defect 5b: export ink already at full (holding) intensity while Main/Render are still faint '
  + '("double" alpha -- jumped ahead of the real eased value) is rejected', () => {
  const independentSource = rgba(WIDTH, HEIGHT, 12);
  const mainSource = rgba(WIDTH, HEIGHT, 12);
  const renderSource = rgba(WIDTH, HEIGHT, 12);
  const box = { left: 150, top: 250, right: 330, bottom: 280 };
  const faintValue = 12 + Math.round((245 - 12) * 0.15); // ~15% eased alpha, matches a real fade-in sample
  const main = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: faintValue });
  const render = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: faintValue });
  const exported = paint(rgba(WIDTH, HEIGHT, 12), WIDTH, { ...box, value: 245 }); // 100% -- "doubled"
  const region = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
  });
  assert.ok(region.pairs.mainExport.meanRgbDistance > 30, 'over-bright ink must exceed the ROI mean-distance cap');
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(), regions: { entry: region, exit: goodRegion() },
  }), /mean ROI distance .* is too high/u);
});

// =================================================================================================
// 6. Stale frame: previous cue's ink persisting (entry and exit are really the same instant).
// =================================================================================================

test('defect 6a: identical entry/exit hashes on any surface (frozen frame) are rejected', () => {
  for (const surface of ['main', 'render', 'exported', 'independentSource']) {
    const stale = structuredClone(baseline());
    stale.phaseBinding.hashes[surface].exit = stale.phaseBinding.hashes[surface].entry;
    assert.throws(
      () => verifyExportAnimationParityObservation(stale),
      new RegExp(`${surface} entry/exit artifacts are identical`, 'u'),
      `${surface} must be caught`,
    );
  }
});

test('defect 6b: near-zero entry/exit pixel delta (frame effectively frozen even with distinct '
  + 'hashes) is rejected', () => {
  const stale = structuredClone(baseline());
  stale.phaseBinding.deltas.exported = { changedPixels: 4, changedRatio: 0.0000_1, maximumChannelDelta: 3 };
  assert.throws(
    () => verifyExportAnimationParityObservation(stale),
    /exported entry\/exit frames are not materially distinct/u,
  );
});

// =================================================================================================
// 7. Missing one surface's ink while the other two agree.
// =================================================================================================

test('defect 7: each surface losing its ink alone (the other two intact) is rejected', () => {
  const independentSource = rgba();
  const mainSource = rgba();
  const renderSource = rgba();
  const box = { left: 200, top: 260, right: 280, bottom: 300 };
  const inked = () => paint(rgba(), WIDTH, box);
  const blankOne = ['main', 'render', 'export'];
  for (const missing of blankOne) {
    const main = missing === 'main' ? rgba() : inked();
    const render = missing === 'render' ? rgba() : inked();
    const exported = missing === 'export' ? rgba() : inked();
    const region = analyzeSubtitleParityRgba({
      width: WIDTH, height: HEIGHT, independentSource, mainSource, renderSource, main, render, exported,
    });
    assert.throws(
      () => verifyExportAnimationParityObservation({ ...baseline(), regions: { entry: region, exit: goodRegion() } }),
      /no subtitle mask|no subtitle signal/u,
      `${missing} losing its ink alone must be rejected`,
    );
  }
});

// =================================================================================================
// Coordinator follow-up: case 03 ("slide-down-arabic-glow", cue duration 0.4s, easing 'ease-in',
// DEFAULT sampleOffsetFrames=12) recorded a real "pass" in evidence attempt 97c22a4f while none of
// its screenshots show visible Arabic ink. Investigate whether the presence floor is bypassable for
// very short cues, and lock in a regression test that a truly-zero-ink case-03-shaped observation
// is rejected.
// =================================================================================================

test('case 03 fix: sampleOffsetFrames=6 now lands both calibrated samples at >=35% eased opacity '
  + '(was ~11.1% at the default 12-frame offset -- see git history / commit message for the '
  + 'before/after measurement this override closed)', () => {
  assert.ok(case03Definition, 'case 03 must exist in the reviewed matrix');
  assert.equal(case03Definition.sampleOffsetFrames, 6, 'case 03 now uses the CALIBRATED offset, like case 07');
  assert.equal(case03Definition.animationEasing, 'ease-in');
  assert.equal(case03Definition.animationType, 'slide-down');

  const fadeSeconds = 18 / EXPORT_PARITY_FPS;
  const cue = { start: case03Definition.startFrame / EXPORT_PARITY_FPS, end: case03Definition.endFrame / EXPORT_PARITY_FPS };
  const entrySeconds = case03Definition.entryFrame / EXPORT_PARITY_FPS;
  const exitSeconds = case03Definition.exitFrame / EXPORT_PARITY_FPS;

  const entryActive = activeCueAtFrom([cue], entrySeconds, fadeSeconds, fadeSeconds, 0);
  const exitActive = activeCueAtFrom([cue], exitSeconds, fadeSeconds, fadeSeconds, 0);
  assert.equal(entryActive.phase, 'fadingIn');
  assert.equal(exitActive.phase, 'fadingOut');
  // Ground truth from the SAME easing evaluator the product/preview use (canvasSubtitleMath.js),
  // not a re-implementation -- this is what a correct render is actually supposed to look like.
  const entryEased = easeSubtitle(entryActive.progress, case03Definition.animationEasing);
  const exitEased = easeSubtitle(exitActive.progress, case03Definition.animationEasing);

  // Frame indices/instants named precisely, as requested.
  assert.equal(case03Definition.entryFrame, 126); // t=4.200s
  assert.equal(case03Definition.exitFrame, 150); // t=5.000s
  assert.ok(Math.abs(entryActive.progress - (2 / 3)) < 1e-9, 'entry sample lands at 2/3 raw progress into fade-in');
  assert.ok(Math.abs(exitActive.progress - (2 / 3)) < 1e-9, 'exit sample lands at 2/3 raw "remaining" into fade-out');
  // 'ease-in' at 2/3 raw progress reaches ~44.4% eased alpha -- comfortably above the 35% robustness
  // floor (versus the ~11.1% the default 12-frame offset produced at 1/3 raw progress).
  assert.ok(entryEased >= 0.35, `entry eased alpha ${entryEased} must clear the 35% robustness floor`);
  assert.ok(exitEased >= 0.35, `exit eased alpha ${exitEased} must clear the 35% robustness floor`);
});

test('case 03 investigation: a preset-03-SHAPED case with genuinely ZERO ink on every surface at '
  + 'both entry and exit is still rejected (answers the coordinator\'s direct question: the presence '
  + 'floor is not bypassable purely because the cue is short)', () => {
  const shapedDefinition = {
    ...case03Definition,
    customization: { ...case03Definition.customization },
  };
  const blank = analyzeSubtitleParityRgba({
    width: WIDTH, height: HEIGHT,
    independentSource: rgba(), mainSource: rgba(), renderSource: rgba(),
    main: rgba(), render: rgba(), exported: rgba(),
  });
  assert.throws(() => verifyExportAnimationParityObservation({
    ...baseline(shapedDefinition), regions: { entry: blank, exit: blank },
  }), /subtitle mask has only 0 pixels/u);
});
