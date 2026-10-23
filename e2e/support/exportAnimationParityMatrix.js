// The reviewed ten-case export animation matrix, its 30 fps frame grid and SRT serialization.

import { strict as assert } from 'node:assert';

export const EXPORT_PARITY_FPS = 30;
export const EXPORT_PARITY_RESOLUTION = '360p';
export const EXPORT_PARITY_HEIGHT = 360;
export const EXPORT_PARITY_FADE_FRAMES = 18;
export const EXPORT_PARITY_SAMPLE_OFFSET_FRAMES = 12;

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
    // At the default 12-frame offset this dark, narrow gradient is only one-third through its
    // ease-in-out fade. The real H.264 round trip preserves the composition but quantizes enough
    // of that faint high-frequency ink below the mask threshold to make the oracle measure codec
    // loss instead of placement parity (2.1% Render/export ROI change, 3.7 mean RGB distance in
    // preserved attempt 20260830150231440-44040-b19471e6). Sample at two-thirds progress, still
    // inside the animated edge, where the authored motion and wrapping remain fully exercised.
    sampleOffsetFrames: 6,
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

validateExportAnimationParityMatrix();
