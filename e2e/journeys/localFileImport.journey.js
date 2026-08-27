// A customer opens a video already on their disk. Import IS the subject here: other green journeys
// open a local file on their way to persistence or glyph coverage, so a defect that only affects
// import — a wrong size, a dishonest durable pointer, a fabricated cue, a silent decode substitute —
// would be reported by the wrong journey or not at all. The application imports by OWNED COPY into
// its content-addressed artifact store; this journey proves that copy is byte-exactly the selected
// file and becomes the sole durable, playable media.
//
// The ONLY substitution is the operating system's file dialog, which a WebDriver session cannot
// drive; the application resolves the staged selection and runs exactly the import a person's click
// produces. The oracles are independent: ffprobe reads the source before the app does, SQLite is
// read read-only after the fact, and the durable location pointer is decoded and re-hashed here
// rather than trusted.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { durableState, withDatabase } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import {
  comparableWindowsPath, decodeMediaLocationPath,
} from '../support/mediaLocationOracle.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'local-file-import';
const DURATION_TOLERANCE_SECONDS = 0.5;

/* global browser, describe, document, it */

const sha256OfFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** What the customer can currently see and play, read in one pass for coherent diagnostics. */
const importSurface = () => browser.execute(() => {
  const video = document.querySelector('.video-preview video.video-player');
  return {
    video: video === null ? null : {
      duration: video.duration,
      currentTime: video.currentTime,
      readyState: video.readyState,
      seeking: video.seeking,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      currentSrc: video.currentSrc,
      error: video.error === null ? null : { code: video.error.code, message: video.error.message },
    },
    waveformState: document.querySelector('[data-osg-waveform-state]')
      ?.getAttribute('data-osg-waveform-state') ?? null,
    errorSurfaces: [...document.querySelectorAll('[role="alert"], .error, .error-message')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6),
    bodyText: (document.body?.innerText || '').slice(0, 20_000),
  };
});

/** The durable location pointers, exactly as persisted, joined to their media identity. */
const durableMediaLocations = (root) => withDatabase(root, (database) => (
  database.prepare(
    'SELECT hex(media_id) AS media_id, path_bytes, path_encoding, platform, available'
    + ' FROM media_locations',
  ).all().map((row) => ({
    mediaId: String(row.media_id).toLowerCase(),
    decodedPath: decodeMediaLocationPath(row),
    platform: row.platform,
    available: row.available,
  }))
));

describe('opening a video already on disk', () => {
  it('registers the exact selected file as the sole durable, playable media', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const staged = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(staged, 'the harness must have staged a real media selection');

    // Independent source identity, established before the application ever sees the file.
    const sourceBytes = statSync(staged).size;
    const sourceSha256 = sha256OfFile(staged);
    const probe = probeMedia(staged);
    const sourceVideoStream = (probe.streams ?? []).find((stream) => stream.codec_type === 'video');
    const sourceDuration = Number(probe.format?.duration);
    assert.ok(sourceVideoStream, 'the staged selection must contain a real video stream');
    assert.ok(Number.isFinite(sourceDuration) && sourceDuration > 1,
      'the staged selection must have a real duration');

    await openEditor();
    await clickControl('[data-input-tab="file-upload"]');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-upload-surface',
      description: 'The real Upload File surface before any selection.',
    });

    await clickControl('.file-upload-input');
    let surface = null;
    await browser.waitUntil(async () => {
      surface = await importSurface();
      return surface.video !== null && Number.isFinite(surface.video.duration);
    }, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'the selected media never became playable in the editor',
    });

    // The playing element must describe the staged file, not a substitute or a partial decode.
    assert.equal(surface.video.error, null, 'the imported video reported a decode error');
    assert.ok(Math.abs(surface.video.duration - sourceDuration) <= DURATION_TOLERANCE_SECONDS,
      `the editor reports ${surface.video.duration}s for a ${sourceDuration}s source`);
    assert.equal(surface.video.videoWidth, sourceVideoStream.width,
      'the imported video width differs from the source');
    assert.equal(surface.video.videoHeight, sourceVideoStream.height,
      'the imported video height differs from the source');
    assert.match(surface.video.currentSrc, /^http:\/\/127\.0\.0\.1:\d+\/asset\//u,
      'the preview must stream from the private native media server, not a browser fallback');
    assert.ok(surface.bodyText.includes(basename(staged)),
      'the customer never saw the name of the file they selected');
    assert.deepEqual(surface.errorSurfaces, [], 'importing a valid video surfaced an error');

    // Durable identity, read independently after the fact.
    let durable = null;
    await browser.waitUntil(async () => {
      durable = durableState(root);
      return durable.counts.projects === 1 && durable.counts.media === 1
        && durable.links.length === 1;
    }, {
      timeout: 60_000,
      interval: 1_000,
      timeoutMsg: 'the import never became one durable project owning one media asset',
    });
    const media = durable.media[0];
    assert.equal(media.kind, 'video');
    assert.equal(media.display_name, basename(staged),
      'the durable display name is not the selected file name');
    assert.equal(media.extension, 'mp4');
    assert.equal(media.size_bytes, sourceBytes,
      'the durable size differs from the selected file');
    assert.match(String(media.content_hash), /^[0-9a-f]{64}$/u,
      'the import must record a real 32-byte content identity');
    assert.equal(durable.cues.length, 0, 'importing media alone must not fabricate cues');
    assert.ok(durable.jobs.every(({ state }) => state !== 'failed'),
      `import left a failed job: ${JSON.stringify(durable.latestJob)}`);

    // The application imports by OWNED COPY: the durable location must live inside the project's
    // own artifact store — never point back at the arbitrary customer path, whose file can move
    // or vanish — and the owned copy must hold exactly the bytes the customer selected.
    const locations = durableMediaLocations(root);
    assert.equal(locations.length, 1, 'exactly one media location must be recorded');
    assert.equal(locations[0].mediaId, media.id, 'the location does not belong to the imported media');
    assert.equal(locations[0].available, 1, 'the imported location must be marked available');
    const ownedStore = `${comparableWindowsPath(join(root, 'data', 'artifacts'))}\\`;
    assert.ok(
      comparableWindowsPath(locations[0].decodedPath).startsWith(ownedStore),
      `the durable location escaped the owned artifact store: ${locations[0].decodedPath}`,
    );
    assert.equal(statSync(locations[0].decodedPath).size, sourceBytes,
      'the owned copy does not have the selected byte count');
    assert.equal(sha256OfFile(locations[0].decodedPath), sourceSha256,
      'the owned copy no longer holds the selected bytes');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-imported-playable',
      description: 'The selected file is active with its real name, duration and dimensions.',
      details: {
        sourceBytes,
        sourceSha256,
        sourceDuration,
        reportedDuration: surface.video.duration,
      },
    });

    // A real frame from the middle of the file proves decode, not just metadata.
    const target = Math.min(4, sourceDuration - 0.5);
    await browser.execute((seconds) => {
      const video = document.querySelector('.video-preview video.video-player');
      video.pause();
      video.currentTime = seconds;
    }, target);
    await browser.waitUntil(async () => {
      surface = await importSurface();
      return surface.video !== null && !surface.video.seeking
        && Math.abs(surface.video.currentTime - target) < 0.25
        && surface.video.readyState >= 2;
    }, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: 'the imported video never presented a mid-file frame',
    });

    await browser.waitUntil(async () => {
      surface = await importSurface();
      return surface.waveformState === 'ready';
    }, {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: 'the audio waveform never became ready for the imported file',
    });

    assert.deepEqual(surface.errorSurfaces, [], 'a late error surfaced after import');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-mid-file-frame',
      description: 'A mid-file frame decodes and the audio waveform is ready.',
      details: { playheadSeconds: target },
      focusSelector: '.video-preview .video-container',
    });
  });
});
