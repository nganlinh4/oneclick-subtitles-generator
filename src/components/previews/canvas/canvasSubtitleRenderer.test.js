import { createCanvasSubtitleRenderer } from './canvasSubtitleRenderer';

const contextFor = (canvas) => ({
  canvas,
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  clip: vi.fn(),
  drawImage: vi.fn(),
  fillRect: vi.fn(),
  rect: vi.fn(),
  restore: vi.fn(),
  rotate: vi.fn(),
  save: vi.fn(),
  scale: vi.fn(),
  setLineDash: vi.fn(),
  setTransform: vi.fn(),
  stroke: vi.fn(),
  translate: vi.fn(),
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
