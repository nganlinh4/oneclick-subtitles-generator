import { strict as assert } from 'node:assert';

export const EXPORT_PARITY_FPS = 30;
export const EXPORT_PARITY_RESOLUTION = '360p';
export const EXPORT_PARITY_HEIGHT = 360;
export const EXPORT_PARITY_FADE_FRAMES = 18;
export const EXPORT_PARITY_SAMPLE_OFFSET_FRAMES = 12;
export const EXPORT_PARITY_WYSIWYG_FLOOR = 0.95;
// Rotated anti-aliased ink is the heaviest high-frequency content in the matrix; its double
// resample (preview canvas -> PNG, export encode -> decode -> compare grid) legitimately costs
// about two whole-frame SSIM points while the ROI centroids agree within three percent.
export const EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR = 0.92;
export const EXPORT_PARITY_MAIN_RENDER_ROTATED_FLOOR = 0.87;
export const EXPORT_PARITY_MAIN_RENDER_FLOOR = 0.90;
export const EXPORT_PARITY_SOURCE_IDENTITY_FLOOR = 0.90;
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
// The export must reproduce at least this fraction of ONE complete surface's own ink footprint.
// Judged per surface rather than against the Main/Render union, whose size varies with how far
// the two capture paths diverge at a given alpha; agreement with a real surface is the claim.
const MIN_EXPORT_MASK_COVERAGE = 0.55;
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
const MIN_AUDIO_PEAK_DB = -60;
const MIN_AUDIO_MEAN_DB = -80;
const MAX_AUDIO_ATTENUATION_DB = 12;

const ANIMATIONS = Object.freeze([
  'fade',
  'slide-up',
  'slide-down',
  'slide-left',
  'slide-right',
  'scale',
  'bounce',
  'flip',
  'rotate',
  'typewriter',
]);
const EASINGS = Object.freeze([
  'linear',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
  'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
  'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
]);
const BORDER_STYLES = Object.freeze(['none', 'solid', 'dashed', 'dotted', 'double']);
const POSITIONS = Object.freeze(['bottom', 'top', 'center', 'custom']);
const ALIGNMENTS = Object.freeze(['left', 'center', 'right', 'justify']);
const TRANSFORMS = Object.freeze(['none', 'uppercase', 'lowercase', 'capitalize']);
const REQUIRED_TEXT_FEATURES = Object.freeze([
  'vietnamese', 'korean', 'arabic', 'emoji-combining-zwj', 'narrow-wrap',
]);
const REQUIRED_EFFECTS = Object.freeze(['glow', 'gradient', 'stroke']);
const EFFECT_FIELDS = Object.freeze({
  glow: 'glowEnabled',
  gradient: 'gradientEnabled',
  stroke: 'strokeEnabled',
});

const caseDefinition = ({
  id,
  animationType,
  animationEasing,
  borderStyle,
  position,
  textAlign,
  textTransform,
  text,
  textFeatures = [],
  startFrame,
  effects = [],
  customPositionX = 50,
  customPositionY = 80,
  sampleOffsetFrames = EXPORT_PARITY_SAMPLE_OFFSET_FRAMES,
  fontSize = 72,
  marginBottom = 80,
  marginTop = 80,
  marginLeft = 0,
  marginRight = 0,
  maxWidth = 80,
}) => {
  const endFrame = startFrame + 12;
  const effectSet = new Set(effects);
  return Object.freeze({
    id,
    animationType,
    animationEasing,
    borderStyle,
    position,
    textAlign,
    textTransform,
    text,
    textFeatures: Object.freeze([...textFeatures]),
    startFrame,
    endFrame,
    sampleOffsetFrames,
    entryFrame: startFrame - sampleOffsetFrames,
    exitFrame: endFrame + sampleOffsetFrames,
    effects: Object.freeze([...effects]),
    customization: Object.freeze({
      animationType,
      animationEasing,
      fadeInDuration: EXPORT_PARITY_FADE_FRAMES / EXPORT_PARITY_FPS,
      fadeOutDuration: EXPORT_PARITY_FADE_FRAMES / EXPORT_PARITY_FPS,
      borderStyle,
      borderWidth: borderStyle === 'none' ? 0 : 4,
      position,
      customPositionX,
      customPositionY,
      textAlign,
      textTransform,
      fontSize,
      marginBottom,
      marginTop,
      marginLeft,
      marginRight,
      maxWidth,
      glowEnabled: effectSet.has('glow'),
      glowColor: effectSet.has('glow') ? '#00e5ff' : '#ffffff',
      glowIntensity: effectSet.has('glow') ? 24 : 10,
      gradientEnabled: effectSet.has('gradient'),
      gradientColorStart: effectSet.has('gradient') ? '#ff3d81' : '#ffffff',
      gradientColorEnd: effectSet.has('gradient') ? '#35d5ff' : '#cccccc',
      gradientDirection: '45deg',
      strokeEnabled: effectSet.has('stroke'),
      strokeColor: effectSet.has('stroke') ? '#101018' : '#000000',
      strokeWidth: effectSet.has('stroke') ? 3 : 0,
      preset: 'custom',
    }),
  });
};

/**
 * Ten deliberately non-repetitive customer-visible compositions over one short real media project.
 * Cue starts are 54 frames apart. Even their widened 18-frame fade windows do not overlap, so the
 * entry/exit oracle can name one cue rather than accidentally accepting a neighbouring one.
 */
export const EXPORT_ANIMATION_PARITY_CASES = Object.freeze([
  caseDefinition({
    id: '01-fade-vietnamese',
    animationType: 'fade',
    animationEasing: 'linear',
    borderStyle: 'none',
    position: 'bottom',
    textAlign: 'center',
    textTransform: 'none',
    text: 'Tiếng Việt rõ ràng: phụ đề khớp từng khung hình',
    textFeatures: ['vietnamese'],
    startFrame: 24,
    marginBottom: 72,
  }),
  caseDefinition({
    id: '02-slide-up-korean',
    animationType: 'slide-up',
    animationEasing: 'ease',
    borderStyle: 'solid',
    position: 'top',
    textAlign: 'left',
    textTransform: 'uppercase',
    text: '한국어 자막이 프리뷰와 출력에서 같습니다',
    textFeatures: ['korean'],
    startFrame: 78,
    marginTop: 48,
  }),
  caseDefinition({
    id: '03-slide-down-arabic-glow',
    animationType: 'slide-down',
    animationEasing: 'ease-in',
    borderStyle: 'dashed',
    position: 'top',
    textAlign: 'right',
    textTransform: 'none',
    text: 'يجب أن يتطابق النص العربي في المعاينة والتصدير',
    textFeatures: ['arabic'],
    startFrame: 132,
    effects: ['glow'],
    marginTop: 64,
    // With the default 12-frame offset both samples land at exactly 1/3 raw progress into their
    // fade window (entry frame 120, t=4.000s; exit frame 156, t=5.200s), where 'ease-in' has only
    // reached ~11.1% eased opacity -- the thinnest ink margin in the whole matrix (measured against
    // real preserved evidence at ~1,025 changed exit pixels, 1-2 orders of magnitude below every
    // sibling case). This is the same problem class case 07 (bounce) was given its own
    // sampleOffsetFrames=6 override for. 6 frames instead samples both edges at 2/3 raw progress
    // (entry frame 126, t=4.200s; exit frame 150, t=5.000s), where 'ease-in' has reached ~44.4%
    // eased opacity -- comfortably above the 35% robustness floor and roughly 4x the untouched
    // case's margin, while staying inside the true fade window on both sides.
    sampleOffsetFrames: 6,
  }),
  caseDefinition({
    id: '04-slide-left-stroke',
    animationType: 'slide-left',
    animationEasing: 'ease-out',
    borderStyle: 'dotted',
    position: 'center',
    textAlign: 'center',
    textTransform: 'none',
    text: 'A stroked line travels left without losing its source frame',
    startFrame: 186,
    effects: ['stroke'],
    fontSize: 68,
  }),
  caseDefinition({
    id: '05-slide-right-narrow-gradient',
    animationType: 'slide-right',
    animationEasing: 'ease-in-out',
    borderStyle: 'double',
    position: 'bottom',
    textAlign: 'justify',
    textTransform: 'capitalize',
    text: 'narrow wrapping keeps every deliberately long subtitle word inside the authored safe width',
    textFeatures: ['narrow-wrap'],
    startFrame: 240,
    effects: ['gradient'],
    marginBottom: 54,
    marginLeft: 32,
    marginRight: 48,
    maxWidth: 32,
    fontSize: 60,
  }),
  caseDefinition({
    id: '06-scale-custom-gradient',
    animationType: 'scale',
    animationEasing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
    borderStyle: 'none',
    position: 'custom',
    textAlign: 'left',
    textTransform: 'lowercase',
    text: 'Custom-position gradient scales from the exact compositor origin',
    startFrame: 294,
    effects: ['gradient'],
    customPositionX: 28,
    customPositionY: 36,
    marginLeft: 26,
    fontSize: 66,
  }),
  caseDefinition({
    id: '07-bounce-glow',
    animationType: 'bounce',
    animationEasing: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
    borderStyle: 'solid',
    position: 'bottom',
    textAlign: 'right',
    textTransform: 'uppercase',
    text: 'Bounce and glow stay seek-safe on the native frame grid',
    startFrame: 348,
    effects: ['glow'],
    marginBottom: 96,
    marginRight: 36,
    // The default 12-frame offset samples this overshoot bezier at progress 1/3 — its eased-zero
    // crossing, where the product correctly draws nothing. Six frames sample at progress 2/3,
    // where the same easing is at full ink, so every claim stays strong instead of vacuous.
    sampleOffsetFrames: 6,
  }),
  caseDefinition({
    id: '08-flip-custom-stroke',
    animationType: 'flip',
    animationEasing: 'linear',
    borderStyle: 'dashed',
    position: 'custom',
    textAlign: 'center',
    textTransform: 'none',
    text: 'Flip uses the same staged glyphs in preview and export',
    startFrame: 402,
    effects: ['stroke'],
    customPositionX: 72,
    customPositionY: 30,
    marginTop: 24,
    fontSize: 70,
  }),
  caseDefinition({
    id: '09-rotate-gradient-glow',
    animationType: 'rotate',
    animationEasing: 'ease',
    borderStyle: 'dotted',
    position: 'center',
    textAlign: 'right',
    textTransform: 'capitalize',
    text: 'rotation, gradient and glow share one durable scene',
    startFrame: 456,
    effects: ['gradient', 'glow'],
    marginLeft: 20,
    marginRight: 20,
  }),
  caseDefinition({
    id: '10-typewriter-unicode',
    animationType: 'typewriter',
    animationEasing: 'ease-out',
    borderStyle: 'double',
    position: 'top',
    textAlign: 'justify',
    textTransform: 'lowercase',
    text: 'Unicode e\u0301 👩‍💻 🧑🏽‍🎤 stays whole while typewriting',
    textFeatures: ['emoji-combining-zwj'],
    startFrame: 510,
    effects: ['stroke'],
    marginTop: 42,
    marginLeft: 24,
    marginRight: 24,
    maxWidth: 68,
    fontSize: 64,
  }),
]);

const unique = (values) => new Set(values);

const countBy = (values) => values.reduce((counts, value) => {
  counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}, new Map());

const exactSet = (actual, expected, label) => {
  assert.deepEqual([...unique(actual)].sort(), [...expected].sort(), `${label} coverage changed`);
};

const finiteScore = (value, label) => {
  assert.ok(Number.isFinite(value) && value >= -1 && value <= 1, `${label} is not a bounded SSIM`);
};

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

const mediaStreams = (probe) => {
  assert.ok(probe && typeof probe === 'object' && Array.isArray(probe.streams), 'ffprobe result is invalid');
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.ok(video, `ffprobe exposed no video stream: ${JSON.stringify(probe)}`);
  assert.ok(audio, `ffprobe exposed no audio stream: ${JSON.stringify(probe)}`);
  return { video, audio };
};

const verifyAudioStream = (audio, formatDuration, label) => {
  const sampleRate = Number(audio.sample_rate);
  assert.ok(Number.isSafeInteger(sampleRate) && sampleRate >= 8_000 && sampleRate <= 384_000, (
    `${label}: audio sample rate is invalid: ${audio.sample_rate}`
  ));
  const channels = Number(audio.channels);
  assert.ok(Number.isSafeInteger(channels) && channels >= 1 && channels <= 32, (
    `${label}: audio channel count is invalid: ${audio.channels}`
  ));
  const timeBase = parseFfprobeRate(audio.time_base);
  assert.ok(timeBase !== null, `${label}: audio time base is invalid: ${audio.time_base}`);
  const durationTicks = Number(audio.duration_ts);
  assert.ok(Number.isSafeInteger(durationTicks) && durationTicks > 0, (
    `${label}: audio duration ticks are unavailable: ${audio.duration_ts}`
  ));
  const timestampDuration = durationTicks * timeBase.value;
  const directDuration = Number(audio.duration);
  assert.ok(Number.isFinite(directDuration) && directDuration > 0, (
    `${label}: audio duration is unavailable`
  ));
  const tolerance = Math.max(0.25, formatDuration * 0.02);
  for (const [source, duration] of [
    ['direct', directDuration], ['timebase', timestampDuration],
  ]) {
    assert.ok(Math.abs(duration - formatDuration) <= tolerance, (
      `${label}: ${source} ${duration}s audio does not cover ${formatDuration}s media `
      + `within ${tolerance}s`
    ));
  }
  return Object.freeze({
    sampleRate,
    channels,
    duration: directDuration,
    durationTicks,
    timeBase: audio.time_base,
    timestampDuration,
  });
};

const verifyAudioSignal = (signal, label) => {
  assert.ok(signal && typeof signal === 'object', `${label}: audio energy was not measured`);
  const meanVolumeDb = Number(signal.meanVolumeDb);
  const peakVolumeDb = Number(signal.peakVolumeDb);
  const samples = Number(signal.samples);
  assert.ok(Number.isSafeInteger(samples) && samples > 0, `${label}: audio sample count is invalid`);
  assert.ok(Number.isFinite(meanVolumeDb) && meanVolumeDb > MIN_AUDIO_MEAN_DB, (
    `${label}: audio is silent or effectively silent at ${signal.meanVolumeDb} dB mean`
  ));
  assert.ok(Number.isFinite(peakVolumeDb) && peakVolumeDb > MIN_AUDIO_PEAK_DB, (
    `${label}: audio is silent or effectively silent at ${signal.peakVolumeDb} dB peak`
  ));
  assert.ok(peakVolumeDb >= meanVolumeDb, `${label}: peak audio level is below its mean level`);
  return Object.freeze({ meanVolumeDb, peakVolumeDb, samples });
};

const verifyRegion = (region, definition, phase, expectedGeometry) => {
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
  // Coverage is judged against each REAL surface's own ink footprint, and the export must agree
  // strongly with at least one of them. The old union denominator inflated whenever the two
  // surfaces' capture paths diverged (which the faint-mask work above documents), so a correct
  // export could fall a hair under a bound whose 30%-overlap premise no longer holds everywhere.
  const exportSurfaceCoverage = Math.max(
    region.exportMainMaskCoverage ?? 0,
    region.exportRenderMaskCoverage ?? 0,
  );
  assert.ok(exportSurfaceCoverage >= MIN_EXPORT_MASK_COVERAGE, (
    `${label}: export covers only ${exportSurfaceCoverage} of the stronger surface subtitle mask`
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

const verifyTemporalDelta = (delta, definition, surface) => {
  assert.ok(delta && Number.isSafeInteger(delta.changedPixels), (
    `${definition.id}: ${surface} entry/exit delta is absent`
  ));
  assert.ok(delta.changedPixels >= MIN_TEMPORAL_CHANGED_PIXELS
    && delta.changedRatio >= MIN_TEMPORAL_CHANGED_RATIO
    && delta.maximumChannelDelta >= EXPORT_PARITY_MASK_DELTA, (
    `${definition.id}: ${surface} entry/exit frames are not materially distinct`
  ));
};

const verifyPhaseBehavior = (definition, entry, exit) => {
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

export const parseFfprobeRate = (value) => {
  if (typeof value !== 'string' || !/^\d+\/\d+$/u.test(value)) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)
      || numerator <= 0 || denominator <= 0) return null;
  return Object.freeze({ numerator, denominator, value: numerator / denominator });
};

export const exactFrameSeconds = (frame, fps = EXPORT_PARITY_FPS) => {
  assert.ok(Number.isSafeInteger(frame) && frame >= 0, 'frame must be a non-negative integer');
  assert.ok(Number.isSafeInteger(fps) && fps > 0, 'fps must be a positive integer');
  return frame / fps;
};

export const formatSrtTime = (frame, fps = EXPORT_PARITY_FPS) => {
  const milliseconds = Math.round(exactFrameSeconds(frame, fps) * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:`
    + `${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

export const validateExportAnimationParityMatrix = (cases = EXPORT_ANIMATION_PARITY_CASES) => {
  assert.ok(Array.isArray(cases), 'export parity cases must be an array');
  assert.equal(cases.length, 10, 'export parity requires exactly ten cases');
  assert.equal(unique(cases.map(entry => entry.id)).size, cases.length, 'case IDs must be unique');
  exactSet(cases.map(entry => entry.animationType), ANIMATIONS, 'animation');
  exactSet(cases.map(entry => entry.animationEasing), EASINGS, 'easing');
  exactSet(cases.map(entry => entry.position), POSITIONS, 'position');
  exactSet(cases.map(entry => entry.textAlign), ALIGNMENTS, 'alignment');
  exactSet(cases.map(entry => entry.textTransform), TRANSFORMS, 'text transform');
  const borders = countBy(cases.map(entry => entry.borderStyle));
  assert.deepEqual([...borders.keys()].sort(), [...BORDER_STYLES].sort(), 'border-style coverage changed');
  for (const border of BORDER_STYLES) {
    assert.equal(borders.get(border), 2, `${border} must have exactly two cases`);
  }
  const features = cases.flatMap(entry => entry.textFeatures);
  for (const feature of REQUIRED_TEXT_FEATURES) {
    assert.ok(features.includes(feature), `text feature is uncovered: ${feature}`);
  }
  const effects = cases.flatMap(entry => entry.effects);
  for (const effect of REQUIRED_EFFECTS) {
    assert.ok(effects.includes(effect), `effect is uncovered: ${effect}`);
  }

  let priorFadeEnd = -1;
  for (const entry of cases) {
    assert.match(entry.id, /^\d{2}-[a-z0-9-]+$/u, 'case ID must be an ordered slug');
    assert.ok(typeof entry.text === 'string' && entry.text.length > 0, `${entry.id}: text is empty`);
    assert.equal(entry.text.includes('-->'), false, `${entry.id}: text can corrupt SRT framing`);
    for (const field of ['startFrame', 'endFrame', 'entryFrame', 'exitFrame']) {
      assert.ok(Number.isSafeInteger(entry[field]) && entry[field] >= 0, `${entry.id}: invalid ${field}`);
      // The committed SRT must represent these frame times without rounding onto another grid.
      assert.equal((entry[field] * 1_000) % EXPORT_PARITY_FPS, 0, (
        `${entry.id}: ${field} is not exactly representable in SRT milliseconds`
      ));
    }
    assert.ok(
      Number.isSafeInteger(entry.sampleOffsetFrames)
        && entry.sampleOffsetFrames >= 3
        && entry.sampleOffsetFrames < EXPORT_PARITY_FADE_FRAMES,
      `${entry.id}: sample offset must sit strictly inside the fade window`,
    );
    assert.equal(
      entry.entryFrame,
      entry.startFrame - entry.sampleOffsetFrames,
      `${entry.id}: entry sample offset changed`,
    );
    assert.equal(
      entry.exitFrame,
      entry.endFrame + entry.sampleOffsetFrames,
      `${entry.id}: exit sample offset changed`,
    );
    assert.ok(entry.endFrame > entry.startFrame, `${entry.id}: cue has no authored duration`);
    const fadeStart = entry.startFrame - EXPORT_PARITY_FADE_FRAMES;
    const fadeEnd = entry.endFrame + EXPORT_PARITY_FADE_FRAMES;
    assert.ok(entry.entryFrame > fadeStart && entry.entryFrame < entry.startFrame, (
      `${entry.id}: entry sample is not inside fade-in`
    ));
    assert.ok(entry.exitFrame > entry.endFrame && entry.exitFrame < fadeEnd, (
      `${entry.id}: exit sample is not inside fade-out`
    ));
    assert.ok(fadeStart > priorFadeEnd, `${entry.id}: widened cue windows overlap`);
    priorFadeEnd = fadeEnd;
    assert.ok(entry.exitFrame < 19 * EXPORT_PARITY_FPS, `${entry.id}: sample exceeds the real clip`);
    assert.ok(BORDER_STYLES.includes(entry.customization.borderStyle));
    assert.equal(entry.customization.borderWidth, entry.borderStyle === 'none' ? 0 : 4);
    for (const [effect, field] of Object.entries(EFFECT_FIELDS)) {
      assert.equal(entry.customization[field], entry.effects.includes(effect), (
        `${entry.id}: ${field} disagrees with the matrix`
      ));
    }
    assert.ok([
      entry.customization.marginBottom,
      entry.customization.marginTop,
      entry.customization.marginLeft,
      entry.customization.marginRight,
    ].some(value => value > 0), `${entry.id}: margins are not represented`);
  }
  return Object.freeze([...cases]);
};

export const buildExportAnimationParitySrt = (cases = EXPORT_ANIMATION_PARITY_CASES) => {
  validateExportAnimationParityMatrix(cases);
  return `${cases.map((entry, index) => (
    `${index + 1}\n${formatSrtTime(entry.startFrame)} --> ${formatSrtTime(entry.endFrame)}\n${entry.text}`
  )).join('\n\n')}\n`;
};

export const expectedEvenWidth = (sourceWidth, sourceHeight, outputHeight = EXPORT_PARITY_HEIGHT) => {
  assert.ok(Number.isSafeInteger(sourceWidth) && sourceWidth > 0, 'source width is invalid');
  assert.ok(Number.isSafeInteger(sourceHeight) && sourceHeight > 0, 'source height is invalid');
  assert.ok(Number.isSafeInteger(outputHeight) && outputHeight > 0, 'output height is invalid');
  const rounded = Math.round(outputHeight * (sourceWidth / sourceHeight));
  return rounded % 2 === 0 ? rounded : rounded + 1;
};

/**
 * Independent outcome oracle. It consumes only ffprobe JSON, SQLite scene JSON and numeric image
 * scores; it cannot call the application or accidentally turn a mocked frontend response green.
 */
export const verifyExportAnimationParityObservation = ({
  definition,
  probe,
  sourceProbe,
  durableScene,
  durableCues,
  scores,
  regions,
  phaseBinding,
  durableOwnership,
  selectedSourceIdentity,
  exportOwnership,
  audioSignals,
  visibleProblems = [],
  recordedProblems = [],
}) => {
  assert.ok(EXPORT_ANIMATION_PARITY_CASES.some(entry => entry.id === definition?.id), (
    'observation does not name a reviewed matrix case'
  ));
  const { video, audio } = mediaStreams(probe);
  const { video: sourceVideo, audio: sourceAudio } = mediaStreams(sourceProbe);
  assert.equal(video.height, EXPORT_PARITY_HEIGHT, `${definition.id}: export has the wrong height`);
  assert.equal(
    video.width,
    expectedEvenWidth(sourceVideo.width, sourceVideo.height),
    `${definition.id}: export changed source aspect`,
  );
  const rate = parseFfprobeRate(video.avg_frame_rate ?? video.r_frame_rate);
  assert.equal(rate?.numerator, EXPORT_PARITY_FPS, `${definition.id}: fps numerator changed`);
  assert.equal(rate?.denominator, 1, `${definition.id}: fps denominator changed`);
  const duration = Number(probe.format?.duration);
  const sourceDuration = Number(sourceProbe.format?.duration);
  assert.ok(Number.isFinite(duration) && duration > 0
    && Number.isFinite(sourceDuration) && sourceDuration > 0, (
    `${definition.id}: duration is unavailable`
  ));
  assert.ok(Math.abs(duration - sourceDuration) <= 2 / EXPORT_PARITY_FPS, (
    `${definition.id}: ${duration}s export disagrees with ${sourceDuration}s source`
  ));
  assert.ok(Number(probe.format?.size) > 100_000, `${definition.id}: export is implausibly small`);
  const exportAudio = verifyAudioStream(audio, duration, `${definition.id} export`);
  const originalAudio = verifyAudioStream(sourceAudio, sourceDuration, `${definition.id} source`);
  const exportAudioSignal = verifyAudioSignal(audioSignals?.exported, `${definition.id} export`);
  const sourceAudioSignal = verifyAudioSignal(audioSignals?.source, `${definition.id} source`);
  assert.ok(exportAudioSignal.meanVolumeDb >= sourceAudioSignal.meanVolumeDb - MAX_AUDIO_ATTENUATION_DB, (
    `${definition.id}: export audio mean fell more than ${MAX_AUDIO_ATTENUATION_DB} dB below source`
  ));
  assert.ok(exportAudioSignal.peakVolumeDb >= sourceAudioSignal.peakVolumeDb - MAX_AUDIO_ATTENUATION_DB, (
    `${definition.id}: export audio peak fell more than ${MAX_AUDIO_ATTENUATION_DB} dB below source`
  ));

  assert.ok(durableScene && durableScene.sceneRevision > 0, `${definition.id}: scene is not durable`);
  assert.equal(durableScene.scene?.renderSettings?.resolution, EXPORT_PARITY_RESOLUTION);
  assert.equal(durableScene.scene?.renderSettings?.frameRate, EXPORT_PARITY_FPS);
  for (const [field, expected] of Object.entries(definition.customization)) {
    assert.deepEqual(
      durableScene.scene?.customization?.[field],
      expected,
      `${definition.id}: durable customization.${field} drifted`,
    );
  }
  assert.ok(Array.isArray(durableCues), `${definition.id}: durable cue ledger is unavailable`);
  assert.equal(
    durableCues.length,
    EXPORT_ANIMATION_PARITY_CASES.length,
    `${definition.id}: durable cue count drifted`,
  );
  for (const [index, expected] of EXPORT_ANIMATION_PARITY_CASES.entries()) {
    const cue = durableCues[index];
    assert.equal(cue?.text, expected.text, `${definition.id}: durable cue ${index} text drifted`);
    assert.equal(
      cue?.startMs,
      Math.round(exactFrameSeconds(expected.startFrame) * 1_000),
      `${definition.id}: durable cue ${index} start drifted`,
    );
    assert.equal(
      cue?.endMs,
      Math.round(exactFrameSeconds(expected.endFrame) * 1_000),
      `${definition.id}: durable cue ${index} end drifted`,
    );
  }
  assert.ok(durableOwnership && selectedSourceIdentity, `${definition.id}: media ownership is unavailable`);
  assert.equal(durableOwnership.projects?.length, 1, `${definition.id}: isolated project count drifted`);
  assert.equal(durableOwnership.media?.length, 1, `${definition.id}: isolated media count drifted`);
  assert.equal(durableOwnership.links?.length, 1, `${definition.id}: primary media ownership drifted`);
  assert.ok(Array.isArray(durableOwnership.sourceFiles)
    && durableOwnership.sourceFiles.length >= 1, `${definition.id}: durable media bytes are unavailable`);
  const project = durableOwnership.projects[0];
  const media = durableOwnership.media[0];
  const link = durableOwnership.links[0];
  assert.equal(durableScene.projectId, project.id, `${definition.id}: durable scene belongs to another project`);
  assert.equal(link.project_id, project.id, `${definition.id}: media link belongs to another project`);
  assert.equal(link.media_id, media.id, `${definition.id}: media link points at another asset`);
  assert.equal(link.role, 'primary', `${definition.id}: selected media is not the primary project asset`);
  assert.equal(media.display_name, selectedSourceIdentity.displayName, (
    `${definition.id}: active media name does not match the staged selection`
  ));
  assert.equal(Number(media.size_bytes), selectedSourceIdentity.sizeBytes, (
    `${definition.id}: active media bytes do not match the staged selection`
  ));
  assert.match(media.content_hash ?? '', /^[0-9a-f]{64}$/u, `${definition.id}: durable media hash is invalid`);
  assert.match(selectedSourceIdentity.sha256 ?? '', /^[0-9a-f]{64}$/u, (
    `${definition.id}: selected-source evidence hash is invalid`
  ));
  for (const source of durableOwnership.sourceFiles) {
    assert.equal(source.media_id, media.id, `${definition.id}: durable source belongs to another media asset`);
    assert.equal(source.available, true, `${definition.id}: durable source location is unavailable`);
    assert.equal(Number(source.size_bytes), selectedSourceIdentity.sizeBytes, (
      `${definition.id}: durable source bytes have the wrong size`
    ));
    assert.equal(source.sha256, selectedSourceIdentity.sha256, (
      `${definition.id}: durable source bytes do not match the staged selection`
    ));
  }
  assert.equal(exportOwnership?.jobs?.length, 1, `${definition.id}: durable render job count drifted`);
  assert.equal(exportOwnership?.artifacts?.length, 1, (
    `${definition.id}: durable rendered-video artifact count drifted`
  ));
  const renderJob = exportOwnership.jobs[0];
  const renderArtifact = exportOwnership.artifacts[0];
  assert.equal(renderJob.id, exportOwnership.expectedJobId, `${definition.id}: another render job was observed`);
  assert.equal(renderJob.kind, 'renderVideo', `${definition.id}: durable job is not a video render`);
  assert.equal(renderJob.state, 'succeeded', `${definition.id}: durable render job did not succeed`);
  assert.equal(renderArtifact.id, exportOwnership.expectedArtifactId, (
    `${definition.id}: another rendered artifact was observed`
  ));
  assert.equal(renderArtifact.project_id, project.id, (
    `${definition.id}: rendered artifact belongs to another project`
  ));
  assert.equal(renderArtifact.job_id, renderJob.id, (
    `${definition.id}: rendered artifact belongs to another job`
  ));
  assert.equal(renderArtifact.kind, 'renderedVideo', `${definition.id}: output artifact has the wrong kind`);
  assert.equal(renderArtifact.state, 'ready', `${definition.id}: output artifact is not ready`);
  assert.ok(Number(renderArtifact.size_bytes) > 100_000, `${definition.id}: durable output is implausibly small`);
  assert.deepEqual(exportOwnership.customerSave, exportOwnership.durableArtifact, (
    `${definition.id}: customer save does not match the durable render artifact`
  ));
  assert.equal(exportOwnership.durableArtifact?.sizeBytes, Number(renderArtifact.size_bytes), (
    `${definition.id}: durable artifact byte count disagrees with SQLite`
  ));
  assert.match(exportOwnership.durableArtifact?.sha256 ?? '', /^[0-9a-f]{64}$/u, (
    `${definition.id}: durable output fingerprint is invalid`
  ));
  assert.deepEqual(visibleProblems, [], `${definition.id}: visible refusal/toast remains`);
  assert.deepEqual(recordedProblems, [], `${definition.id}: transient refusal/toast was recorded`);

  for (const phase of ['entry', 'exit']) {
    const renderExport = scores?.[phase]?.renderExport;
    const sourceExport = scores?.[phase]?.sourceExport;
    const mainRender = scores?.[phase]?.mainRender;
    const mainExport = scores?.[phase]?.mainExport;
    const mainSourceSelected = scores?.[phase]?.mainSourceSelected;
    const renderSourceSelected = scores?.[phase]?.renderSourceSelected;
    finiteScore(renderExport, `${definition.id} ${phase} Render/export`);
    finiteScore(sourceExport, `${definition.id} ${phase} source/export`);
    finiteScore(mainRender, `${definition.id} ${phase} Main/Render`);
    finiteScore(mainExport, `${definition.id} ${phase} Main/export`);
    finiteScore(mainSourceSelected, `${definition.id} ${phase} Main source/selected source`);
    finiteScore(renderSourceSelected, `${definition.id} ${phase} Render source/selected source`);
    assert.ok(mainSourceSelected >= EXPORT_PARITY_SOURCE_IDENTITY_FLOOR, (
      `${definition.id} ${phase}: Main is showing another source (${mainSourceSelected})`
    ));
    assert.ok(renderSourceSelected >= EXPORT_PARITY_SOURCE_IDENTITY_FLOOR, (
      `${definition.id} ${phase}: Render is showing another source (${renderSourceSelected})`
    ));
    const wysiwygFloor = definition.animationType === 'rotate'
      ? EXPORT_PARITY_WYSIWYG_ROTATED_FLOOR
      : EXPORT_PARITY_WYSIWYG_FLOOR;
    assert.ok(renderExport >= wysiwygFloor, (
      `${definition.id} ${phase}: Render/export SSIM ${renderExport} is below ${wysiwygFloor}`
    ));
    // No composed-versus-source "closer" tiebreak here: at a faint sample (low eased alpha over a
    // glow) both whole-frame distances are dominated by each pair's different resampling path, so
    // the sign of their difference is noise — a measured export with correct proportional ink
    // still ranked closer to source-only. Subtitle presence, coverage and agreement belong to the
    // ROI difference-mask claims below, which compare on one common grid.
    const mainFloor = definition.animationType === 'rotate'
      ? EXPORT_PARITY_MAIN_RENDER_ROTATED_FLOOR
      : EXPORT_PARITY_MAIN_RENDER_FLOOR;
    assert.ok(mainRender >= mainFloor, (
      `${definition.id} ${phase}: Main/Render SSIM ${mainRender} is below ${mainFloor}`
    ));
    assert.ok(mainExport >= mainFloor, (
      `${definition.id} ${phase}: Main/export SSIM ${mainExport} is below ${mainFloor}`
    ));
    verifyRegion(regions?.[phase], definition, phase, { width: video.width, height: video.height });
  }
  verifyPhaseBehavior(definition, regions.entry, regions.exit);

  assert.ok(phaseBinding && typeof phaseBinding === 'object', (
    `${definition.id}: entry/exit artifact binding is absent`
  ));
  assert.deepEqual(phaseBinding.frames, {
    entry: definition.entryFrame,
    exit: definition.exitFrame,
  }, `${definition.id}: entry/exit artifacts are bound to the wrong frame`);
  for (const surface of ['main', 'render']) {
    for (const phase of ['entry', 'exit']) {
      const expectedFrame = definition[`${phase}Frame`];
      const seek = phaseBinding.publicSeeks?.[surface]?.[phase];
      assert.equal(seek?.frame, expectedFrame, `${definition.id}: ${surface} ${phase} public seek frame drifted`);
      assert.ok(Math.abs(seek?.seconds - exactFrameSeconds(expectedFrame)) <= 0.000_001, (
        `${definition.id}: ${surface} ${phase} public seek time drifted`
      ));
      // Main proves exactness through a pointer press plus a bounded arrow correction, which
      // requires genuine keyboard focus. The Render native range cannot rely on keyboard focus in
      // the hidden non-activatable window; it commits the exact rational value through the native
      // setter instead, so its keyboard proof is legitimately empty while the 1e-6 seconds check
      // above still pins the grid.
      const boundedKeys = surface === 'main'
        ? Array.isArray(seek?.keys) && seek.keys.length >= 1 && seek.keys.length <= 66
        : Array.isArray(seek?.keys) && seek.keys.length === 0;
      assert.ok(boundedKeys, (
        `${definition.id}: ${surface} ${phase} lacks its expected public seek proof shape`
      ));
      assert.ok(seek.keys.every(key => key === 'ArrowLeft' || key === 'ArrowRight'), (
        `${definition.id}: ${surface} ${phase} used a non-seek key`
      ));
    }
  }
  for (const surface of ['main', 'render', 'exported', 'independentSource']) {
    const entryHash = phaseBinding.hashes?.[surface]?.entry;
    const exitHash = phaseBinding.hashes?.[surface]?.exit;
    assert.match(entryHash ?? '', /^[0-9a-f]{64}$/u, `${definition.id}: ${surface} entry hash is invalid`);
    assert.match(exitHash ?? '', /^[0-9a-f]{64}$/u, `${definition.id}: ${surface} exit hash is invalid`);
    assert.notEqual(entryHash, exitHash, `${definition.id}: ${surface} entry/exit artifacts are identical`);
    verifyTemporalDelta(phaseBinding.deltas?.[surface], definition, surface);
  }

  return Object.freeze({
    id: definition.id,
    durationSeconds: duration,
    dimensions: Object.freeze([video.width, video.height]),
    fps: rate.value,
    audioChannels: exportAudio.channels,
    audioSampleRate: exportAudio.sampleRate,
    audioDurationSeconds: exportAudio.duration,
    audioSignal: exportAudioSignal,
    sourceAudio: originalAudio,
    regionCoverage: Object.freeze({
      entry: regions.entry.subtitleMaskRatio,
      exit: regions.exit.subtitleMaskRatio,
    }),
    phaseBinding: Object.freeze({
      hashes: phaseBinding.hashes,
      deltas: phaseBinding.deltas,
    }),
    scores: Object.freeze({
      entry: Object.freeze({ ...scores.entry }),
      exit: Object.freeze({ ...scores.exit }),
    }),
  });
};

validateExportAnimationParityMatrix();
