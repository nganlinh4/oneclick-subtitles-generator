import { execFileSync, spawnSync } from 'node:child_process';
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
  '-show_entries', 'format=duration,size,format_name:stream=index,codec_type,codec_name,width,height',
  '-of', 'json',
  path,
], { encoding: 'utf8', timeout: 60_000 }));

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
  const centered = await browser.execute((canvasSelector) => {
    const canvas = document.querySelector(canvasSelector);
    if (canvas === null) return false;
    const rect = canvas.getBoundingClientRect();
    window.scrollBy(0, rect.top - Math.max(0, (window.innerHeight - rect.height) / 2));
    return true;
  }, selector);
  if (!centered) throw new Error(`the preview canvas is missing: ${selector}`);
  await browser.pause(100);
  const geometry = await browser.execute((canvasSelector) => {
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
    };
  }, selector);
  if (geometry === null
      || !Object.entries(geometry).filter(([key]) => key !== 'bounds')
        .every(([, value]) => Number.isFinite(value))
      || !Object.values(geometry.bounds).every(Number.isFinite)
      || geometry.canvasWidth <= 0 || geometry.canvasHeight <= 0
      || geometry.windowWidth <= 0 || geometry.windowHeight <= 0
      || geometry.bounds.width <= 0 || geometry.bounds.height <= 0
      || geometry.width <= 0 || geometry.height <= 0) {
    throw new Error(`the preview exposed no bounded composition viewport: ${JSON.stringify(geometry)}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  const raw = `${path}.element.png`;
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
  try {
    await browser.saveScreenshot(raw);
    const image = JSON.parse(execFileSync(ffprobe(), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'json', raw,
    ], { encoding: 'utf8', timeout: 60_000 })).streams?.[0];
    if (!(image?.width > 0 && image?.height > 0)) throw new Error('element screenshot has no dimensions');
    const screenshotScaleX = image.width / geometry.windowWidth;
    const screenshotScaleY = image.height / geometry.windowHeight;
    const backingToCssX = geometry.bounds.width / geometry.canvasWidth;
    const backingToCssY = geometry.bounds.height / geometry.canvasHeight;
    const cropWidth = Math.max(1, Math.round(geometry.width * backingToCssX * screenshotScaleX));
    const cropHeight = Math.max(1, Math.round(geometry.height * backingToCssY * screenshotScaleY));
    const cropLeft = Math.max(0, Math.round(
      (geometry.bounds.left + geometry.left * backingToCssX) * screenshotScaleX,
    ));
    const cropTop = Math.max(0, Math.round(
      (geometry.bounds.top + geometry.top * backingToCssY) * screenshotScaleY,
    ));
    execFileSync(ffmpeg(), [
      '-v', 'error', '-y', '-i', raw,
      '-vf', `crop=${cropWidth}:${cropHeight}:${cropLeft}:${cropTop}`,
      '-frames:v', '1', path,
    ], { stdio: 'pipe', timeout: 60_000 });
    return { width: cropWidth, height: cropHeight, bytes: statSync(path).size };
  } finally {
    await browser.execute((canvasSelector) => {
      const canvas = document.querySelector(canvasSelector);
      const scope = canvas?.parentElement;
      if (scope === undefined || scope === null) return;
      for (const node of scope.querySelectorAll('[data-osg-e2e-capture-style]')) {
        const previous = node.dataset.osgE2eCaptureStyle;
        if (previous === '__missing__') node.removeAttribute('style');
        else node.setAttribute('style', previous);
        delete node.dataset.osgE2eCaptureStyle;
      }
    }, selector);
    if (existsSync(raw)) unlinkSync(raw);
  }
};

export const extractFrame = (mediaPath, seconds, outputPath) => {
  mkdirSync(dirname(outputPath), { recursive: true });
  execFileSync(ffmpeg(), [
    '-v', 'error', '-y', '-ss', String(seconds), '-i', mediaPath,
    '-frames:v', '1', '-pix_fmt', 'rgba', outputPath,
  ], { stdio: 'pipe', timeout: 60_000 });
};

export const compareFrames = (referencePath, candidatePath) => {
  const result = spawnSync(ffmpeg(), [
    '-v', 'info', '-i', referencePath, '-i', candidatePath,
    '-filter_complex', '[1:v][0:v]scale2ref[scaled][reference];[reference][scaled]ssim',
    '-f', 'null', '-',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
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
