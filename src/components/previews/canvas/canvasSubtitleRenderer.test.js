import {
  createCanvasSubtitleRenderer,
  subtitleBackgroundRgba,
  subtitleBorderBands,
  subtitleGradientVector,
} from './canvasSubtitleRenderer';
import { defaultCustomization } from '../../subtitleCustomization/defaultCustomization';

describe('subtitleBackgroundRgba', () => {
  it('pins the independent opacity to the same byte as native export', () => {
    expect(subtitleBackgroundRgba('#112233', 50)).toBe(
      `rgba(17,34,51,${127 / 255})`,
    );
  });

  it('multiplies long and shorthand intrinsic alpha instead of refusing them', () => {
    expect(subtitleBackgroundRgba('#11223380', 50)).toBe(
      `rgba(17,34,51,${64 / 255})`,
    );
    expect(subtitleBackgroundRgba('#abcd', 50)).toBe(
      `rgba(170,187,204,${110 / 255})`,
    );
  });

  it('preserves intrinsic alpha at full opacity and applies cue alpha last', () => {
    expect(subtitleBackgroundRgba('#11223380', 100, 0.5)).toBe(
      `rgba(17,34,51,${128 / 255 * 0.5})`,
    );
  });
});

describe('subtitleBorderBands', () => {
  it('matches the native double-border contract: ink, gap, ink in equal thirds', () => {
    expect(subtitleBorderBands(12, 'double')).toEqual([
      { inset: 0, width: 4 },
      { inset: 8, width: 4 },
    ]);
  });

  it('keeps every single-ring style at the complete authored width', () => {
    for (const style of ['solid', 'dashed', 'dotted']) {
      expect(subtitleBorderBands(12, style)).toEqual([{ inset: 0, width: 12 }]);
    }
    expect(subtitleBorderBands(0, 'double')).toEqual([]);
  });
});

describe('subtitleGradientVector', () => {
  it.each([
    ['0deg', 0, -1],
    ['90deg', 1, 0],
    ['45deg', Math.SQRT1_2, -Math.SQRT1_2],
    ['135deg', Math.SQRT1_2, Math.SQRT1_2],
    ['180deg', 0, 1],
    ['270deg', -1, 0],
  ])('uses the persisted CSS direction for %s', (value, expectedX, expectedY) => {
    const vector = subtitleGradientVector(value);
    expect(vector.x).toBeCloseTo(expectedX, 12);
    expect(vector.y).toBeCloseTo(expectedY, 12);
  });
});

const contextFor = (canvas) => {
  const context = {
    canvas,
    propertyWrites: [],
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(),
    rotate: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    setLineDash: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
  };
  const values = new Map();
  for (const property of [
    'fillStyle', 'globalAlpha', 'globalCompositeOperation', 'shadowBlur', 'shadowColor',
  ]) {
    Object.defineProperty(context, property, {
      configurable: true,
      get: () => values.get(property),
      set: (value) => {
        values.set(property, value);
        context.propertyWrites.push({ property, value });
      },
    });
  }
  return context;
};

it('freezes source pixels without overwriting the frame retained by the current publication', () => {
  const contexts = new Map();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
    if (!contexts.has(this)) contexts.set(this, contextFor(this));
    return contexts.get(this);
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const video = { videoWidth: 640, videoHeight: 360, readyState: 4 };
    const renderer = createCanvasSubtitleRenderer(canvas);
    const first = renderer.captureVideoFrame(video);
    const second = renderer.captureVideoFrame(video, first);
    const replacement = renderer.captureVideoFrame(video, first);

    expect(first.image).not.toBe(second.image);
    expect(replacement.image).toBe(second.image);
    expect(contexts.get(first.image).drawImage).toHaveBeenCalledTimes(1);
    expect(contexts.get(second.image).drawImage).toHaveBeenCalledTimes(2);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

it('publishes a complete preview frame with one visible-canvas paint', () => {
  const contexts = new Map();
  const requests = [];
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext(_kind, options) {
    requests.push({ canvas: this, options });
    if (!contexts.has(this)) contexts.set(this, contextFor(this));
    return contexts.get(this);
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const video = { videoWidth: 640, videoHeight: 360, readyState: 4 };
    const renderer = createCanvasSubtitleRenderer(canvas);

    const result = renderer.draw({
      video,
      composition: { width: 640, height: 360 },
      crop: {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        canvasBgMode: 'solid',
        canvasBgColor: '#000000',
        flipX: false,
        flipY: false,
      },
      atlasEntry: null,
      customization: null,
      active: null,
      cueTransform: { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 },
    });

    const visible = contexts.get(canvas);
    expect(result.drewVideo).toBe(true);
    expect(requests[0]).toEqual({ canvas, options: { alpha: false } });
    expect(visible.fillRect).not.toHaveBeenCalled();
    expect(visible.clearRect).not.toHaveBeenCalled();
    expect(visible.drawImage).toHaveBeenCalledTimes(1);

    const presentedFrame = visible.drawImage.mock.calls[0][0];
    expect(presentedFrame).not.toBe(video);
    expect(contexts.get(presentedFrame).drawImage).toHaveBeenCalledWith(
      video,
      0,
      0,
      640,
      360,
      0,
      0,
      960,
      540,
    );
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

it('preserves the last visible frame while the video decoder has no replacement', () => {
  const contexts = new Map();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
    if (!contexts.has(this)) contexts.set(this, contextFor(this));
    return contexts.get(this);
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const renderer = createCanvasSubtitleRenderer(canvas);
    const result = renderer.draw({
      video: { videoWidth: 640, videoHeight: 360, readyState: 1 },
      composition: { width: 640, height: 360 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      atlasEntry: null,
      customization: null,
      active: null,
      cueTransform: { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 },
    });

    expect(result.drewVideo).toBe(false);
    expect(contexts.get(canvas).drawImage).not.toHaveBeenCalled();
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

it('rebuilds a double border as two rings instead of replaying the solid-border path', () => {
  const contexts = new Map();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
    if (!contexts.has(this)) contexts.set(this, contextFor(this));
    return contexts.get(this);
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const renderer = createCanvasSubtitleRenderer(canvas);
    const atlasCanvas = document.createElement('canvas');
    const atlasEntry = {
      canvas: atlasCanvas,
      atlas: {
        face: { fontSizePx: 48 },
        metrics: { lineHeightPx: 58 },
        layout: {
          textAlign: 'center',
          lines: [{
            advanceWidthPx: 20,
            baselineYPx: 40,
            glyphs: [0],
            penXPx: [0],
          }],
        },
        glyphs: [{
          xPx: 0,
          yPx: 0,
          widthPx: 8,
          heightPx: 8,
          originXPx: 0,
          originYPx: 8,
        }],
      },
    };
    const base = {
      ...defaultCustomization,
      backgroundOpacity: 0,
      borderWidth: 12,
      textShadowEnabled: false,
      glowEnabled: false,
      strokeEnabled: false,
    };
    const draw = (borderStyle, overrides = {}) => renderer.draw({
      video: { videoWidth: 640, videoHeight: 360, readyState: 4 },
      composition: { width: 640, height: 360 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      atlasEntry,
      customization: { ...base, borderStyle, ...overrides },
      active: { phase: 'holding', progress: 1, eased: 1 },
      cueTransform: { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 },
    });

    expect(draw('solid').overlayRebuilt).toBe(true);
    const borderContext = [...contexts.values()].find(context => context.stroke.mock.calls.length > 0);
    expect(borderContext).toBeDefined();
    expect(borderContext.stroke).toHaveBeenCalledTimes(1);

    borderContext.stroke.mockClear();
    expect(draw('double').overlayRebuilt).toBe(true);
    expect(borderContext.stroke).toHaveBeenCalledTimes(2);

    for (const context of contexts.values()) context.propertyWrites.length = 0;
    const drawCountsBeforeGlow = new Map(
      [...contexts.values()].map(context => [context, context.drawImage.mock.calls.length]),
    );
    expect(draw('double', {
      glowEnabled: true,
      glowColor: '#2ce8ff',
      glowIntensity: 12,
    }).overlayRebuilt).toBe(true);
    const glowContext = [...contexts.values()].find(context => context.propertyWrites.some(
      write => write.property === 'shadowColor' && write.value === 'rgba(44,232,255,1)',
    ));
    expect(glowContext).toBeDefined();
    expect(glowContext.propertyWrites).toContainEqual({
      property: 'globalCompositeOperation', value: 'destination-out',
    });
    expect(glowContext.propertyWrites).not.toContainEqual({
      property: 'fillStyle', value: 'rgba(0,0,0,0.001)',
    });

    const targetContext = [...contexts.values()].find(context => context.drawImage.mock.calls.some(
      ([source], index) => index >= drawCountsBeforeGlow.get(context) && source === glowContext.canvas,
    ));
    expect(targetContext).toBeDefined();
    const compositeIndex = targetContext.drawImage.mock.calls.findIndex(
      ([source], index) => index >= drawCountsBeforeGlow.get(targetContext)
        && source === glowContext.canvas,
    );
    const compositeOrder = targetContext.drawImage.mock.invocationCallOrder[compositeIndex];
    const priorTransforms = targetContext.setTransform.mock.calls
      .map((args, index) => ({ args, order: targetContext.setTransform.mock.invocationCallOrder[index] }))
      .filter(({ order }) => order < compositeOrder);
    const lastCompositionTransform = priorTransforms.findLast(({ args }) => args[0] !== 1);
    const lastIdentityTransform = priorTransforms.findLast(({ args }) => (
      args.length === 6 && args.every((value, index) => value === [1, 0, 0, 1, 0, 0][index])
    ));
    const nestedSaveOrder = targetContext.save.mock.invocationCallOrder
      .filter(order => order < compositeOrder)
      .at(-1);
    const nestedRestoreOrder = targetContext.restore.mock.invocationCallOrder
      .find(order => order > compositeOrder);
    expect(lastCompositionTransform).toBeDefined();
    expect(lastIdentityTransform).toBeDefined();
    expect(lastCompositionTransform.order).toBeLessThan(nestedSaveOrder);
    expect(nestedSaveOrder).toBeLessThan(lastIdentityTransform.order);
    expect(lastIdentityTransform.order).toBeLessThan(compositeOrder);
    expect(compositeOrder).toBeLessThan(nestedRestoreOrder);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

it('renders word-reveal and word-highlight animation passes without errors', () => {
  const contexts = new Map();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = vi.fn(function getContext() {
    if (!contexts.has(this)) contexts.set(this, contextFor(this));
    return contexts.get(this);
  });

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    const renderer = createCanvasSubtitleRenderer(canvas);
    const atlasCanvas = document.createElement('canvas');
    const atlasEntry = {
      canvas: atlasCanvas,
      atlas: {
        face: { fontSizePx: 48 },
        metrics: { lineHeightPx: 58 },
        layout: {
          textAlign: 'center',
          lines: [{
            advanceWidthPx: 60,
            baselineYPx: 40,
            glyphs: [0, 1],
            penXPx: [0, 30],
          }],
        },
        glyphs: [
          { xPx: 0, yPx: 0, widthPx: 10, heightPx: 10, originXPx: 0, originYPx: 10 },
          { xPx: 10, yPx: 0, widthPx: 10, heightPx: 10, originXPx: 0, originYPx: 10 },
        ],
      },
    };
    const cue = {
      id: 'c1',
      start: 1.0,
      end: 3.0,
      text: 'Hello world',
      words: [
        { id: 'w1', text: 'Hello', start_ms: 1000, end_ms: 1800 },
        { id: 'w2', text: 'world', start_ms: 1900, end_ms: 2800 },
      ],
    };

    // Test word-reveal
    const resReveal = renderer.draw({
      video: { videoWidth: 640, videoHeight: 360, readyState: 4 },
      composition: { width: 640, height: 360 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      atlasEntry,
      customization: { ...defaultCustomization, animationType: 'word-reveal' },
      active: { cue, instant: 1.5, phase: 'holding', progress: 1, eased: 1 },
      cueTransform: { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 },
    });
    expect(resReveal.overlayRebuilt).toBe(true);

    // Test word-highlight
    const resHighlight = renderer.draw({
      video: { videoWidth: 640, videoHeight: 360, readyState: 4 },
      composition: { width: 640, height: 360 },
      crop: { x: 0, y: 0, width: 100, height: 100 },
      atlasEntry,
      customization: { ...defaultCustomization, animationType: 'word-highlight', highlightColor: '#B4B5FF' },
      active: { cue, instant: 1.5, phase: 'holding', progress: 1, eased: 1 },
      cueTransform: { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 },
    });
    expect(resHighlight.overlayRebuilt).toBe(true);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});
