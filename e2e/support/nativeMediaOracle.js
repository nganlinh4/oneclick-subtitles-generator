/* global browser, document, window */

import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import { ffmpeg, ffprobe } from './nativeMediaTools.js';
import {
  MAX_RGBA_COMPARISON_BYTES, boundedChannelDeltaThreshold, boundedRgbaGeometry,
  compareRgbaPixelBuffers, digestRgbaRegion, measureRgbaDifferenceGeometry,
  measureRgbaDominantDifferenceComponent, measureRgbaPixelSignal,
} from './nativeMediaRgba.js';

export {
  compareRgbaPixelBuffers, digestRgbaRegion, measureRgbaDifferenceGeometry,
  measureRgbaDominantDifferenceComponent, measureRgbaPixelSignal,
} from './nativeMediaRgba.js';
export {
  compareFrames, cropSubtitleRegion, extractFrame, listMediaFiles, measureAudioSignal,
  newestMediaFile, parseVolumeDetect, probeMedia,
} from './nativeMediaProbe.js';

const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

/**
 * Convert renderer backing-store geometry into one compositor crop and a stable output envelope.
 *
 * The WebView screenshot is expressed in physical screen pixels while the renderer publishes its
 * viewport in canvas backing-store pixels. Fractional CSS layout can therefore make two captures of
 * the same viewport differ by one screenshot pixel. The crop is allowed to reflect that physical
 * rasterization; the output is always normalized to the renderer-owned viewport dimensions.
 */
export const planPreviewElementCapture = (geometry, screenshot) => {
  const numericGeometry = [
    geometry?.canvasWidth,
    geometry?.canvasHeight,
    geometry?.windowWidth,
    geometry?.windowHeight,
    geometry?.left,
    geometry?.top,
    geometry?.width,
    geometry?.height,
    geometry?.bounds?.left,
    geometry?.bounds?.top,
    geometry?.bounds?.width,
    geometry?.bounds?.height,
  ];
  if (!numericGeometry.every(Number.isFinite)
      || geometry.canvasWidth <= 0 || geometry.canvasHeight <= 0
      || geometry.windowWidth <= 0 || geometry.windowHeight <= 0
      || geometry.bounds.width <= 0 || geometry.bounds.height <= 0
      || geometry.left < 0 || geometry.top < 0
      || geometry.width <= 0 || geometry.height <= 0
      || geometry.left + geometry.width > geometry.canvasWidth
      || geometry.top + geometry.height > geometry.canvasHeight) {
    throw new Error(`preview capture geometry is invalid: ${JSON.stringify(geometry)}`);
  }
  if (!Number.isSafeInteger(screenshot?.width) || screenshot.width <= 0
      || !Number.isSafeInteger(screenshot?.height) || screenshot.height <= 0) {
    throw new Error(`preview screenshot geometry is invalid: ${JSON.stringify(screenshot)}`);
  }

  const targetWidth = Math.max(1, Math.round(geometry.width));
  const targetHeight = Math.max(1, Math.round(geometry.height));
  boundedRgbaGeometry(targetWidth, targetHeight);

  const screenshotScaleX = screenshot.width / geometry.windowWidth;
  const screenshotScaleY = screenshot.height / geometry.windowHeight;
  const backingToCssX = geometry.bounds.width / geometry.canvasWidth;
  const backingToCssY = geometry.bounds.height / geometry.canvasHeight;
  // Quantize both physical edges in the same screenshot coordinate space. Rounding an origin and
  // a span independently can make their sum disagree with the rounded far edge by one pixel. That
  // extra strip is then spread across the normalized frame by Lanczos and creates a false visual
  // diff even though the renderer produced identical pixels.
  const cropLeft = Math.round(
    (geometry.bounds.left + geometry.left * backingToCssX) * screenshotScaleX,
  );
  const cropTop = Math.round(
    (geometry.bounds.top + geometry.top * backingToCssY) * screenshotScaleY,
  );
  const cropRight = Math.round(
    (geometry.bounds.left + (geometry.left + geometry.width) * backingToCssX)
      * screenshotScaleX,
  );
  const cropBottom = Math.round(
    (geometry.bounds.top + (geometry.top + geometry.height) * backingToCssY)
      * screenshotScaleY,
  );
  const cropWidth = cropRight - cropLeft;
  const cropHeight = cropBottom - cropTop;
  if (cropLeft < 0 || cropTop < 0
      || cropWidth < 1 || cropHeight < 1
      || cropRight > screenshot.width || cropBottom > screenshot.height) {
    throw new Error(
      `preview crop exceeds the compositor screenshot: `
      + `${cropWidth}x${cropHeight}+${cropLeft}+${cropTop} inside `
      + `${screenshot.width}x${screenshot.height}`,
    );
  }

  return {
    cropLeft,
    cropTop,
    cropWidth,
    cropHeight,
    targetWidth,
    targetHeight,
  };
};

const frameGeometry = (path) => {
  const output = execFileSync(ffprobe(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    path,
  ], {
    encoding: 'utf8',
    maxBuffer: MAX_PROBE_OUTPUT_BYTES,
    timeout: 60_000,
    windowsHide: true,
  });
  const streams = JSON.parse(output)?.streams;
  if (!Array.isArray(streams) || streams.length !== 1) {
    throw new Error(`frame exposes no single video stream: ${path}`);
  }
  return boundedRgbaGeometry(Number(streams[0].width), Number(streams[0].height));
};

const decodeRgbaFrame = (path, geometry) => {
  const bytes = execFileSync(ffmpeg(), [
    '-v', 'error',
    '-nostdin',
    '-i', path,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-pix_fmt', 'rgba',
    '-f', 'rawvideo',
    'pipe:1',
  ], {
    encoding: 'buffer',
    maxBuffer: Math.min(MAX_RGBA_COMPARISON_BYTES, geometry.bytes) + (1024 * 1024),
    timeout: 60_000,
    windowsHide: true,
  });
  if (bytes.byteLength !== geometry.bytes) {
    throw new Error(
      `decoded RGBA byte length does not match ${geometry.width}x${geometry.height}: `
      + `${bytes.byteLength}, expected ${geometry.bytes}`,
    );
  }
  return bytes;
};

/** Independently decode a screenshot/still image and hash only its requested RGBA region. */
export const digestFrameRgbaRegion = (path, region) => {
  const geometry = frameGeometry(path);
  return digestRgbaRegion(decodeRgbaFrame(path, geometry), {
    ...region,
    frameWidth: geometry.width,
    frameHeight: geometry.height,
    rowStrideBytes: geometry.width * 4,
  });
};

/**
 * Independently decode a still frame to one caller-owned geometry.
 *
 * Preview screenshots and native exports intentionally travel through different colour and sizing
 * paths. Normalizing them here, in the external FFmpeg oracle, keeps ROI comparisons independent
 * of either compositor and makes their byte arrays directly comparable.
 */
export const decodeFrameRgba = (path, { width, height }) => {
  const geometry = boundedRgbaGeometry(width, height);
  const bytes = execFileSync(ffmpeg(), [
    '-v', 'error',
    '-nostdin',
    '-i', path,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=${geometry.width}:${geometry.height}:flags=lanczos,setsar=1,format=rgba`,
    '-f', 'rawvideo',
    'pipe:1',
  ], {
    encoding: 'buffer',
    maxBuffer: Math.min(MAX_RGBA_COMPARISON_BYTES, geometry.bytes) + (1024 * 1024),
    timeout: 60_000,
    windowsHide: true,
  });
  if (bytes.byteLength !== geometry.bytes) {
    throw new Error(
      `normalized RGBA byte length does not match ${geometry.width}x${geometry.height}: `
      + `${bytes.byteLength}, expected ${geometry.bytes}`,
    );
  }
  return bytes;
};

/** Independently decode two still frames and measure thresholded per-pixel RGBA change. */
export const compareFramePixels = (
  referencePath,
  candidatePath,
  { channelDeltaThreshold = 8 } = {},
) => {
  boundedChannelDeltaThreshold(channelDeltaThreshold);
  const reference = frameGeometry(referencePath);
  const candidate = frameGeometry(candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `pixel comparison frames do not share geometry: `
      + `${reference.width}x${reference.height} and ${candidate.width}x${candidate.height}`,
    );
  }
  return compareRgbaPixelBuffers(
    decodeRgbaFrame(referencePath, reference),
    decodeRgbaFrame(candidatePath, candidate),
    { width: reference.width, height: reference.height, channelDeltaThreshold },
  );
};

/** Independently decode two still frames and locate their thresholded RGBA differences. */
export const compareFramePixelGeometry = (
  referencePath,
  candidatePath,
  { channelDeltaThreshold = 8 } = {},
) => {
  boundedChannelDeltaThreshold(channelDeltaThreshold);
  const reference = frameGeometry(referencePath);
  const candidate = frameGeometry(candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `pixel geometry frames do not share dimensions: `
      + `${reference.width}x${reference.height} and ${candidate.width}x${candidate.height}`,
    );
  }
  return measureRgbaDifferenceGeometry(
    decodeRgbaFrame(referencePath, reference),
    decodeRgbaFrame(candidatePath, candidate),
    { width: reference.width, height: reference.height, channelDeltaThreshold },
  );
};

/** Independently decode two still frames and locate their dominant changed component. */
export const compareFrameDominantDifferenceComponent = (
  referencePath,
  candidatePath,
  {
    channelDeltaThreshold = 8,
    frameEdgeFringePixels = 3,
    dominantHaloPixels = 32,
  } = {},
) => {
  boundedChannelDeltaThreshold(channelDeltaThreshold);
  const reference = frameGeometry(referencePath);
  const candidate = frameGeometry(candidatePath);
  if (reference.width !== candidate.width || reference.height !== candidate.height) {
    throw new Error(
      `pixel component frames do not share dimensions: `
      + `${reference.width}x${reference.height} and ${candidate.width}x${candidate.height}`,
    );
  }
  return measureRgbaDominantDifferenceComponent(
    decodeRgbaFrame(referencePath, reference),
    decodeRgbaFrame(candidatePath, candidate),
    {
      width: reference.width,
      height: reference.height,
      channelDeltaThreshold,
      frameEdgeFringePixels,
      dominantHaloPixels,
    },
  );
};

/** Independently decode a still frame and reject black-target evidence with measured pixels. */
export const measureFrameSignal = (path, { nearBlackThreshold = 8 } = {}) => {
  const geometry = frameGeometry(path);
  return measureRgbaPixelSignal(decodeRgbaFrame(path, geometry), {
    width: geometry.width,
    height: geometry.height,
    nearBlackThreshold,
  });
};

export const saveNativePreviewFrame = async (
  path,
  selector = '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
) => {
  const frame = await browser.execute((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    if (canvas === null || Number(canvas.dataset.osgFrameRevision ?? 0) <= 0) return null;
    const viewport = {
      left: Number(canvas.dataset.osgViewportLeft),
      top: Number(canvas.dataset.osgViewportTop),
      width: Number(canvas.dataset.osgViewportWidth),
      height: Number(canvas.dataset.osgViewportHeight),
    };
    if (!Object.values(viewport).every(Number.isFinite)
        || viewport.width <= 0 || viewport.height <= 0) return null;
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(viewport.width));
    output.height = Math.max(1, Math.round(viewport.height));
    const context = output.getContext('2d');
    if (context === null) return null;
    context.drawImage(
      canvas,
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      0,
      0,
      output.width,
      output.height,
    );
    return {
      dataUrl: output.toDataURL('image/png'),
      revision: canvas.dataset.osgFrameRevision,
      width: output.width,
      height: output.height,
    };
  }, selector);
  if (frame === null || !frame.dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`the editor exposed no canvas preview frame: ${JSON.stringify(frame)}`);
  }
  const bytes = Buffer.from(frame.dataUrl.slice('data:image/png;base64,'.length), 'base64');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { revision: frame.revision, width: frame.width, height: frame.height, bytes: bytes.length };
};

/**
 * Save a composition whose source intentionally taints Canvas2D.
 *
 * WebDriver captures the browser compositor rather than reading canvas pixels, so this preserves
 * the capability URL's same-origin boundary. The element screenshot includes editor letterboxing;
 * crop it by the renderer-published backing-store viewport before comparing it with an export.
 */
export const savePreviewElementFrame = async (path, selector) => {
  // WebDriver requires the screenshot destination itself to exist. Create it before asking the
  // browser compositor for pixels; doing this only after capture made a clean isolated run fail on
  // its very first evidence frame while reused evidence directories happened to pass.
  mkdirSync(dirname(path), { recursive: true });
  const centered = await browser.execute((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    if (canvas === null) return { found: false, scrollX: 0, scrollY: 0 };
    const previousScroll = { scrollX: window.scrollX, scrollY: window.scrollY };
    const rect = canvas.getBoundingClientRect();
    window.scrollBy(0, rect.top - Math.max(0, (window.innerHeight - rect.height) / 2));
    return { found: true, ...previousScroll };
  }, selector);
  if (!centered?.found) throw new Error(`the preview canvas is missing: ${selector}`);
  const raw = `${path}.element.png`;
  try {
    const readGeometry = () => browser.execute((canvasSelector) => {
      const canvas = document.querySelector(canvasSelector);
      if (canvas === null || Number(canvas.dataset.osgFrameRevision ?? 0) <= 0) return null;
      return {
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        bounds: (() => {
          const rect = canvas.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        })(),
        left: Number(canvas.dataset.osgViewportLeft),
        top: Number(canvas.dataset.osgViewportTop),
        width: Number(canvas.dataset.osgViewportWidth),
        height: Number(canvas.dataset.osgViewportHeight),
        clock: {
          revision: Number(canvas.dataset.osgFrameRevision),
          sourceMediaTime: typeof canvas.dataset.osgSourceMediaTime === 'string'
              && canvas.dataset.osgSourceMediaTime.trim() !== ''
              && Number.isFinite(Number(canvas.dataset.osgSourceMediaTime))
            ? Number(canvas.dataset.osgSourceMediaTime)
            : null,
          transportTime: typeof canvas.dataset.osgTransportTime === 'string'
              && canvas.dataset.osgTransportTime.trim() !== ''
              && Number.isFinite(Number(canvas.dataset.osgTransportTime))
            ? Number(canvas.dataset.osgTransportTime)
            : null,
          sourceClockProvenance: canvas.dataset.osgSourceClockProvenance || null,
          sceneTime: Number.isFinite(Number(canvas.dataset.osgSceneTime))
            ? Number(canvas.dataset.osgSceneTime)
            : null,
          cueIndex: canvas.dataset.osgCueIndex || null,
          overlayRebuilds: Number.isFinite(Number(canvas.dataset.osgOverlayRebuilds))
            ? Number(canvas.dataset.osgOverlayRebuilds)
            : null,
        },
      };
    }, selector);
    // Browser screenshots are produced by the WebView compositor. Unlike canvas.toDataURL(), this
    // works when the video came from the capability origin and therefore tainted Canvas2D. Edge's
    // element-screenshot command returns the full WebView for this Tauri target, so crop that
    // compositor image with the canvas's viewport-relative DOM rectangle.
    await browser.execute((canvasSelector) => {
      const canvas = document.querySelector(canvasSelector);
      const scope = canvas?.parentElement;
      if (scope === undefined || scope === null) return;
      for (const node of scope.querySelectorAll('.native-render-controls, .crop-toggle-btn, .crop-clear-btn')) {
        node.dataset.osgE2eCaptureStyle = node.getAttribute('style') ?? '__missing__';
        node.style.setProperty('visibility', 'hidden', 'important');
      }
    }, selector);
    await browser.pause(100);
    let geometry = null;
    let stable = false;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      geometry = await readGeometry();
      if (geometry === null) {
        throw new Error(`the preview exposed no bounded composition viewport: ${JSON.stringify(geometry)}`);
      }
      await browser.saveScreenshot(raw);
      const after = await readGeometry();
      // Clock stability alone is not enough: a layout still settling after a style change can
      // move the element between the geometry read and the compositor screenshot, so the crop
      // rectangle names a rect the pixels no longer occupy. A restored-Default capture measured
      // that way carried a 2px strip of page background and failed an SSIM claim about ink that
      // had restored perfectly. Pixels and rectangle must describe the same settled instant.
      stable = after !== null
        && after.clock.revision === geometry.clock.revision
        && Object.is(after.clock.sourceMediaTime, geometry.clock.sourceMediaTime)
        && Object.is(after.clock.transportTime, geometry.clock.transportTime)
        && Object.is(after.clock.sceneTime, geometry.clock.sceneTime)
        && Object.is(after.clock.sourceClockProvenance, geometry.clock.sourceClockProvenance)
        && after.bounds.left === geometry.bounds.left
        && after.bounds.top === geometry.bounds.top
        && after.bounds.width === geometry.bounds.width
        && after.bounds.height === geometry.bounds.height
        && after.left === geometry.left
        && after.top === geometry.top
        && after.width === geometry.width
        && after.height === geometry.height;
      if (stable) break;
      if (attempt < 5) await browser.pause(50);
    }
    if (!stable) {
      throw new Error('the preview changed while WebDriver captured its compositor frame');
    }
    const image = JSON.parse(execFileSync(ffprobe(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', raw,
    ], { encoding: 'utf8', timeout: 60_000, windowsHide: true })).streams?.[0];
    if (!(image?.width > 0 && image?.height > 0)) throw new Error('element screenshot has no dimensions');
    const capture = planPreviewElementCapture(geometry, image);
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', '-i', raw,
      '-vf', `crop=${capture.cropWidth}:${capture.cropHeight}:`
        + `${capture.cropLeft}:${capture.cropTop},`
        + `scale=${capture.targetWidth}:${capture.targetHeight}:flags=lanczos,setsar=1`,
      '-frames:v', '1', path,
    ], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
    return {
      width: capture.targetWidth,
      height: capture.targetHeight,
      bytes: statSync(path).size,
      capture: {
        window: { width: geometry.windowWidth, height: geometry.windowHeight },
        canvas: {
          width: geometry.canvasWidth,
          height: geometry.canvasHeight,
          bounds: geometry.bounds,
        },
        viewport: {
          left: geometry.left,
          top: geometry.top,
          width: geometry.width,
          height: geometry.height,
        },
        screenshot: { width: image.width, height: image.height },
        crop: capture,
        clock: geometry.clock,
      },
    };
  } finally {
    await browser.execute((canvasSelector, previousScroll) => {
      const canvas = document.querySelector(canvasSelector);
      const scope = canvas?.parentElement;
      if (scope !== undefined && scope !== null) {
        for (const node of scope.querySelectorAll('[data-osg-e2e-capture-style]')) {
          const previous = node.dataset.osgE2eCaptureStyle;
          if (previous === '__missing__') node.removeAttribute('style');
          else node.setAttribute('style', previous);
          delete node.dataset.osgE2eCaptureStyle;
        }
      }
      if (Number.isFinite(previousScroll?.scrollX) && Number.isFinite(previousScroll?.scrollY)) {
        window.scrollTo(previousScroll.scrollX, previousScroll.scrollY);
      }
    }, selector, centered);
    if (existsSync(raw)) unlinkSync(raw);
  }
};

/**
 * Capture the real source-video pixels underneath a native preview without changing its playhead.
 *
 * The browser compositor is the colour-conversion authority for the paused preview. Hiding only
 * the already-published canvas therefore gives a stronger source-only control than independently
 * decoding the source through a second colour path: the subtitle composition is the sole intended
 * difference. The exact prior inline opacity and priority are restored even when capture fails.
 */
export const savePreviewSourceFrame = async (path, selector) => {
  const priorOpacity = await browser.execute((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    if (canvas === null) return null;
    const value = canvas.style.getPropertyValue('opacity');
    const priority = canvas.style.getPropertyPriority('opacity');
    canvas.style.setProperty('opacity', '0', 'important');
    return { value, priority };
  }, selector);
  if (priorOpacity === null) throw new Error(`the preview canvas is missing: ${selector}`);
  try {
    return await savePreviewElementFrame(path, selector);
  } finally {
    await browser.execute((canvasSelector, previous) => {
      const canvas = document.querySelector(canvasSelector);
      if (canvas === null) return;
      if (previous.value === '') canvas.style.removeProperty('opacity');
      else canvas.style.setProperty('opacity', previous.value, previous.priority);
    }, selector, priorOpacity);
  }
};
