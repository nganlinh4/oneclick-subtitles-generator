/**
 * The source-video layer of the canvas preview: contain-fit viewport, crop/flip, and the blurred or
 * solid backfill outside the cropped picture.
 */
import { rgba } from './canvasSubtitleColor.js';

const BACKFILL_ZOOM = 1.06;
const BACKFILL_BRIGHTNESS = 0.7;

export const fitContain = (outerWidth, outerHeight, innerWidth, innerHeight) => {
  const scale = Math.min(outerWidth / innerWidth, outerHeight / innerHeight);
  const width = innerWidth * scale;
  const height = innerHeight * scale;
  return { left: (outerWidth - width) / 2, top: (outerHeight - height) / 2, width, height, scale };
};

export const videoIsDrawable = (video) => {
  const image = video?.image ?? video;
  const sourceWidth = video?.videoWidth ?? image?.videoWidth ?? image?.width ?? 0;
  const sourceHeight = video?.videoHeight ?? image?.videoHeight ?? image?.height ?? 0;
  const ready = video?.readyState === undefined || video.readyState >= 2;
  return image !== null && image !== undefined && sourceWidth > 0 && sourceHeight > 0 && ready;
};

export const drawVideoUnderlay = (context, video, viewport, crop) => {
  if (!videoIsDrawable(video)) return false;
  const image = video?.image ?? video;
  const sourceWidth = video?.videoWidth ?? image?.videoWidth ?? image?.width ?? 0;
  const sourceHeight = video?.videoHeight ?? image?.videoHeight ?? image?.height ?? 0;
  const left = Number(crop?.x ?? 0) / 100;
  const top = Number(crop?.y ?? 0) / 100;
  const width = Number(crop?.width ?? 100) / 100;
  const height = Number(crop?.height ?? 100) / 100;

  context.save();
  context.beginPath();
  context.rect(viewport.left, viewport.top, viewport.width, viewport.height);
  context.clip();

  if (crop?.canvasBgMode === 'blur') {
    const cover = Math.max(viewport.width / sourceWidth, viewport.height / sourceHeight) * BACKFILL_ZOOM;
    const drawnWidth = sourceWidth * cover;
    const drawnHeight = sourceHeight * cover;
    const blur = Math.min(Number(crop.canvasBgBlur ?? 24), 80) * viewport.scale * 0.5;
    context.save();
    context.filter = `blur(${blur}px) brightness(${BACKFILL_BRIGHTNESS})`;
    context.drawImage(
      image,
      viewport.left + (viewport.width - drawnWidth) / 2,
      viewport.top + (viewport.height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
    context.restore();
  } else {
    context.fillStyle = rgba(crop?.canvasBgColor ?? '#000000');
    context.fillRect(viewport.left, viewport.top, viewport.width, viewport.height);
  }

  const intersectionLeft = Math.max(0, left);
  const intersectionTop = Math.max(0, top);
  const intersectionRight = Math.min(1, left + width);
  const intersectionBottom = Math.min(1, top + height);
  if (intersectionRight > intersectionLeft && intersectionBottom > intersectionTop) {
    const destination = {
      left: viewport.left + ((intersectionLeft - left) / width) * viewport.width,
      top: viewport.top + ((intersectionTop - top) / height) * viewport.height,
      width: ((intersectionRight - intersectionLeft) / width) * viewport.width,
      height: ((intersectionBottom - intersectionTop) / height) * viewport.height,
    };
    context.save();
    context.translate(viewport.left + viewport.width / 2, viewport.top + viewport.height / 2);
    context.scale(crop?.flipX ? -1 : 1, crop?.flipY ? -1 : 1);
    context.translate(-(viewport.left + viewport.width / 2), -(viewport.top + viewport.height / 2));
    context.drawImage(
      image,
      intersectionLeft * sourceWidth,
      intersectionTop * sourceHeight,
      (intersectionRight - intersectionLeft) * sourceWidth,
      (intersectionBottom - intersectionTop) * sourceHeight,
      destination.left,
      destination.top,
      destination.width,
      destination.height,
    );
    context.restore();
  }
  context.restore();
  return true;
};
