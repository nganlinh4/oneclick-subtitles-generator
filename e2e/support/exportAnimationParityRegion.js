// Subtitle ROI pixel analysis plus the per-phase region, temporal-delta and motion verdicts
// the export parity oracle applies to every captured surface.

import { strict as assert } from 'node:assert';

export const EXPORT_PARITY_MASK_DELTA = 18;
export const EXPORT_PARITY_PAIR_DELTA = 24;
export const EXPORT_PARITY_MASK_EXPANSION_PX = 3;

const MIN_SUBTITLE_MASK_PIXELS = 32;
const MIN_SUBTITLE_MASK_RATIO = 0.000_1;
const MAX_SUBTITLE_MASK_RATIO = 0.25;
const MIN_SURFACE_MASK_OVERLAP = 0.30;
// Below this per-surface mask size, exact-pixel overlap degenerates into threshold noise and the
// centroid-distance agreement takes over. Strong samples (holding/typical entries) sit well above.
const STRONG_SURFACE_MASK_PIXELS = 3_000;
// The export must reproduce at least this fraction of the stronger surface's own ink footprint.
// Judged per surface rather than against the Main/Render union, whose size varies with how far
// the two capture paths diverge at a given alpha.
const MIN_EXPORT_MASK_COVERAGE = 0.55;
// Agreement with only ONE surface is not WYSIWYG parity. The latest preserved 10-case real-binary
// matrix (export-animation-parity-matrix attempt 20260828053657698-68980-ec400bf2) measured every
// Main and Render coverage independently. Its lowest legitimate weaker-surface sample was 0.5402
// (case 05 entry); every other sample was >= 0.5887. A 0.50 floor retains measured rasterization
// headroom while rejecting an export that follows one preview implementation and abandons the
// other. Keep the stronger 0.55 claim above as well: two mediocre overlaps are not a substitute
// for reproducing either real surface strongly.
const MIN_EXPORT_SECONDARY_MASK_COVERAGE = 0.50;
// Placement-agreement floor: the export's ink centroid must land close to a real surface's own
// centroid, not just overlap/cover it loosely. MIN_EXPORT_MASK_COVERAGE alone is fooled by a
// translated WIDE box (coverage only degrades to (boxWidth-shift)/boxWidth, so a 300px-wide line
// tolerates a ~135px shift before that floor trips) -- this check is the direct positional claim
// MIN_EXPORT_MASK_COVERAGE was assumed, but never actually was, to provide.
//
// STRONG_SURFACE_MASK_PIXELS (3,000px) is too low a gate for THIS check specifically: real
// preserved evidence (export-animation-parity-matrix attempt 20260827121620798-13652-97c22a4f,
// a genuine "pass" run) measured legitimate Main/export centroid disagreement of 41-64px at
// 3,000-4,900px mask sizes -- case 06 ("scale", entry/exit) and case 03 ("slide-down", entry) are
// thin/small masks where anti-aliasing and rasterization-path noise dominates centroid position,
// not a placement defect. The SAME evidence run shows that noise collapses to <=22.4px once BOTH
// compared masks clear ~8,000px (case 08 "flip", the next-smallest real sample above the gap) and
// stays there through every larger case (fade/slide/typewriter/bounce/rotate, 8,000-30,000px,
// max observed 22.4px). STRONG_PLACEMENT_MASK_PIXELS sits in the clean gap between those two
// clusters (above the noisiest excluded real sample's 4,958px export mask, below the first
// included real sample's 8,010px main mask) so it excludes exactly the small/thin masks that are
// physically noisy without excluding any real "typical" sample.
const STRONG_PLACEMENT_MASK_PIXELS = 6_000;
// EXPORT_PARITY_CENTROID_DISPLACEMENT_PX: comfortably above the 22.4px worst-case real noise
// measured above (34% headroom) and comfortably below the review's 40px translated-box defect
// (25% margin), so it neither flags correct rasterization spread nor lets a meaningful shift hide
// behind a wide box the way mask coverage and ROI distance both can.
const EXPORT_PARITY_CENTROID_DISPLACEMENT_PX = 30;
const MAX_EXPORT_MASK_RATIO = 0.35;
// Distinguishability from the decoded source is an ABSOLUTE ink floor, not a fraction of the
// ROI: the ROI is the union of both surfaces' masks plus expansion, so its size varies with how
// far the capture paths diverge at a given alpha, and a fixed fraction of it produced epsilon
// misses for correct faint ink. Placement/agreement live in the coverage and pair claims.
const MIN_SOURCE_SIGNAL_PIXELS = 128;
const MIN_SOURCE_SIGNAL_MEAN_DISTANCE = 2;
const MAX_ROI_MEAN_DISTANCE = 30;
const MAX_ROI_CHANGED_RATIO = 0.65;
const MIN_TEMPORAL_CHANGED_PIXELS = 32;
const MIN_TEMPORAL_CHANGED_RATIO = 0.000_1;

const boundedPixels = (value, width, height, label) => {
  const expected = width * height * 4;
  assert.ok(value instanceof Uint8Array, `${label} is not an RGBA byte array`);
  assert.equal(value.byteLength, expected, `${label} does not match ${width}x${height} RGBA`);
  return value;
};

const pixelDelta = (left, right, pixel) => {
  const offset = pixel * 4;
  return Math.max(
    Math.abs(left[offset] - right[offset]),
    Math.abs(left[offset + 1] - right[offset + 1]),
    Math.abs(left[offset + 2] - right[offset + 2]),
  );
};

const differenceMask = (left, right, pixels, threshold) => {
  const mask = new Uint8Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    if (pixelDelta(left, right, pixel) >= threshold) mask[pixel] = 1;
  }
  return mask;
};

const maskCount = mask => mask.reduce((count, value) => count + value, 0);

const expandedMask = (mask, width, height, radius) => {
  const expanded = new Uint8Array(mask.length);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel] === 0) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let dy = -radius; dy <= radius; dy += 1) {
      const targetY = y + dy;
      if (targetY < 0 || targetY >= height) continue;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const targetX = x + dx;
        if (targetX >= 0 && targetX < width) expanded[targetY * width + targetX] = 1;
      }
    }
  }
  return expanded;
};

const maskSignature = (mask) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    hash ^= index;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const maskCentroid = (mask, width) => {
  let count = 0;
  let x = 0;
  let y = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel] === 0) continue;
    count += 1;
    x += pixel % width;
    y += Math.floor(pixel / width);
  }
  return count === 0 ? Object.freeze({ x: null, y: null }) : Object.freeze({
    x: x / count,
    y: y / count,
  });
};

const centroidDistance = (left, right) => {
  if (!Number.isFinite(left?.x) || !Number.isFinite(left?.y)
    || !Number.isFinite(right?.x) || !Number.isFinite(right?.y)) return null;
  return Math.hypot(left.x - right.x, left.y - right.y);
};

const pairStats = (left, right, roi, changedThreshold) => {
  let pixels = 0;
  let changedPixels = 0;
  let channelDistance = 0;
  let maximumChannelDelta = 0;
  for (let pixel = 0; pixel < roi.length; pixel += 1) {
    if (roi[pixel] === 0) continue;
    pixels += 1;
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(left[offset + channel] - right[offset + channel]);
      channelDistance += delta;
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta >= changedThreshold) changed = true;
    }
    if (changed) changedPixels += 1;
  }
  assert.ok(pixels > 0, 'subtitle ROI is empty');
  return Object.freeze({
    pixels,
    changedPixels,
    changedRatio: changedPixels / pixels,
    meanRgbDistance: channelDistance / (pixels * 3),
    maximumChannelDelta,
  });
};

const maskOverlap = (left, right) => {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== 0 || right[index] !== 0) union += 1;
    if (left[index] !== 0 && right[index] !== 0) intersection += 1;
  }
  return union === 0 ? 0 : intersection / union;
};

const maskCoverage = (expected, observed) => {
  let expectedPixels = 0;
  let intersection = 0;
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index] === 0) continue;
    expectedPixels += 1;
    if (observed[index] !== 0) intersection += 1;
  }
  return expectedPixels === 0 ? 0 : intersection / expectedPixels;
};

/**
 * Derive one subtitle mask from the clean same-surface source controls, expand it into a bounded
 * ROI, then compare all three independently captured compositors inside that ROI. The caller must
 * supply an FFmpeg-decoded source separately; it is never synthesized from a preview surface.
 */
export const analyzeSubtitleParityRgba = ({
  width,
  height,
  independentSource,
  mainSource,
  renderSource,
  main,
  render,
  exported,
  maskDeltaThreshold = EXPORT_PARITY_MASK_DELTA,
  pairDeltaThreshold = EXPORT_PARITY_PAIR_DELTA,
  expansionRadius = EXPORT_PARITY_MASK_EXPANSION_PX,
}) => {
  assert.ok(Number.isSafeInteger(width) && width > 0 && width <= 8_192, 'ROI width is invalid');
  assert.ok(Number.isSafeInteger(height) && height > 0 && height <= 8_192, 'ROI height is invalid');
  assert.ok(width * height <= 16_777_216, 'ROI pixel count is unbounded');
  assert.ok(Number.isSafeInteger(maskDeltaThreshold) && maskDeltaThreshold >= 1
    && maskDeltaThreshold <= 255, 'mask threshold is invalid');
  assert.ok(Number.isSafeInteger(pairDeltaThreshold) && pairDeltaThreshold >= 1
    && pairDeltaThreshold <= 255, 'pair threshold is invalid');
  assert.ok(Number.isSafeInteger(expansionRadius) && expansionRadius >= 0
    && expansionRadius <= 16, 'mask expansion is invalid');
  const pixels = width * height;
  const inputs = Object.fromEntries(Object.entries({
    independentSource, mainSource, renderSource, main, render, exported,
  }).map(([label, value]) => [label, boundedPixels(value, width, height, label)]));
  const mainMask = differenceMask(inputs.main, inputs.mainSource, pixels, maskDeltaThreshold);
  const renderMask = differenceMask(inputs.render, inputs.renderSource, pixels, maskDeltaThreshold);
  const exportMask = differenceMask(
    inputs.exported, inputs.independentSource, pixels, maskDeltaThreshold,
  );
  const unionMask = new Uint8Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    unionMask[pixel] = mainMask[pixel] === 1 || renderMask[pixel] === 1 ? 1 : 0;
  }
  const roi = expandedMask(unionMask, width, height, expansionRadius);
  const subtitleMaskPixels = maskCount(unionMask);
  const roiPixels = maskCount(roi);
  if (roiPixels === 0) {
    return Object.freeze({
      width,
      height,
      totalPixels: pixels,
      subtitleMaskPixels: 0,
      subtitleMaskRatio: 0,
      roiPixels: 0,
      roiRatio: 0,
      mainMaskPixels: 0,
      renderMaskPixels: 0,
      exportMaskPixels: maskCount(exportMask),
      exportMaskRatio: maskCount(exportMask) / pixels,
      exportSubtitleMaskCoverage: 0,
      mainRenderMaskOverlap: 0,
      maskSignature: maskSignature(unionMask),
      maskCentroid: maskCentroid(unionMask, width),
      exportMaskCentroid: maskCentroid(exportMask, width),
      pairs: null,
      signals: null,
    });
  }
  return Object.freeze({
    width,
    height,
    totalPixels: pixels,
    subtitleMaskPixels,
    subtitleMaskRatio: subtitleMaskPixels / pixels,
    roiPixels,
    roiRatio: roiPixels / pixels,
    mainMaskPixels: maskCount(mainMask),
    renderMaskPixels: maskCount(renderMask),
    exportMaskPixels: maskCount(exportMask),
    exportMaskRatio: maskCount(exportMask) / pixels,
    exportSubtitleMaskCoverage: maskCoverage(unionMask, exportMask),
    exportMainMaskCoverage: maskCoverage(mainMask, exportMask),
    exportRenderMaskCoverage: maskCoverage(renderMask, exportMask),
    mainRenderMaskOverlap: maskOverlap(mainMask, renderMask),
    maskSignature: maskSignature(unionMask),
    maskCentroid: maskCentroid(unionMask, width),
    mainMaskCentroid: maskCentroid(mainMask, width),
    renderMaskCentroid: maskCentroid(renderMask, width),
    exportMaskCentroid: maskCentroid(exportMask, width),
    pairs: Object.freeze({
      mainRender: pairStats(inputs.main, inputs.render, roi, pairDeltaThreshold),
      mainExport: pairStats(inputs.main, inputs.exported, roi, pairDeltaThreshold),
      renderExport: pairStats(inputs.render, inputs.exported, roi, pairDeltaThreshold),
    }),
    signals: Object.freeze({
      mainIndependentSource: pairStats(
        inputs.main, inputs.independentSource, roi, maskDeltaThreshold,
      ),
      renderIndependentSource: pairStats(
        inputs.render, inputs.independentSource, roi, maskDeltaThreshold,
      ),
      exportIndependentSource: pairStats(
        inputs.exported, inputs.independentSource, roi, maskDeltaThreshold,
      ),
    }),
  });
};

export const verifyRegion = (region, definition, phase, expectedGeometry) => {
  const label = `${definition.id} ${phase}`;
  assert.ok(region && typeof region === 'object', `${label}: subtitle ROI is absent`);
  assert.ok(Number.isSafeInteger(region.totalPixels) && region.totalPixels > 0, (
    `${label}: ROI geometry is invalid`
  ));
  assert.deepEqual(
    [region.width, region.height, region.totalPixels],
    [expectedGeometry.width, expectedGeometry.height, expectedGeometry.width * expectedGeometry.height],
    `${label}: ROI geometry does not match the decoded export`,
  );
  assert.ok(region.subtitleMaskPixels >= MIN_SUBTITLE_MASK_PIXELS, (
    `${label}: Main/Render subtitle mask has only ${region.subtitleMaskPixels} pixels`
  ));
  assert.ok(region.subtitleMaskRatio >= MIN_SUBTITLE_MASK_RATIO
    && region.subtitleMaskRatio <= MAX_SUBTITLE_MASK_RATIO, (
    `${label}: subtitle mask ratio ${region.subtitleMaskRatio} is implausible`
  ));
  assert.ok(region.roiPixels >= region.subtitleMaskPixels && region.roiPixels < region.totalPixels, (
    `${label}: expanded subtitle ROI is invalid`
  ));
  assert.ok(region.mainMaskPixels >= MIN_SUBTITLE_MASK_PIXELS, `${label}: Main has no subtitle mask`);
  assert.ok(region.renderMaskPixels >= MIN_SUBTITLE_MASK_PIXELS, `${label}: Render has no subtitle mask`);
  assert.ok(region.exportMaskPixels >= MIN_SUBTITLE_MASK_PIXELS, `${label}: export has no subtitle signal`);
  assert.ok(region.exportMaskRatio <= MAX_EXPORT_MASK_RATIO, (
    `${label}: export/source difference covers ${region.exportMaskRatio} of the frame and cannot `
      + 'prove a localized subtitle composition'
  ));
  // Coverage is judged against each REAL surface's own ink footprint. The old union denominator
  // inflated whenever the two capture paths diverged, so the primary claim still uses the
  // stronger surface. A separate weaker-surface floor prevents an either/or escape in which the
  // export follows one preview path but substantially abandons the other.
  const exportSurfaceCoverages = [
    region.exportMainMaskCoverage ?? 0,
    region.exportRenderMaskCoverage ?? 0,
  ];
  const strongerSurfaceCoverage = Math.max(...exportSurfaceCoverages);
  const weakerSurfaceCoverage = Math.min(...exportSurfaceCoverages);
  assert.ok(strongerSurfaceCoverage >= MIN_EXPORT_MASK_COVERAGE, (
    `${label}: export covers only ${strongerSurfaceCoverage} of the stronger surface subtitle mask`
  ));
  assert.ok(weakerSurfaceCoverage >= MIN_EXPORT_SECONDARY_MASK_COVERAGE, (
    `${label}: export covers only ${weakerSurfaceCoverage} of the weaker surface subtitle mask`
  ));
  // Exact-pixel mask geometry is meaningful only when both masks are strong. At a faint sample
  // (low eased alpha over a glow) the per-surface masks are dominated by how each capture path
  // rasterizes the SAME video — canvas-composed versus raw element — so both their overlap (22%
  // measured for correct ink) and their centroids (0.11 of the frame apart for co-located ink,
  // with the decoded export sitting between them) are instrument noise, not placement truth.
  // Faint-phase Main/Render agreement is still bounded by pairs.mainRender below, which compares
  // actual pixels inside the shared ROI, and every case keeps a strong phase where this exact
  // overlap claim runs.
  const weakestSurfaceMask = Math.min(region.mainMaskPixels, region.renderMaskPixels);
  if (weakestSurfaceMask >= STRONG_SURFACE_MASK_PIXELS) {
    assert.ok(region.mainRenderMaskOverlap >= MIN_SURFACE_MASK_OVERLAP, (
      `${label}: Main/Render subtitle-mask overlap ${region.mainRenderMaskOverlap} is too low`
    ));
  }
  // Placement agreement: MIN_EXPORT_MASK_COVERAGE and the ROI pairs checks below both judge the
  // export's ink as a loose region -- a whole box translated sideways can still cover most of its
  // own original footprint and stay under the ROI distance/ratio caps once the box is wide enough
  // relative to the shift (see the mutation suite's "wide-box 40px translation" fixture). Centroid
  // displacement is the direct positional claim those checks were never actually making. Gated on
  // STRONG_PLACEMENT_MASK_PIXELS (not the lower STRONG_SURFACE_MASK_PIXELS used for exact-pixel
  // overlap above) because small/thin masks carry disproportionate rasterization noise in their
  // centroid specifically -- see the constant's comment for the real-evidence measurement.
  const placementPairs = [
    region.mainMaskPixels >= STRONG_PLACEMENT_MASK_PIXELS
      && region.exportMaskPixels >= STRONG_PLACEMENT_MASK_PIXELS
      ? ['Main', centroidDistance(region.mainMaskCentroid, region.exportMaskCentroid)]
      : null,
    region.renderMaskPixels >= STRONG_PLACEMENT_MASK_PIXELS
      && region.exportMaskPixels >= STRONG_PLACEMENT_MASK_PIXELS
      ? ['Render', centroidDistance(region.renderMaskCentroid, region.exportMaskCentroid)]
      : null,
  ].filter(pair => pair !== null && Number.isFinite(pair[1]));
  if (placementPairs.length > 0) {
    // Judge against the FARTHER surface, not the closer one. This oracle exists to catch Main and
    // Render/export disagreeing, so accepting the best of the two hands back exactly the defect it
    // is here to find: an export that tracks Render while drifting from Main used to score a
    // perfect 0px. Measured on the preserved 10-case matrix, the closest-surface form let
    // 04-slide-left-stroke hide a 60px joint Render+export translation -- 12.5% of the 480px frame.
    // Taking the worst pair halves that blind zone to 30px with no case regressing and every real
    // baseline still passing.
    const [worstSurface, worstDistance] = placementPairs.reduce((best, candidate) => (
      candidate[1] > best[1] ? candidate : best
    ));
    assert.ok(worstDistance <= EXPORT_PARITY_CENTROID_DISPLACEMENT_PX, (
      `${label}: export placement disagrees with ${worstSurface} by `
        + `${worstDistance}px (cap ${EXPORT_PARITY_CENTROID_DISPLACEMENT_PX}px) `
        + '-- a translation, not a rendering variance'
    ));
  }
  assert.ok(region.pairs && region.signals, `${label}: ROI comparisons are absent`);
  for (const [pair, measurement] of Object.entries(region.pairs)) {
    assert.ok(measurement.meanRgbDistance <= MAX_ROI_MEAN_DISTANCE, (
      `${label}: ${pair} mean ROI distance ${measurement.meanRgbDistance} is too high`
    ));
    assert.ok(measurement.changedRatio <= MAX_ROI_CHANGED_RATIO, (
      `${label}: ${pair} changed ${measurement.changedRatio} of the subtitle ROI`
    ));
  }
  for (const [surface, measurement] of Object.entries(region.signals)) {
    assert.ok(measurement.meanRgbDistance >= MIN_SOURCE_SIGNAL_MEAN_DISTANCE, (
      `${label}: ${surface} is indistinguishable from independently decoded source`
    ));
    // A tiny animation-entry ROI (a bounce or scale cue at low progress) can be smaller than the
    // fixed floor itself; distinguishability there means a meaningful fraction of that small ROI.
    const signalFloor = Math.min(
      MIN_SOURCE_SIGNAL_PIXELS,
      Math.max(24, Math.floor(region.roiPixels / 4)),
    );
    assert.ok(measurement.changedPixels >= signalFloor, (
      `${label}: ${surface} changes only ${measurement.changedPixels} ROI pixels against the decoded source (floor ${signalFloor})`
    ));
  }
};

export const verifyTemporalDelta = (delta, definition, surface) => {
  assert.ok(delta && Number.isSafeInteger(delta.changedPixels), (
    `${definition.id}: ${surface} entry/exit delta is absent`
  ));
  assert.ok(delta.changedPixels >= MIN_TEMPORAL_CHANGED_PIXELS
    && delta.changedRatio >= MIN_TEMPORAL_CHANGED_RATIO
    && delta.maximumChannelDelta >= EXPORT_PARITY_MASK_DELTA, (
    `${definition.id}: ${surface} entry/exit frames are not materially distinct`
  ));
};

export const verifyPhaseBehavior = (definition, entry, exit) => {
  const entryCentroid = entry.maskCentroid;
  const exitCentroid = exit.maskCentroid;
  assert.ok([entryCentroid?.x, entryCentroid?.y, exitCentroid?.x, exitCentroid?.y]
    .every(Number.isFinite), `${definition.id}: phase mask centroid is unavailable`);
  const minimumHorizontalShift = entry.width * 0.005;
  const minimumVerticalShift = entry.height * 0.005;
  if (definition.animationType === 'slide-left') {
    assert.ok(entryCentroid.x - exitCentroid.x >= minimumHorizontalShift, (
      `${definition.id}: slide-left entry/exit masks do not cross horizontally`
    ));
  } else if (definition.animationType === 'slide-right') {
    assert.ok(exitCentroid.x - entryCentroid.x >= minimumHorizontalShift, (
      `${definition.id}: slide-right entry/exit masks do not cross horizontally`
    ));
  } else if (definition.animationType === 'slide-up') {
    assert.ok(entryCentroid.y - exitCentroid.y >= minimumVerticalShift, (
      `${definition.id}: slide-up entry/exit masks do not cross vertically`
    ));
  } else if (definition.animationType === 'slide-down') {
    assert.ok(exitCentroid.y - entryCentroid.y >= minimumVerticalShift, (
      `${definition.id}: slide-down entry/exit masks do not cross vertically`
    ));
  } else if (definition.animationType === 'typewriter') {
    // No mask-growth demand: the constant double-border box dominates both phases' masks (37k
    // entry versus 37k exit measured, the reveal delta inside anti-aliasing variance), so the
    // instrument cannot see typing progress here. Reveal progression is owned natively by the
    // material sweep and the compositor's typewriter render tests; this matrix owns per-instant
    // parity, which the SSIM, ROI and distinct-bytes claims above already pin for both phases.
  } else if (['bounce', 'flip', 'rotate'].includes(definition.animationType)) {
    assert.notEqual(entry.maskSignature, exit.maskSignature, (
      `${definition.id}: animated entry/exit subtitle masks are identical`
    ));
  } else {
    const ratio = entry.subtitleMaskPixels / exit.subtitleMaskPixels;
    assert.ok(ratio >= 0.65 && ratio <= 1.55, (
      `${definition.id}: symmetric phase mask coverage drifted by ${ratio}`
    ));
  }
};
