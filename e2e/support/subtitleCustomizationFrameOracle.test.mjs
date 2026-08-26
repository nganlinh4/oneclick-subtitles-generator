import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  compareRgbaPixelBuffers,
  planPreviewElementCapture,
  savePreviewElementFrame,
} from './nativeMediaOracle.js';
import {
  describeCustomizationFrame,
  describeCustomizationNativeFrame,
  verifyCustomizationRestoration,
  verifyCustomizationTransition,
  verifyLiveCustomizationPlayback,
} from './subtitleCustomizationFrameOracle.js';

const pixelMeasurement = ({
  width = 640,
  height = 360,
  changedPixels = 512,
  channelDeltaThreshold = 8,
  maximumChannelDelta = changedPixels > 0 ? 255 : 0,
} = {}) => ({
  width,
  height,
  totalPixels: width * height,
  changedPixels,
  changedRatio: changedPixels / (width * height),
  channelDeltaThreshold,
  maximumChannelDelta,
});

const pngEnvelope = (width, height, marker) => {
  const bytes = Buffer.alloc(40, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(marker, 32);
  return bytes;
};

const withFrames = (operation) => {
  const root = mkdtempSync(join(tmpdir(), 'osg-customization-frames-'));
  mkdirSync(root, { recursive: true });
  try {
    return operation(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const liveCustomizationSamples = () => Array.from({ length: 81 }, (_, index) => ({
  atMs: index * 40,
  mediaTime: 1 + index * 0.04,
  revision: 100 + index,
  overlayRebuilds: index < 20 ? 4 : 5,
  cue: '0',
  preview: 'ready',
  previewCode: null,
  preset: index < 20 ? 'Default' : 'Classic',
  paused: false,
  ended: false,
  readyState: 4,
  error: null,
  visibleErrors: [],
}));

test('describes bounded PNG geometry and a content digest', () => withFrames((root) => {
  const path = join(root, 'frame.png');
  writeFileSync(path, pngEnvelope(640, 360, 1));
  const frame = describeCustomizationFrame(path);
  assert.deepEqual([frame.width, frame.height, frame.sizeBytes], [640, 360, 40]);
  assert.match(frame.sha256, /^[a-f0-9]{64}$/u);
}));

test('accepts only the independently expected native-frame envelope, never a page screenshot', () => (
  withFrames((root) => {
    const nativeFrame = join(root, 'native-frame.png');
    const pageScreenshot = join(root, 'page-screenshot.png');
    writeFileSync(nativeFrame, pngEnvelope(716, 537, 1));
    writeFileSync(pageScreenshot, pngEnvelope(1_400, 900, 2));

    const expectedGeometry = { width: 716, height: 537 };
    const described = describeCustomizationNativeFrame(nativeFrame, expectedGeometry);
    assert.deepEqual(
      [described.width, described.height],
      [expectedGeometry.width, expectedGeometry.height],
    );
    assert.throws(
      () => describeCustomizationNativeFrame(pageScreenshot, expectedGeometry),
      /does not match the independently expected compositor envelope/u,
    );
    assert.throws(
      () => describeCustomizationNativeFrame(nativeFrame),
      /needs independent expected geometry/u,
    );
    assert.throws(
      () => describeCustomizationNativeFrame(nativeFrame, { width: 0, height: 537 }),
      /expected native frame width is invalid/u,
    );
  })
));

test('accepts a renderer-published high-DPI envelope without freezing the workstation scale', () => (
  withFrames((root) => {
    const scaledFrame = join(root, 'scaled-native-frame.png');
    writeFileSync(scaledFrame, pngEnvelope(1_074, 806, 3));
    const described = describeCustomizationNativeFrame(
      scaledFrame,
      { width: 1_074, height: 806 },
    );
    assert.deepEqual([described.width, described.height], [1_074, 806]);
  })
));

test('proves a live preset rebuild without media, compositor, or subtitle interruption', () => {
  const result = verifyLiveCustomizationPlayback({
    samples: liveCustomizationSamples(),
    mediaEvents: [
      { type: 'playing', atMs: 0, mediaTime: 1 },
      { type: 'waiting', atMs: 400, mediaTime: 1.4 },
      { type: 'playing', atMs: 440, mediaTime: 1.44 },
    ],
    afterPreset: 'Classic',
  });
  assert.deepEqual({
    animationFrameSamples: result.animationFrameSamples,
    elapsedMs: result.elapsedMs,
    revisionAdvance: result.revisionAdvance,
    overlayRebuilds: result.overlayRebuilds,
    transitionAtMs: result.transitionAtMs,
  }, {
    animationFrameSamples: 81,
    elapsedMs: 3_200,
    revisionAdvance: 80,
    overlayRebuilds: 1,
    transitionAtMs: 800,
  });
  assert.deepEqual(result.waitingRecoveries, [{
    waitingAtMs: 400,
    playingAtMs: 440,
    recoveryMs: 40,
  }]);
});

test('rejects one-frame subtitle/refusal blinks and real media stall events', () => {
  const blink = liveCustomizationSamples();
  blink[36] = { ...blink[36], cue: '', preview: 'refused', previewCode: 'fontUnavailable' };
  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: blink,
    afterPreset: 'Classic',
  }), /active subtitle blinked/u);

  const silentRefusal = liveCustomizationSamples();
  silentRefusal[39] = {
    ...silentRefusal[39], preview: 'refused', previewCode: 'fontUnavailable',
  };
  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: silentRefusal,
    afterPreset: 'Classic',
  }), /native preview refused/u);

  const visibleRefusal = liveCustomizationSamples();
  visibleRefusal[42] = { ...visibleRefusal[42], visibleErrors: ['fontUnavailable'] };
  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: visibleRefusal,
    afterPreset: 'Classic',
  }), /exposed a refusal\/error/u);

  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: liveCustomizationSamples(),
    mediaEvents: [{ type: 'stalled', atMs: 1_120, mediaTime: 2.12 }],
    afterPreset: 'Classic',
  }), /failure\/stall event/u);

  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: liveCustomizationSamples(),
    mediaEvents: [{ type: 'waiting', atMs: 1_120, mediaTime: 2.12 }],
    afterPreset: 'Classic',
  }), /waiting event never recovered to playing/u);

  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: liveCustomizationSamples(),
    mediaEvents: [
      { type: 'waiting', atMs: 1_120, mediaTime: 2.12 },
      { type: 'playing', atMs: 1_871, mediaTime: 2.13 },
    ],
    afterPreset: 'Classic',
  }), /waiting recovery took 751ms/u);

  for (const type of ['abort', 'emptied', 'error']) {
    assert.throws(() => verifyLiveCustomizationPlayback({
      samples: liveCustomizationSamples(),
      mediaEvents: [{ type, atMs: 1_120, mediaTime: 2.12 }],
      afterPreset: 'Classic',
    }), /failure\/stall event/u);
  }
});

test('rejects a moving seek bar with a frozen composited frame after the style rebuild', () => {
  const frozen = liveCustomizationSamples();
  const frozenRevision = frozen[25].revision;
  for (let index = 26; index < frozen.length; index += 1) {
    frozen[index] = { ...frozen[index], revision: frozenRevision };
  }
  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: frozen,
    afterPreset: 'Classic',
  }), /native preview froze/u);

  const mediaFrozen = liveCustomizationSamples();
  const frozenTime = mediaFrozen[30].mediaTime;
  for (let index = 31; index < mediaFrozen.length; index += 1) {
    mediaFrozen[index] = { ...mediaFrozen[index], mediaTime: frozenTime };
  }
  assert.throws(() => verifyLiveCustomizationPlayback({
    samples: mediaFrozen,
    afterPreset: 'Classic',
  }), /source media clock stalled|source media clock stopped/u);
});

test('requires both distinct bytes and independently measured SSIM for a transition', () => (
  withFrames((root) => {
    const before = join(root, 'before.png');
    const after = join(root, 'after.png');
    writeFileSync(before, pngEnvelope(640, 360, 1));
    writeFileSync(after, pngEnvelope(640, 360, 2));
    const result = verifyCustomizationTransition({
      beforePath: before,
      afterPath: after,
      compare: () => 0.82,
      comparePixels: () => pixelMeasurement(),
    });
    assert.equal(result.ssim, 0.82);
    assert.equal(result.pixels.changedPixels, 512);

    assert.throws(() => verifyCustomizationTransition({
      beforePath: before,
      afterPath: after,
      compare: () => 1,
      comparePixels: () => pixelMeasurement(),
    }), /not materially visible/u);
    writeFileSync(after, pngEnvelope(640, 360, 1));
    assert.throws(() => verifyCustomizationTransition({
      beforePath: before,
      afterPath: after,
      compare: () => 0.5,
      comparePixels: () => pixelMeasurement(),
    }), /frame bytes unchanged/u);
  })
));

test('counts only pixels whose RGBA channel delta reaches the threshold', () => {
  const reference = new Uint8Array(4 * 4);
  const candidate = new Uint8Array(reference);
  candidate[0] = 7;
  candidate[5] = 8;
  candidate[11] = 255;
  const measured = compareRgbaPixelBuffers(reference, candidate, {
    width: 2,
    height: 2,
    channelDeltaThreshold: 8,
  });
  assert.deepEqual(measured, {
    width: 2,
    height: 2,
    totalPixels: 4,
    changedPixels: 2,
    changedRatio: 0.5,
    channelDeltaThreshold: 8,
    maximumChannelDelta: 255,
  });
});

test('bounds RGBA geometry, byte lengths, and channel threshold', () => {
  const frame = new Uint8Array(16);
  assert.throws(() => compareRgbaPixelBuffers(frame, frame, {
    width: 0, height: 2, channelDeltaThreshold: 8,
  }), /geometry is invalid/u);
  assert.throws(() => compareRgbaPixelBuffers(frame, frame, {
    width: 16_385, height: 16_385, channelDeltaThreshold: 8,
  }), /exceeds/u);
  assert.throws(() => compareRgbaPixelBuffers(frame.subarray(1), frame, {
    width: 2, height: 2, channelDeltaThreshold: 8,
  }), /byte length does not match/u);
  assert.throws(() => compareRgbaPixelBuffers(frame, frame, {
    width: 2, height: 2, channelDeltaThreshold: 0,
  }), /integer from 1 through 255/u);
  assert.throws(() => compareRgbaPixelBuffers('not bytes', frame, {
    width: 2, height: 2, channelDeltaThreshold: 8,
  }), /must be byte arrays/u);
});

test('normalizes fractional compositor crops to one renderer-owned viewport', () => {
  const geometry = {
    canvasWidth: 640,
    canvasHeight: 480,
    windowWidth: 1_024,
    windowHeight: 768,
    bounds: { left: 100, top: 50, width: 730.49, height: 547.75 },
    left: 0,
    top: 0,
    width: 640,
    height: 480,
  };
  const first = planPreviewElementCapture(geometry, { width: 1_024, height: 768 });
  const second = planPreviewElementCapture({
    ...geometry,
    bounds: { ...geometry.bounds, width: 730.51 },
  }, { width: 1_024, height: 768 });

  assert.equal(first.cropWidth, 730);
  assert.equal(second.cropWidth, 731);
  assert.deepEqual(
    [first.targetWidth, first.targetHeight],
    [second.targetWidth, second.targetHeight],
  );
  assert.deepEqual([first.targetWidth, first.targetHeight], [640, 480]);
});

test('quantizes both crop edges so combined fractional origins cannot add a foreign pixel strip', () => {
  const geometry = {
    canvasWidth: 640,
    canvasHeight: 480,
    windowWidth: 1_024,
    windowHeight: 768,
    bounds: { left: 100.6, top: 50.6, width: 730.6, height: 547.6 },
    left: 0,
    top: 0,
    width: 640,
    height: 480,
  };

  const capture = planPreviewElementCapture(geometry, { width: 1_024, height: 768 });
  assert.deepEqual(capture, {
    cropLeft: 101,
    cropTop: 51,
    cropWidth: 730,
    cropHeight: 547,
    targetWidth: 640,
    targetHeight: 480,
  });

  const doubled = planPreviewElementCapture(geometry, { width: 2_048, height: 1_536 });
  assert.equal(doubled.cropWidth, 1_461);
  assert.equal(doubled.cropHeight, 1_095);
  assert.equal(doubled.cropLeft + doubled.cropWidth, Math.round((100.6 + 730.6) * 2));
  assert.equal(doubled.cropTop + doubled.cropHeight, Math.round((50.6 + 547.6) * 2));
});

test('rejects dishonest renderer viewports and compositor crops', () => {
  const geometry = {
    canvasWidth: 640,
    canvasHeight: 480,
    windowWidth: 1_024,
    windowHeight: 768,
    bounds: { left: 100, top: 50, width: 730, height: 548 },
    left: 0,
    top: 0,
    width: 640,
    height: 480,
  };
  assert.throws(() => planPreviewElementCapture({
    ...geometry, left: 1, width: 640,
  }, { width: 1_024, height: 768 }), /geometry is invalid/u);
  assert.throws(() => planPreviewElementCapture({
    ...geometry,
    bounds: { ...geometry.bounds, left: 500 },
  }, { width: 1_024, height: 768 }), /crop exceeds/u);
  assert.throws(() => planPreviewElementCapture(geometry, {
    width: 0, height: 768,
  }), /screenshot geometry is invalid/u);
});

test('restores document scroll when native-frame capture fails after centering', async () => {
  const priorBrowser = globalThis.browser;
  const restored = [];
  let executeCall = 0;
  globalThis.browser = {
    execute: async (callback) => {
      executeCall += 1;
      if (executeCall === 1) return { found: true, scrollX: 37, scrollY: 211 };
      if (executeCall === 2) return null;
      const priorDocument = globalThis.document;
      const priorWindow = globalThis.window;
      globalThis.document = { querySelector: () => null };
      globalThis.window = { scrollTo: (left, top) => restored.push([left, top]) };
      try {
        return callback('.preview', { found: true, scrollX: 37, scrollY: 211 });
      } finally {
        globalThis.document = priorDocument;
        globalThis.window = priorWindow;
      }
    },
    pause: async () => {},
  };
  try {
    await assert.rejects(
      savePreviewElementFrame('unused.png', '.preview'),
      /no bounded composition viewport/u,
    );
    assert.deepEqual(restored, [[37, 211]]);
  } finally {
    globalThis.browser = priorBrowser;
  }
});

test('creates a clean-run evidence directory before WebDriver captures compositor pixels', async () => {
  const priorBrowser = globalThis.browser;
  const root = mkdtempSync(join(tmpdir(), 'osg-native-capture-directory-'));
  const path = join(root, 'new-workflow', 'first-frame.png');
  let executeCall = 0;
  globalThis.browser = {
    execute: async () => {
      executeCall += 1;
      if (executeCall === 1) return { found: true, scrollX: 0, scrollY: 0 };
      if (executeCall === 3) return { clock: { revision: 1 } };
      return null;
    },
    pause: async () => {},
    saveScreenshot: async (raw) => {
      assert.equal(raw, `${path}.element.png`);
      assert.equal(existsSync(join(root, 'new-workflow')), true);
      throw new Error('capture stopped after directory proof');
    },
  };
  try {
    await assert.rejects(
      savePreviewElementFrame(path, '.preview'),
      /capture stopped after directory proof/u,
    );
  } finally {
    globalThis.browser = priorBrowser;
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects sparse byte noise even when SSIM alone claims a transition', () => withFrames((root) => {
  const before = join(root, 'before.png');
  const after = join(root, 'after.png');
  writeFileSync(before, pngEnvelope(640, 360, 1));
  writeFileSync(after, pngEnvelope(640, 360, 2));

  assert.throws(() => verifyCustomizationTransition({
    beforePath: before,
    afterPath: after,
    compare: () => 0.5,
    comparePixels: () => pixelMeasurement({ changedPixels: 127 }),
  }), /changed only 127 thresholded pixels/u);

  assert.throws(() => verifyCustomizationTransition({
    beforePath: before,
    afterPath: after,
    compare: () => 0.5,
    comparePixels: () => pixelMeasurement({ changedPixels: 1_000 }),
    minimumChangedPixels: 10,
    minimumChangedRatio: 0.01,
  }), /changed only .*% of pixels/u);
}));

test('rejects dishonest or out-of-contract pixel measurements', () => withFrames((root) => {
  const before = join(root, 'before.png');
  const after = join(root, 'after.png');
  writeFileSync(before, pngEnvelope(640, 360, 1));
  writeFileSync(after, pngEnvelope(640, 360, 2));
  const verify = (comparePixels) => verifyCustomizationTransition({
    beforePath: before,
    afterPath: after,
    compare: () => 0.5,
    comparePixels,
  });

  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), width: 641,
  })), /does not describe the comparison frames/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), totalPixels: 1,
  })), /false pixel total/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), changedRatio: 0.9,
  })), /ratio .* disagrees with count/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), channelDeltaThreshold: 9,
  })), /used another channel threshold/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), maximumChannelDelta: 256,
  })), /invalid maximum RGBA channel delta/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement(), maximumChannelDelta: 7,
  })), /contradicts its thresholded changed-pixel count/u);
  assert.throws(() => verify(() => ({
    ...pixelMeasurement({ changedPixels: 0 }), maximumChannelDelta: 8,
  })), /contradicts its thresholded changed-pixel count/u);
}));

test('requires a restored preset to be closer than every changed style', () => withFrames((root) => {
  const paths = Object.fromEntries(['baseline', 'restored', 'neon', 'custom'].map((name, index) => {
    const path = join(root, `${name}.png`);
    writeFileSync(path, pngEnvelope(640, 360, index + 1));
    return [name, path];
  }));
  const scores = new Map([
    ['restored.png', 0.999],
    ['neon.png', 0.91],
    ['custom.png', 0.73],
  ]);
  const verified = verifyCustomizationRestoration({
    baselinePath: paths.baseline,
    restoredPath: paths.restored,
    divergentPaths: [paths.neon, paths.custom],
    compare: (_left, right) => scores.get(basename(right)),
  });
  assert.equal(verified.restoredSsim, 0.999);
  assert.equal(verified.closestDivergent, 0.91);

  assert.throws(() => verifyCustomizationRestoration({
    baselinePath: paths.baseline,
    restoredPath: paths.restored,
    divergentPaths: [paths.neon],
    compare: (_left, right) => (basename(right) === 'restored.png' ? 0.9 : 0.91),
    minimumSsim: 0.8,
  }), /no closer to baseline/u);
}));

test('refuses malformed PNG envelopes and mismatched geometry', () => withFrames((root) => {
  const invalid = join(root, 'invalid.png');
  writeFileSync(invalid, Buffer.alloc(40));
  assert.throws(() => describeCustomizationFrame(invalid), /not a PNG/u);

  const before = join(root, 'before.png');
  const after = join(root, 'after.png');
  writeFileSync(before, pngEnvelope(640, 360, 1));
  writeFileSync(after, pngEnvelope(641, 360, 2));
  assert.throws(() => verifyCustomizationTransition({
    beforePath: before,
    afterPath: after,
    compare: () => 0.5,
    comparePixels: () => pixelMeasurement({ width: 641 }),
  }), /one composition geometry/u);
}));
