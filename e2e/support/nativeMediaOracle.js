/* global browser, document, window */

import { Buffer } from 'node:buffer';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { NATIVE_TOOLS_CACHE } from './environment.js';

const findTool = (filename) => {
  const matches = [];
  const pending = [NATIVE_TOOLS_CACHE];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.name.toLowerCase() === filename.toLowerCase()) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one installed ${filename}, found ${matches.length}: ${matches.join(', ')}`);
  }
  return matches[0];
};

const ffprobe = () => findTool('ffprobe.exe');
const ffmpeg = () => findTool('ffmpeg.exe');

const MAX_RGBA_COMPARISON_PIXELS = 16 * 1024 * 1024;
const MAX_RGBA_COMPARISON_BYTES = MAX_RGBA_COMPARISON_PIXELS * 4;
const MAX_PROBE_OUTPUT_BYTES = 1024 * 1024;

const boundedRgbaGeometry = (width, height) => {
  if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error(`RGBA comparison geometry is invalid: ${width}x${height}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_RGBA_COMPARISON_PIXELS) {
    throw new Error(
      `RGBA comparison exceeds ${MAX_RGBA_COMPARISON_PIXELS} pixels: ${width}x${height}`,
    );
  }
  return { width, height, pixels, bytes: pixels * 4 };
};

const boundedChannelDeltaThreshold = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 255) {
    throw new Error(`RGBA channel delta threshold must be an integer from 1 through 255: ${value}`);
  }
  return value;
};

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

/**
 * Count pixels with a meaningful change in at least one RGBA channel.
 *
 * Kept pure so hostile boundary cases do not need a decoder process. Production callers should use
 * `compareFramePixels`, which independently decodes both inputs with the managed FFmpeg binary.
 */
export const compareRgbaPixelBuffers = (
  reference,
  candidate,
  { width, height, channelDeltaThreshold = 8 } = {},
) => {
  const geometry = boundedRgbaGeometry(width, height);
  const threshold = boundedChannelDeltaThreshold(channelDeltaThreshold);
  if (!(reference instanceof Uint8Array) || !(candidate instanceof Uint8Array)) {
    throw new Error('RGBA comparison inputs must be byte arrays');
  }
  if (reference.byteLength !== geometry.bytes || candidate.byteLength !== geometry.bytes) {
    throw new Error(
      `RGBA byte length does not match ${width}x${height}: `
      + `${reference.byteLength} and ${candidate.byteLength}, expected ${geometry.bytes}`,
    );
  }

  let changedPixels = 0;
  let maximumChannelDelta = 0;
  for (let offset = 0; offset < geometry.bytes; offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(reference[offset + channel] - candidate[offset + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      if (delta >= threshold) pixelChanged = true;
    }
    if (pixelChanged) changedPixels += 1;
  }

  return Object.freeze({
    width,
    height,
    totalPixels: geometry.pixels,
    changedPixels,
    changedRatio: changedPixels / geometry.pixels,
    channelDeltaThreshold: threshold,
    maximumChannelDelta,
  });
};

/**
 * Describe where two RGBA frames differ, not merely how many pixels differ.
 *
 * Animation evidence needs a spatial signal: a constant transform can change counters and retain
 * subtitle pixels while ignoring the selected easing. The normalized centroid and occupied bounds
 * make that failure observable without trusting renderer-owned geometry.
 */
export const measureRgbaDifferenceGeometry = (
  reference,
  candidate,
  { width, height, channelDeltaThreshold = 8 } = {},
) => {
  const geometry = boundedRgbaGeometry(width, height);
  const threshold = boundedChannelDeltaThreshold(channelDeltaThreshold);
  if (!(reference instanceof Uint8Array) || !(candidate instanceof Uint8Array)) {
    throw new Error('RGBA difference inputs must be byte arrays');
  }
  if (reference.byteLength !== geometry.bytes || candidate.byteLength !== geometry.bytes) {
    throw new Error(
      `RGBA difference byte length does not match ${width}x${height}: `
      + `${reference.byteLength} and ${candidate.byteLength}, expected ${geometry.bytes}`,
    );
  }

  let changedPixels = 0;
  let maximumChannelDelta = 0;
  let channelDeltaSum = 0;
  let centroidXSum = 0;
  let centroidYSum = 0;
  let minimumX = width;
  let minimumY = height;
  let maximumX = -1;
  let maximumY = -1;
  for (let pixel = 0, offset = 0; pixel < geometry.pixels; pixel += 1, offset += 4) {
    let pixelChanged = false;
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(reference[offset + channel] - candidate[offset + channel]);
      maximumChannelDelta = Math.max(maximumChannelDelta, delta);
      pixelDelta += delta;
      if (delta >= threshold) pixelChanged = true;
    }
    if (!pixelChanged) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    changedPixels += 1;
    channelDeltaSum += pixelDelta;
    centroidXSum += x + 0.5;
    centroidYSum += y + 0.5;
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }

  const bounds = changedPixels === 0 ? null : Object.freeze({
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX + 1,
    height: maximumY - minimumY + 1,
    areaPixels: (maximumX - minimumX + 1) * (maximumY - minimumY + 1),
  });
  return Object.freeze({
    width,
    height,
    totalPixels: geometry.pixels,
    changedPixels,
    changedRatio: changedPixels / geometry.pixels,
    channelDeltaThreshold: threshold,
    maximumChannelDelta,
    meanChangedChannelDelta: changedPixels === 0 ? 0 : channelDeltaSum / (changedPixels * 4),
    centroidX: changedPixels === 0 ? null : centroidXSum / changedPixels,
    centroidY: changedPixels === 0 ? null : centroidYSum / changedPixels,
    centroidXRatio: changedPixels === 0 ? null : centroidXSum / changedPixels / width,
    centroidYRatio: changedPixels === 0 ? null : centroidYSum / changedPixels / height,
    bounds,
  });
};

/**
 * Locate the largest connected region in a thresholded RGBA difference mask.
 *
 * Browser-compositor captures can carry a disconnected narrow edge fringe when a fractional CSS
 * boundary is quantized into physical screenshot pixels. Global min/max difference bounds
 * then claim that an otherwise contained subtitle touches the frame edge. The reviewed material
 * fixture deliberately paints one continuous border/background component, so its dominant
 * eight-connected component is the renderer-independent containment witness. A genuinely clipped
 * material box remains the dominant component and still reaches the offending edge.
 */
export const measureRgbaDominantDifferenceComponent = (
  reference,
  candidate,
  {
    width,
    height,
    channelDeltaThreshold = 8,
    frameEdgeFringePixels = 3,
    dominantHaloPixels = 0,
  } = {},
) => {
  const geometry = boundedRgbaGeometry(width, height);
  const threshold = boundedChannelDeltaThreshold(channelDeltaThreshold);
  if (!Number.isSafeInteger(frameEdgeFringePixels) || frameEdgeFringePixels < 0
      || frameEdgeFringePixels * 2 >= Math.min(width, height)) {
    throw new Error(`RGBA frame-edge fringe is invalid: ${frameEdgeFringePixels}`);
  }
  if (!Number.isSafeInteger(dominantHaloPixels) || dominantHaloPixels < 0
      || dominantHaloPixels >= Math.max(width, height)) {
    throw new Error(`RGBA dominant-component halo is invalid: ${dominantHaloPixels}`);
  }
  if (!(reference instanceof Uint8Array) || !(candidate instanceof Uint8Array)) {
    throw new Error('RGBA component inputs must be byte arrays');
  }
  if (reference.byteLength !== geometry.bytes || candidate.byteLength !== geometry.bytes) {
    throw new Error(
      `RGBA component byte length does not match ${width}x${height}: `
      + `${reference.byteLength} and ${candidate.byteLength}, expected ${geometry.bytes}`,
    );
  }

  const differenceMask = new Uint8Array(geometry.pixels);
  let changedPixels = 0;
  for (let pixel = 0, offset = 0; pixel < geometry.pixels; pixel += 1, offset += 4) {
    let pixelChanged = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(reference[offset + channel] - candidate[offset + channel]) >= threshold) {
        pixelChanged = true;
      }
    }
    if (pixelChanged) {
      differenceMask[pixel] = 1;
      changedPixels += 1;
    }
  }

  const unvisited = Uint8Array.from(differenceMask);
  const queue = new Uint32Array(geometry.pixels);
  let componentCount = 0;
  let dominant = null;
  for (let start = 0; start < geometry.pixels; start += 1) {
    if (unvisited[start] === 0) continue;
    componentCount += 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    unvisited[start] = 0;
    let componentPixels = 0;
    let minimumX = width;
    let minimumY = height;
    let maximumX = -1;
    let maximumY = -1;

    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      componentPixels += 1;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const neighborX = x + offsetX;
          const neighborY = y + offsetY;
          if (neighborX < 0 || neighborX >= width || neighborY < 0 || neighborY >= height) continue;
          const neighbor = (neighborY * width) + neighborX;
          if (unvisited[neighbor] === 0) continue;
          unvisited[neighbor] = 0;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }

    if (dominant === null || componentPixels > dominant.changedPixels) {
      dominant = Object.freeze({
        changedPixels: componentPixels,
        bounds: Object.freeze({
          x: minimumX,
          y: minimumY,
          width: maximumX - minimumX + 1,
          height: maximumY - minimumY + 1,
          areaPixels: (maximumX - minimumX + 1) * (maximumY - minimumY + 1),
        }),
      });
    }
  }

  let outsideDominantHaloChangedPixels = 0;
  let outsideDominantHaloInteriorChangedPixels = 0;
  if (dominant !== null) {
    const haloLeft = Math.max(0, dominant.bounds.x - dominantHaloPixels);
    const haloTop = Math.max(0, dominant.bounds.y - dominantHaloPixels);
    const haloRight = Math.min(width, dominant.bounds.x + dominant.bounds.width + dominantHaloPixels);
    const haloBottom = Math.min(height, dominant.bounds.y + dominant.bounds.height + dominantHaloPixels);
    for (let pixel = 0; pixel < geometry.pixels; pixel += 1) {
      if (differenceMask[pixel] === 0) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const insideHalo = x >= haloLeft && x < haloRight && y >= haloTop && y < haloBottom;
      if (insideHalo) continue;
      outsideDominantHaloChangedPixels += 1;
      const insideFrameInterior = x >= frameEdgeFringePixels
        && x < width - frameEdgeFringePixels
        && y >= frameEdgeFringePixels
        && y < height - frameEdgeFringePixels;
      if (insideFrameInterior) outsideDominantHaloInteriorChangedPixels += 1;
    }
  }

  return Object.freeze({
    width,
    height,
    totalPixels: geometry.pixels,
    changedPixels,
    changedRatio: changedPixels / geometry.pixels,
    channelDeltaThreshold: threshold,
    componentCount,
    otherComponentChangedPixels: changedPixels - (dominant?.changedPixels ?? 0),
    frameEdgeFringePixels,
    dominantHaloPixels,
    outsideDominantHaloChangedPixels,
    outsideDominantHaloInteriorChangedPixels,
    dominant,
  });
};

/**
 * Reduce one decoded RGBA frame to bounded signal measurements.
 *
 * A frame-sized PNG and an advancing compositor counter can both describe the renderer's freshly
 * cleared black target. Keep the arithmetic pure so journey oracles can reject that failure without
 * trusting image metadata or a renderer-owned status flag.
 */
export const measureRgbaPixelSignal = (
  pixels,
  { width, height, nearBlackThreshold = 8 } = {},
) => {
  const geometry = boundedRgbaGeometry(width, height);
  if (!(pixels instanceof Uint8Array) || pixels.byteLength !== geometry.bytes) {
    throw new Error(
      `RGBA signal bytes do not match ${width}x${height}: ${pixels?.byteLength ?? 'not-bytes'}, `
      + `expected ${geometry.bytes}`,
    );
  }
  if (!Number.isSafeInteger(nearBlackThreshold)
      || nearBlackThreshold < 0 || nearBlackThreshold > 255) {
    throw new Error(`near-black threshold must be an integer from 0 through 255: ${nearBlackThreshold}`);
  }

  let nearBlackPixels = 0;
  let opaquePixels = 0;
  let lumaSum = 0;
  let maximumChannel = 0;
  for (let offset = 0; offset < geometry.bytes; offset += 4) {
    const red = pixels[offset];
    const green = pixels[offset + 1];
    const blue = pixels[offset + 2];
    const alpha = pixels[offset + 3];
    maximumChannel = Math.max(maximumChannel, red, green, blue);
    if (red <= nearBlackThreshold
        && green <= nearBlackThreshold
        && blue <= nearBlackThreshold) nearBlackPixels += 1;
    if (alpha >= 250) opaquePixels += 1;
    lumaSum += (red * 0.2126) + (green * 0.7152) + (blue * 0.0722);
  }
  return Object.freeze({
    width,
    height,
    totalPixels: geometry.pixels,
    nearBlackPixels,
    nearBlackRatio: nearBlackPixels / geometry.pixels,
    opaquePixels,
    opaqueRatio: opaquePixels / geometry.pixels,
    meanLuma: lumaSum / geometry.pixels,
    maximumChannel,
    nearBlackThreshold,
  });
};

/**
 * Hash one exact rectangular region of a caller-owned RGBA buffer.
 *
 * Rows are copied into a tightly packed digest input rather than hashing one broad byte span. That
 * distinction matters whenever the source has row padding or the region does not cover the complete
 * frame width. Keeping this operation pure makes crop boundaries independently hostile-testable;
 * `digestFrameRgbaRegion` is the managed-FFmpeg file wrapper for screenshots and still frames.
 */
export const digestRgbaRegion = (
  pixels,
  {
    frameWidth,
    frameHeight,
    x,
    y,
    width,
    height,
    rowStrideBytes = frameWidth * 4,
  } = {},
) => {
  const frame = boundedRgbaGeometry(frameWidth, frameHeight);
  if (!(pixels instanceof Uint8Array)) {
    throw new Error('RGBA region input must be a byte array');
  }
  if (!Number.isSafeInteger(x) || x < 0
      || !Number.isSafeInteger(y) || y < 0
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error(
      `RGBA region geometry is invalid: ${width}x${height}+${x}+${y}`,
    );
  }
  const right = x + width;
  const bottom = y + height;
  if (!Number.isSafeInteger(right) || !Number.isSafeInteger(bottom)
      || right > frame.width || bottom > frame.height) {
    throw new Error(
      `RGBA region exceeds ${frame.width}x${frame.height}: ${width}x${height}+${x}+${y}`,
    );
  }

  const packedRowBytes = frame.width * 4;
  if (!Number.isSafeInteger(rowStrideBytes) || rowStrideBytes < packedRowBytes) {
    throw new Error(
      `RGBA row stride is invalid for ${frame.width}px: ${rowStrideBytes}, expected at least ${packedRowBytes}`,
    );
  }
  const sourceBytes = rowStrideBytes * frame.height;
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_RGBA_COMPARISON_BYTES) {
    throw new Error(`RGBA strided buffer is too large: ${rowStrideBytes}x${frame.height}`);
  }
  if (pixels.byteLength !== sourceBytes) {
    throw new Error(
      `RGBA strided byte length does not match ${frame.width}x${frame.height}: `
      + `${pixels.byteLength}, expected ${sourceBytes}`,
    );
  }

  const region = boundedRgbaGeometry(width, height);
  const rowBytes = width * 4;
  const packed = Buffer.allocUnsafe(region.bytes);
  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * rowStrideBytes) + (x * 4);
    const sourceEnd = sourceStart + rowBytes;
    packed.set(pixels.subarray(sourceStart, sourceEnd), row * rowBytes);
  }

  return Object.freeze({
    frameWidth: frame.width,
    frameHeight: frame.height,
    rowStrideBytes,
    x,
    y,
    width: region.width,
    height: region.height,
    pixels: region.pixels,
    bytes: region.bytes,
    sha256: createHash('sha256').update(packed).digest('hex'),
  });
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

export const newestMediaFile = (directory, existing = new Set()) => {
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .filter((path) => !existing.has(path))
    .filter((path) => ['.mp4', '.mkv', '.mov', '.webm'].includes(extname(path).toLowerCase()))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] ?? null;
};

export const listMediaFiles = (directory) => new Set(
  existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(directory, entry.name))
    : [],
);

export const probeMedia = (path) => JSON.parse(execFileSync(ffprobe(), [
  '-v', 'error',
  '-show_entries', 'format=duration,size,format_name:'
    + 'stream=index,codec_type,codec_name,width,height,duration,duration_ts,time_base,start_time,'
    + 'avg_frame_rate,r_frame_rate,sample_rate,channels',
  '-of', 'json',
  path,
], { encoding: 'utf8', timeout: 60_000, windowsHide: true }));

export const parseVolumeDetect = (output) => {
  const text = String(output ?? '');
  const parseLevel = (name) => {
    const match = new RegExp(`${name}:\\s*(-?inf|-?\\d+(?:\\.\\d+)?)\\s*dB`, 'iu').exec(text);
    if (match === null) return null;
    return /^-inf$/iu.test(match[1]) ? Number.NEGATIVE_INFINITY : Number(match[1]);
  };
  const sampleMatch = /n_samples:\s*(\d+)/iu.exec(text);
  const samples = sampleMatch === null ? null : Number(sampleMatch[1]);
  const meanVolumeDb = parseLevel('mean_volume');
  const peakVolumeDb = parseLevel('max_volume');
  if (!Number.isSafeInteger(samples) || samples <= 0
      || meanVolumeDb === null || peakVolumeDb === null) {
    throw new Error('FFmpeg volumedetect exposed no bounded audio-energy result');
  }
  return Object.freeze({ samples, meanVolumeDb, peakVolumeDb });
};

/** Measure decoded audio energy, not merely the presence of a plausible ffprobe stream header. */
export const measureAudioSignal = (path) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-nostdin', '-i', path, '-map', '0:a:0',
    '-af', 'volumedetect', '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`could not measure audio energy in ${basename(path)} (exit ${result.status ?? 'none'})`);
  }
  return parseVolumeDetect(output);
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
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      geometry = await readGeometry();
      if (geometry === null) {
        throw new Error(`the preview exposed no bounded composition viewport: ${JSON.stringify(geometry)}`);
      }
      await browser.saveScreenshot(raw);
      const after = await readGeometry();
      stable = after !== null
        && after.clock.revision === geometry.clock.revision
        && Object.is(after.clock.sourceMediaTime, geometry.clock.sourceMediaTime)
        && Object.is(after.clock.transportTime, geometry.clock.transportTime)
        && Object.is(after.clock.sceneTime, geometry.clock.sceneTime)
        && Object.is(after.clock.sourceClockProvenance, geometry.clock.sourceClockProvenance);
      if (stable) break;
      if (attempt < 3) await browser.pause(50);
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

export const extractFrame = (mediaPath, seconds, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-ss', String(seconds), '-i', mediaPath,
    '-frames:v', '1', '-pix_fmt', 'rgba', outputPath,
  ], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
};

export const compareFrames = (referencePath, candidatePath) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-i', referencePath, '-i', candidatePath,
    '-filter_complex', '[1:v][0:v]scale2ref[scaled][reference];[reference][scaled]ssim',
    '-f', 'null', '-',
  ], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, windowsHide: true,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const match = /SSIM[^\n]*All:([0-9.]+)/.exec(output);
  if (result.error !== undefined || result.status !== 0 || match === null) {
    throw new Error(
      `could not compare ${basename(referencePath)} and ${basename(candidatePath)} `
      + `(exit ${result.status ?? 'none'}): ${output}`,
    );
  }
  return Number(match[1]);
};
