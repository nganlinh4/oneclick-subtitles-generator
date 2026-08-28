// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's "downloadQualityVariants" note.
//
// A customer picks two or three DIFFERENT real video qualities from the "Download Only" scan of the
// same pinned real YouTube video, and each choice reaches the real Rust download request and
// produces a file whose independently probed geometry matches what was actually requested.
//
// WHAT WAS ENUMERATED, NOT ASSUMED. src/components/DownloadOnlyModal.js offers exactly two top-level
// TYPE radios, Video and Audio. For Video it lists whatever real qualities
// src/utils/qualityScanner.js's `mapNativeVideoQualities` returns from the real yt-dlp inventory scan
// (`inspectDownloadUrl` -> native `download_inspect`), one radio pill per rung, tallest first. There
// is no other public quality control anywhere in the download surface. This journey drives that REAL
// scan against the pinned real video urlToPreview already proves end to end, and selects rungs
// urlToPreview does NOT: urlToPreview always confirms the LOWEST pill (support/download.js's default
// `pickQuality`); this journey covers the tallest, and a genuine middle rung when the real scan offers
// three or more, via the SAME shared confirm/scan helper extended with its own `pickQuality`.
//
// WHY NO SQLITE/LOG ECHOES THE REQUESTED HEIGHT, AND WHAT THIS JOURNEY USES INSTEAD. See the long
// comment at the top of support/downloadQualityVariantsOracle.js: media_assets carries no
// width/height/quality column, and no diagnostic log records yt-dlp's --format argument. The honest,
// credential-free observable this journey uses is behavioral: independently ffprobe the customer's
// saved file for each requested quality and require the decoded geometry to (a) never exceed the
// requested height and (b) be DISTINCT across rounds (assertRoundsAreDistinct) -- the only way that
// can be true is if the requested height genuinely reached and shaped the real yt-dlp process
// (crates/osg-download/src/plan.rs's `format_selector`, ~lines 328-366).
//
// WHY NOT THE DETERMINISTIC LOOPBACK FIXTURE (support/downloadFixtureOrigin.js). Its two sources are
// direct MP4 URLs. crates/osg-download/src/plan.rs's `direct_mp4_format_id` path REFUSES
// `VideoQuality::AtMost` outright for a direct single-format source
// (`InvalidOption("direct media has no bounded video height")`) -- there is no second real rung to
// request against it. Quality VARIANTS can only be proven against a real multi-format provider
// inventory, so this journey stays on the real network the same way urlToPreview does, rather than
// widening the fixture origin's two-URL allow-list for a request shape it cannot legally serve.
//
// WHY THE STAGED DESTINATION IS CLEARED BETWEEN ROUNDS. `OSG_E2E_MEDIA_DESTINATION` answers one fixed
// directory for the whole process, and the automation build's typed refusal
// (apps/desktop/src-tauri/src/dialog_paths.rs's `validate_staged_save_destination`) rejects a
// destination path that already exists -- there is no overwrite/uniquify fallback. Every round
// downloads the SAME video, so its proposed filename repeats; this journey moves each round's saved
// file into its own `kept-<label>` subfolder immediately after probing it, freeing the flat
// destination for the next round without touching any product code.
//
// WHY NO DURABLE ARTIFACT ACCUMULATES ACROSS ROUNDS. "Download Only" discards its internal candidate
// after export (src/platform/userMediaExportFlow.js awaits `discardCandidate` before reporting
// success; apps/desktop/src-tauri/src/download.rs's own discard test, ~lines 1818-1840, shows the
// discarded candidate becomes unresolvable and its durable path stops existing) -- only the download
// JOB row persists, as append-only history. This journey asserts exactly that shape per round: one
// new succeeded job, and no surviving artifact/media row or scratch bytes.

/* global $, browser, describe, document, it, process */

import { strict as assert } from 'node:assert';
import {
  existsSync, mkdirSync, readdirSync, renameSync, statSync,
} from 'node:fs';
import { join } from 'node:path';

import { confirmDownloadOnly } from '../support/download.js';
import {
  downloadDurabilityState, downloadScratchFiles, managedArtifactFiles,
} from '../support/downloadJourneyOracle.js';
import {
  approximateBitrateKbps, assertRoundsAreDistinct, chooseQualityRounds, parseQualityHeight,
  verifyQualityRound,
} from '../support/downloadQualityVariantsOracle.js';
import { clickControl, openEditor } from '../support/editor.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'download-quality-variants';
const SCAN_AND_DOWNLOAD_TIMEOUT_MS = 300_000;

const inspect = () => browser.execute(() => {
  const text = (selector) => [...document.querySelectorAll(selector)]
    .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 6);
  return {
    errors: text('.error, [role="alert"]'),
    errorToasts: text('.toast-error'),
    videoId: text('.video-id-value'),
  };
});

const written = (directory, before) => readdirSync(directory).filter((name) => !before.has(name));

const waitUntilWithFreshDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

/** One full "Download Only" round at one requested quality, returning the saved file's own path. */
const runQualityRound = async ({ directory, round }) => {
  const before = new Set(readdirSync(directory));
  await clickControl('.download-only-btn');
  await confirmDownloadOnly({
    pickQuality: (qualities) => {
      const chosen = qualities.findIndex((label) => parseQualityHeight(label) === round.height);
      assert.ok(
        chosen !== -1,
        `round ${round.label}: the real scan no longer offers a ${round.height}p pill: ${JSON.stringify(qualities)}`,
      );
      return chosen;
    },
  });

  let seen = await inspect();
  await waitUntilWithFreshDiagnostic(async () => {
    seen = await inspect();
    const fresh = written(directory, before);
    return fresh.length > 0 && statSync(join(directory, fresh[0])).size > 0;
  }, {
    timeout: SCAN_AND_DOWNLOAD_TIMEOUT_MS,
    interval: 2_000,
    diagnostic: () => `round ${round.label}: no file arrived at the staged destination. last: ${JSON.stringify(seen)}`,
  });
  assert.deepEqual(seen.errors, [], `round ${round.label}: no error may be visible after a successful download`);
  assert.deepEqual(seen.errorToasts, [], `round ${round.label}: no failure toast may be visible after a successful download`);

  const [name] = written(directory, before);
  const path = join(directory, name);
  const bytes = statSync(path).size;
  assert.ok(bytes > 10_000, `round ${round.label}: the saved file must be a real video, not ${bytes} bytes`);
  return path;
};

describe('a customer downloads the same real video at different requested qualities', () => {
  it('proves each requested quality reaches the real download and shapes the decoded geometry', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const directory = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'the journey has no isolated data root');
    assert.ok(directory, 'the harness must stage a save directory for this journey');
    assert.ok(existsSync(directory), `the staged save directory must exist: ${directory}`);

    await openEditor();
    const field = await $('.url-field');
    await field.waitForDisplayed({ timeout: 30_000 });
    await field.setValue(REAL_VIDEO.url);
    await waitUntilWithFreshDiagnostic(async () => (await inspect()).videoId.includes(REAL_VIDEO.id), {
      timeout: 120_000,
      interval: 2_000,
      diagnostic: () => `the URL never resolved to ${REAL_VIDEO.id}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-url-resolved',
      description: 'The pinned real YouTube URL resolved before any quality was chosen.',
      details: { videoId: REAL_VIDEO.id },
    });

    // Scan once through the real modal to learn what the live inventory actually offers, then close
    // without downloading. This is the same public scan urlToPreview drives; only the choice differs.
    let scannedQualities = null;
    await clickControl('.download-only-btn');
    await clickControl('.download-only-modal input[name="download-type"][value="video"]');
    await waitUntilWithFreshDiagnostic(async () => {
      scannedQualities = await browser.execute(() => [
        ...document.querySelectorAll('.quality-pill-label'),
      ].map((node) => (node.innerText || '').trim()));
      const noQualities = (await browser.execute(() => (
        document.querySelector('.download-only-modal .no-qualities') !== null
      )));
      return scannedQualities.length > 0 || noQualities;
    }, {
      timeout: SCAN_AND_DOWNLOAD_TIMEOUT_MS,
      interval: 2_000,
      diagnostic: () => 'the real quality scan never finished',
    });
    await clickControl('.download-only-modal .cancel-button');

    const rounds = chooseQualityRounds(scannedQualities);
    assert.ok(rounds.length >= 2 && rounds.length <= 3, `expected 2-3 quality rounds, got ${rounds.length}`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-qualities-scanned',
      description: 'The real yt-dlp scan produced the customer-selectable qualities this journey covers.',
      details: { allQualities: scannedQualities, chosenRounds: rounds.map(({ label }) => label) },
    });

    const before = downloadDurabilityState(root);
    const beforeJobCount = before.jobs.filter(({ state }) => state === 'succeeded').length;
    const verified = [];
    for (const round of rounds) {
      const savedPath = await runQualityRound({ directory, round });
      const probe = probeMedia(savedPath);
      const result = verifyQualityRound({ round, probe });
      const bitrateKbps = approximateBitrateKbps(probe);
      verified.push({ ...result, bitrateKbps });

      const after = downloadDurabilityState(root);
      assert.equal(
        after.jobs.filter(({ state }) => state === 'succeeded').length,
        beforeJobCount + verified.length,
        `round ${round.label}: expected exactly ${verified.length} new succeeded download job(s) since the run began`,
      );
      // "Download Only" discards its candidate after export (see the file header comment): no
      // artifact/media row or scratch bytes may survive any round.
      assert.equal(after.artifacts.length, 0, `round ${round.label}: a discarded candidate left an artifact row`);
      assert.equal(after.media.length, 0, `round ${round.label}: a discarded candidate left a media row`);
      assert.deepEqual(
        managedArtifactFiles(root), [],
        `round ${round.label}: a discarded candidate left a managed artifact file on disk`,
      );
      assert.deepEqual(
        downloadScratchFiles(root), [],
        `round ${round.label}: a completed round left partial scratch bytes`,
      );

      // Free the flat destination for the next round -- the app refuses a destination that already
      // exists and has no overwrite/uniquify fallback. Moving the file is pure test housekeeping; it
      // never re-enters the product's own save path.
      const keptDirectory = join(directory, `kept-${round.label.replace(/[^A-Za-z0-9]+/gu, '-')}`);
      mkdirSync(keptDirectory, { recursive: true });
      const keptPath = join(keptDirectory, `${round.height}p.mp4`);
      renameSync(savedPath, keptPath);
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `quality-${round.height}p`,
        source: keptPath,
        description: `Real file saved when the customer requested at most ${round.height}p.`,
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: `03-round-${round.height}p-verified`,
        description: `The requested ${round.label} pill decoded to exactly ${result.decodedHeight}p.`,
        details: {
          requestedLabel: round.label,
          requestedHeight: round.height,
          decodedHeight: result.decodedHeight,
          approximateBitrateKbps: Math.round(bitrateKbps),
        },
      });
    }

    assertRoundsAreDistinct(verified);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-all-rounds-distinct',
      description: 'Every requested quality decoded to a genuinely distinct real height, proving the request reached the download.',
      details: { rounds: verified.map(({ label, decodedHeight }) => ({ label, decodedHeight })) },
    });
  });
});
