// A customer pastes a real YouTube link and saves the video to their disk.
//
// This is the product's real acquisition path, end to end and unsubstituted: the application
// installs FFmpeg, yt-dlp and Deno for itself from its reviewed delivery catalog, scans the real URL
// for the formats it actually offers, downloads the one the customer picked, and writes it where
// they said. No local origin pretending to be a CDN, no fixture MP4, no mocked IPC.
//
// WHAT "DOWNLOAD ONLY" MEANS, because the first version of this journey got it wrong. It is
// save-to-disk. It does NOT load the video into the editor — it downloads, exports to the chosen
// destination, and discards the candidate. So it opens a native save dialog, which is correct: a
// customer asking for a file on their disk has to say where. The journeys that work ON a video open
// it afterwards, which is `editPersistRelaunch` and the rest.
//
// THE SAVE DIALOG IS STAGED, NOT AVOIDED. `OSG_E2E_MEDIA_DESTINATION` answers it with a path inside
// the reviewed fixture root, the way `OSG_E2E_MEDIA_SELECTION` answers the open dialog. Both are
// compiled only into the automation channel. Everything after the dialog — the download, the
// export, the bytes — is the product's own.
//
// WHAT IT CANNOT SEE. The video's real title needs a YouTube Data API credential, which this
// harness has none of, so the card reads "YouTube Video". That is what an unconfigured install
// shows and it does not affect the download, which goes through yt-dlp. The journey asserts the
// resolved video ID instead, which is credential-free and is the thing that decides what is fetched.
//
// WHAT IT COSTS. The first run on a machine installs about 110 MB of tools, which is the product's
// own first-run behaviour; `e2e/support/environment.js` keeps them between runs. The video is
// nineteen seconds.

import { strict as assert } from 'node:assert';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { confirmDownloadOnly } from '../support/download.js';
import { clickControl, openEditor } from '../support/editor.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'url-to-preview';

// Installing the tools and fetching the video is a real network operation on a first run. Kept
// BELOW mocha's own cap so this journey's diagnostic is what gets reported, not "took too long".
const WORKFLOW_TIMEOUT_MS = 600_000;

/** Everything a failure needs to name the exact edge that broke. */
const inspect = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6);
  return {
    errors: text('.error, [role="alert"]'),
    status: text('[role="status"]'),
    progress: text('[class*="progress" i], [class*="downloading" i]'),
    toasts: text('[class*="toast" i]'),
    errorToasts: text('.toast-error'),
    modalOpen: document.querySelector('.download-only-modal') !== null,
    videoTitle: text('.video-title'),
    videoId: text('.video-id-value'),
    pageText: (document.body?.innerText || '').slice(0, 400),
  };
});

const report = (label, seen) => console.log(`--- ${label} ---\n${JSON.stringify(seen, null, 2)}`);

describe('a customer saves a real YouTube video to disk', () => {
  it('installs its tools, scans the real URL, downloads it and writes the file', async () => {
    const directory = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(directory, 'the harness must stage a save directory for this journey');
    // The application CANONICALIZES this directory before it will honour the staging. A missing one
    // is refused silently, which opens a real save dialog behind the window and hangs the run.
    assert.ok(existsSync(directory), `the staged save directory must exist: ${directory}`);
    const before = new Set(readdirSync(directory));
    const written = () => readdirSync(directory).filter((name) => !before.has(name));

    const onboarding = await openEditor();
    console.log(`onboarding cleared: ${JSON.stringify(onboarding)}`);
    console.log(`real video: ${REAL_VIDEO.url}`);
    console.log(`staged save directory: ${directory}`);

    // The real control, driven the way a person drives it: focus the field, type the link.
    const field = await $('.url-field');
    await field.waitForDisplayed({ timeout: 30_000 });
    await field.setValue(REAL_VIDEO.url);

    // Typing a link resolves it: the application fetches the video's identity and shows a preview
    // card. That the card names the RIGHT video is the first thing worth asserting — a resolution
    // that silently failed would still let the button below be pressed.
    let seen = await inspect();
    await waitUntilWithFreshDiagnostic(async () => {
      seen = await inspect();
      return seen.videoId.includes(REAL_VIDEO.id);
    }, {
      timeout: 120_000,
      interval: 2_000,
      diagnostic: () => `the URL never resolved to ${REAL_VIDEO.id}. last: ${JSON.stringify(seen)}`,
    });
    report('after the URL resolved', seen);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-url-resolved',
      description: 'The pasted real YouTube URL resolved to the intended video before downloading.',
      details: { videoId: REAL_VIDEO.id },
    });

    // The TITLE is deliberately not asserted. It comes from the YouTube Data API, which needs an
    // API key or OAuth this harness does not have, so an unconfigured install shows the placeholder
    // "YouTube Video" — measured, and correct: the download below uses yt-dlp and needs no
    // credential at all. Asserting the title here would be asserting that a key is configured.
    console.log(`title shown without a Data API credential: ${JSON.stringify(seen.videoTitle)}`);

    // "Download Only" opens a modal that scans the real URL for the formats it actually offers. The
    // customer chooses a type and a quality from that scan, and only then can confirm.
    await clickControl('.download-only-btn');
    await confirmDownloadOnly({
      afterScan: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-quality-selection',
        description: 'The real yt-dlp scan produced customer-selectable video qualities.',
        details: { qualities: state.qualities },
      }),
    });

    // The customer outcome: the file they asked for is on their disk. Progress and job status are
    // steps along the way, not the thing being asserted.
    let polls = 0;
    await waitUntilWithFreshDiagnostic(async () => {
      seen = await inspect();
      polls += 1;
      if (polls % 10 === 0) {
        console.log(`still waiting after ${polls * 3}s; visible: `
          + JSON.stringify({ errors: seen.errors, progress: seen.progress, toasts: seen.toasts }));
      }
      const fresh = written();
      return fresh.length > 0 && statSync(join(directory, fresh[0])).size > 0;
    }, {
      timeout: WORKFLOW_TIMEOUT_MS,
      interval: 3_000,
      diagnostic: () => [
        'the video was never written to the staged directory.',
        `directory: ${directory}`,
        'If nothing arrived and no error is visible, the staging was refused and a REAL save '
          + 'dialog is open behind the application window.',
        `last observation: ${JSON.stringify(seen, null, 2)}`,
      ].join('\n'),
    });

    const [name] = written();
    const bytes = statSync(join(directory, name)).size;
    // Writing bytes is not terminal success. Export can finish and then fail while acknowledging
    // completion or discarding its detached candidate; that failure is shown as a toast while the
    // download modal remains open. The old oracle reported that toast but asserted only elements
    // carrying `.error`/`role=alert`, so this exact customer-visible failure passed green.
    seen = await inspect();
    console.log(`wrote ${bytes} bytes to ${name}`);
    report('after the download finished', seen);

    // A real video, not an empty file or an error page saved under an .mp4 name. "Me at the zoo" at
    // its lowest rung is a few hundred kilobytes; the bound is loose because the exact encode is
    // yt-dlp's business and changes without notice.
    assert.ok(bytes > 50_000, `the saved file must be a real video, not ${bytes} bytes`);
    assert.deepEqual(seen.errors, [], 'no error may be visible after a successful download');
    assert.deepEqual(seen.errorToasts, [], 'no failure toast may be visible after a successful download');
    assert.equal(seen.modalOpen, false, 'the download modal must close after terminal success');
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'downloaded-video',
      source: join(directory, name),
      description: 'The real video bytes saved by the customer-facing Download Only workflow.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-download-complete',
      description: 'The save-to-disk workflow completed with no visible error or stranded modal.',
      details: { fileName: name, bytes },
    });
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
