// Workflow name, Main/Render preview selectors and the shared wait helper for the export
// animation parity matrix journey.



/* global browser */
export const WORKFLOW = 'export-animation-parity-matrix';
export const MAIN_CANVAS = '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]';
export const MAIN_VIDEO = '.video-preview video.video-player';
export const MAIN_STATE = '.video-preview [data-osg-preview]';
export const MAIN_SEEK = '.video-preview [data-osg-control="seek"]';
export const MAIN_PLAY_PAUSE = '.video-preview [data-osg-control="play-pause"]';
export const RENDER_CANVAS = '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]';
export const RENDER_VIDEO = '.video-preview-panel video';
export const RENDER_STATE = '.video-preview-panel [data-osg-preview]';
export const RENDER_SEEK = '.video-preview-panel [data-osg-control="seek"]';
export const RENDER_BUTTON = '.video-rendering-section.expanded [data-osg-action="render-video"]';

export async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
