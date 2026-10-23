// Pure, bounded RGBA buffer comparisons and digests used by the native-media oracle.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const MAX_RGBA_COMPARISON_PIXELS = 16 * 1024 * 1024;
export const MAX_RGBA_COMPARISON_BYTES = MAX_RGBA_COMPARISON_PIXELS * 4;

export const boundedRgbaGeometry = (width, height) => {
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

export const boundedChannelDeltaThreshold = (value) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 255) {
    throw new Error(`RGBA channel delta threshold must be an integer from 1 through 255: ${value}`);
  }
  return value;
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
