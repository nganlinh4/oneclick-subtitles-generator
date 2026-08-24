// A customer must be able to see and operate on cues that extend past media,
// while the waveform remains bounded by playable media time.

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import {
  importSubtitleDocument,
  openProjectWithMedia,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'timeline-boundary';
const BOUNDARY_CUE = 'Boundary cue beyond media';

/* global $, browser, describe, document, it */

const srtTime = (seconds) => {
  const milliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

describe('timeline boundaries', () => {
  it('clips waveform pixels to media and lets Ctrl+A clear every cue', async () => {
    await openProjectWithMedia();
    const duration = await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      if (video === null || !Number.isFinite(video.duration)) return null;
      return video.duration;
    });
    assert.ok(duration > 2, `the real video has no usable duration: ${duration}`);

    const cueStart = duration - 0.25;
    const cueEnd = duration + 2;
    const subtitles = [
      '1',
      `${srtTime(0.5)} --> ${srtTime(2)}`,
      'First cue for the preview',
      '',
      '2',
      `${srtTime(cueStart)} --> ${srtTime(cueEnd)}`,
      BOUNDARY_CUE,
      '',
    ].join('\n');
    await importSubtitleDocument(subtitles, 'timeline-boundary.srt', BOUNDARY_CUE);

    let waveformMeasurement = null;
    await browser.waitUntil(async () => {
      waveformMeasurement = await browser.execute((mediaEnd, contentEnd) => {
        const host = document.querySelector('[data-osg-waveform-state="ready"]');
        const canvas = host?.querySelector('canvas') ?? null;
        if (canvas === null || canvas.width <= 0 || canvas.height <= 0) return null;
        const context = canvas.getContext('2d');
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const viewEnd = contentEnd * 1.05;
        const expectedBoundary = (mediaEnd / viewEnd) * canvas.width;
        const columnHasInk = (x) => {
          for (let y = 0; y < canvas.height; y += 1) {
            if (pixels[((y * canvas.width) + x) * 4 + 3] > 0) return true;
          }
          return false;
        };
        const beforeStart = Math.max(0, Math.floor(expectedBoundary) - 12);
        const afterStart = Math.min(canvas.width, Math.ceil(expectedBoundary) + 3);
        let inkBefore = false;
        let inkAfter = false;
        for (let x = beforeStart; x < Math.floor(expectedBoundary); x += 1) {
          inkBefore ||= columnHasInk(x);
        }
        for (let x = afterStart; x < canvas.width; x += 1) {
          inkAfter ||= columnHasInk(x);
        }
        return {
          width: canvas.width,
          height: canvas.height,
          expectedBoundary,
          inkBefore,
          inkAfter,
        };
      }, duration, cueEnd);
      return waveformMeasurement?.inkBefore === true && waveformMeasurement.inkAfter === false;
    }, {
      timeout: 180_000,
      interval: 500,
      timeoutMsg: () => `waveform pixels did not stop at playable media: ${JSON.stringify(waveformMeasurement)}`,
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-reachable-boundary-cue',
      description: 'A cue beyond media remains visible while waveform pixels stop at playable time.',
      details: { duration, cueStart, cueEnd, waveformMeasurement },
      focusSelector: '.timeline-container',
    });

    const timeline = await $('.subtitle-timeline');
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const actionBar = await $('.range-action-bar');
    await actionBar.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'Ctrl+A did not expose actions for every subtitle',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-select-all-through-last-cue',
      description: 'Ctrl+A reaches the final subtitle even though it ends after the video.',
      details: { cueEnd, duration },
      focusSelector: '.timeline-container',
    });

    await browser.keys(['\uE017']);
    await browser.waitUntil(async () => {
      const visibleCueCount = await browser.execute(
        () => document.querySelectorAll('.lyric-text').length,
      );
      return visibleCueCount === 0
        && durableState(process.env.OSG_E2E_DATA_ROOT).counts.cues === 0;
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: 'Delete after Ctrl+A left at least one visible or durable cue behind',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-all-cues-cleared',
      description: 'Delete after Ctrl+A removes every visible and durable cue, including the boundary cue.',
      focusSelector: '.lyrics-container-wrapper',
    });
  });
});
