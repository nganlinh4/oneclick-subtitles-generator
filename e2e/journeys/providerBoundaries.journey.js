// Every Gemini-gated generator refuses safely without a credential, and its credential-free half
// still works: transcription (both methods, the request-window control, the processing footer),
// document processing, main-track translation, background image and PromptDJ.
//
// The wall: src/platform/nativeGeminiJobLifecycle.js resolves a credential BEFORE any native
// command, so with none it throws `geminiCredentialUnavailable` and no job, artifact or Gemini log
// event is ever written. The exact text is asserted through support/providerRefusalOracle.js.
// - Split document processing (consolidationService.completeDocumentByChunks) resolves a `refused`
//   chunk result instead, so LyricsDisplay shows "No usable output was returned".
// - Background image maps the code to `backgroundGenerator.error.apiKeyMissing`.
// - PromptDJ never reaches Rust: with `available: false` its playPause() dispatches an `error` event
//   before `play`, so SQLite silence is the only oracle. Its state is read by walking the two
//   same-origin iframes BackgroundMusicSection.jsx renders.
// The 19 s fixture is one request even at a 1-minute cap, so the split preview stays absent here;
// N>1 window splitting is proven by src/utils/parallelProcessingUtils.test.js and the four-window
// scenarios.

/* global $, browser, describe, document, getComputedStyle, it */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { actuateNativeRange } from '../support/nativeRange.js';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  GEMINI_CREDENTIAL_REQUIRED_MESSAGE, PROVIDER_JOB_KINDS, collectTopDocumentToasts,
} from '../support/providerRefusalOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'provider-boundaries';
const TARGET_LANGUAGE = 'Spanish';
const LYRICS_PROBE = 'Provider boundary probe lyrics, credential-free line one.';
const PROMPTDJ_MESSAGE = 'Please set your Gemini API key in the main app first.';

const jobsOfKind = (state) => state.jobs.filter(({ kind }) => PROVIDER_JOB_KINDS.includes(kind));

const waitUntilWithDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

/**
 * Click a Download & Process modal tab by its visible label instead of DOM position.
 *
 * `.download-tabs .tab-btn:last-child` timed out on a real run (never appeared) even though the
 * modal itself was open: src/components/DownloadOptionsModal.js's two `.process-tabs` buttons each
 * carry an `info-icon-container` alongside the label, so a whole-button textContent match (or a
 * position guess that silently drifts if a tab is ever reordered) is the wrong contract either way.
 * Tagging the exact `.tab-label` (falling back to the button's own text for `.download-tabs`, which
 * has no icon) is the same explicit-marker pattern clickResultControlButton uses in
 * steps/referenceVoiceAndPerCueNarration/resultRows.js.
 */
const clickTabLabelled = async (containerSelector, label) => {
  const tagged = await browser.execute((container, text) => {
    const marker = 'data-e2e-tab-target';
    for (const stale of document.querySelectorAll(`[${marker}]`)) stale.removeAttribute(marker);
    const buttons = [...document.querySelectorAll(`${container} .tab-btn`)];
    const button = buttons.find((node) => (
      (node.querySelector('.tab-label')?.textContent ?? node.textContent ?? '').trim() === text
    ));
    if (button === undefined) {
      return {
        found: false,
        buttonLabels: buttons.map((node) => (
          (node.querySelector('.tab-label')?.textContent ?? node.textContent ?? '').trim()
        )),
      };
    }
    button.setAttribute(marker, '1');
    return { found: true };
  }, containerSelector, label);
  assert.equal(tagged.found, true, `${containerSelector} has no tab labelled "${label}": ${JSON.stringify(tagged)}`);
  await clickControl('[data-e2e-tab-target="1"]');
  await browser.execute(() => {
    document.querySelector('[data-e2e-tab-target]')?.removeAttribute('data-e2e-tab-target');
  });
};

/** Read the exact same one-typed-refusal shape every credential-free Gemini boundary in this suite proves. */
const assertCleanTextRefusal = async ({ toasts, expectedMessage, before, after, label }) => {
  assert.equal(toasts.errorToasts.length, 1, `${label}: expected exactly one refusal toast, saw ${JSON.stringify(toasts.errorToasts)}`);
  assert.deepEqual(toasts.errorMessages, [expectedMessage], `${label}: refusal toast message changed`);
  assert.deepEqual(toasts.inlineErrors, [], `${label}: the refusal rendered inline -- an explicitly watched defect class`);
  assert.deepEqual(jobsOfKind(after), jobsOfKind(before), `${label}: a missing credential registered a native provider job`);
};

describe('Gemini-gated generators refuse safely without a credential, and their credential-free halves work', () => {
  it('proves transcription windowing, document processing, main-track translation, background image and PromptDJ boundaries', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the provider boundaries journey requires an isolated root');
    await openProjectWithMedia();

    // ================================================================================
    // PART A -- Gemini transcription: both methods reachable, the native request-window
    // control responds, and the "new" method refuses cleanly before any provider job.
    // ================================================================================
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({ timeout: 60_000, timeoutMsg: 'the Gemini range selector never became available' });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);

    const newMethod = await $('[data-transcription-method="new"]');
    await newMethod.waitForClickable({ timeout: 60_000 });
    const methodAvailability = await browser.execute(() => ({
      newMethod: document.querySelector('[data-transcription-method="new"]')?.getAttribute('data-method-available') ?? null,
      oldMethod: document.querySelector('[data-transcription-method="old"]')?.getAttribute('data-method-available') ?? null,
    }));
    assert.equal(methodAvailability.newMethod, 'true', 'the new Gemini transcription method is not offered');
    assert.equal(methodAvailability.oldMethod, 'true', 'the old Gemini transcription method is not offered');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-transcription-methods-available',
      description: 'Both Gemini transcription methods (new and old) are offered as selectable customer methods before any credential is required.',
      details: { methodAvailability },
    });
    await newMethod.click();

    const modalLayout = await browser.execute(() => {
      const modal = document.querySelector('.video-processing-modal');
      const footer = modal?.querySelector('.modal-footer');
      const box = (node) => {
        if (node === null || node === undefined) return null;
        const { left, top, right, bottom } = node.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      return {
        modal: box(modal),
        footer: box(footer),
        button: box(footer?.querySelector('[data-osg-action="process-subtitles"]')),
        token: box(footer?.querySelector('.footer-token-info')),
        footerDisplay: footer === null || footer === undefined ? null : getComputedStyle(footer).display,
      };
    });
    const isInside = (child, parent) => child !== null && parent !== null
      && child.left >= parent.left - 1 && child.top >= parent.top - 1
      && child.right <= parent.right + 1 && child.bottom <= parent.bottom + 1;
    assert.equal(modalLayout.footerDisplay, 'flex', `processing footer lost its layout: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.footer, modalLayout.modal), `processing footer escaped its modal: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.button, modalLayout.footer), `process button escaped its footer: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.token, modalLayout.footer), `token summary escaped its footer: ${JSON.stringify(modalLayout)}`);

    const durationSlider = '#max-duration-slider';
    const actuated = await actuateNativeRange({
      driver: browser, selector: durationSlider, value: 1, label: 'max-duration-slider (tightest cap)',
    });
    assert.equal(actuated.value, 1, 'the native max-duration-per-request slider did not commit the requested value');
    const windowPreview = await browser.execute(() => ({
      parallelInfoPresent: document.querySelector('.parallel-info') !== null,
      sliderValue: document.querySelector('#max-duration-slider')?.value ?? null,
    }));
    assert.equal(windowPreview.sliderValue, '1', 'the max-duration slider value did not reach the DOM');
    // The pinned real-media fixture openProjectWithMedia() opens is ~19 seconds -- even at this
    // tightest 1-minute cap that is a single request, so the split preview correctly stays absent.
    // See this file's header comment for where N>1 splitting IS proven credential-free.
    assert.equal(windowPreview.parallelInfoPresent, false, 'a single-request clip incorrectly offered a parallel-split preview');
    await actuateNativeRange({
      driver: browser, selector: durationSlider, value: 10, label: 'max-duration-slider (reset to default)',
    });

    const beforeA = durableState(root);
    await clickControl('[data-osg-action="process-subtitles"]');
    let refusalA = null;
    await waitUntilWithDiagnostic(async () => {
      refusalA = await browser.execute(collectTopDocumentToasts);
      const idle = await browser.execute(() => ({
        generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')?.disabled ?? null,
        processModalPresent: document.querySelector('.processing-modal-overlay') !== null,
        forceStopPresent: document.querySelector('.force-stop-btn') !== null,
      }));
      return refusalA.errorMessages.some((message) => /API/i.test(message))
        && idle.generateDisabled === false
        && idle.processModalPresent === false
        && idle.forceStopPresent === false;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `the new-method transcription refusal never settled: ${JSON.stringify(refusalA)}`,
    });
    assert.deepEqual(refusalA.inlineErrors, [], 'the transcription refusal rendered inline over the video -- an explicitly watched defect class');
    const afterA = durableState(root);
    assert.deepEqual(jobsOfKind(afterA), jobsOfKind(beforeA), 'missing credential started a provider job during transcription windowing');
    assert.equal(afterA.counts.cues, 0, 'missing credential published subtitle cues');
    // SQLite and the native log distinguish a genuine pre-provider refusal from a request that was
    // started and merely failed quickly.
    assert.doesNotMatch(
      readFileSync(join(root, 'logs', 'osg.log'), 'utf8'),
      /"event":"gemini\.(?:started|progress|completed|failed|cancelled)"/u,
      'missing credential still started a Gemini provider request',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-transcription-refused',
      description: 'The new Gemini transcription method refuses safely from a contained processing footer, with the request-window control responsive, before any provider job, cue or Gemini request.',
      details: { errorToasts: refusalA.errorToasts },
      allowVisibleProblems: {
        errorToasts: refusalA.errorToasts.map((toast) => ({
          text: toast,
          reason: 'The visible missing-credential refusal is the customer state under test.',
        })),
      },
    });

    // The transcription refusal toast (step 02, documented above) auto-dismisses on its own timer
    // (showErrorToast's default 8000ms plus ToastPanel's 500ms dismiss animation). Part B's own
    // workflow-evidence capture (step 03) is about an unrelated, credential-free control, so it must
    // not still be racing this earlier toast off screen -- wait it out rather than widening step
    // 03's allowance (idiom: manualLyricsAndGeniusBoundary.journey.js's identical wait between its
    // own Genius refusal and the next, unrelated capture).
    await waitUntilWithDiagnostic(async () => (await browser.execute(collectTopDocumentToasts)).errorToasts.length === 0, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => 'the transcription refusal toast from Part A never auto-dismissed before Part B',
    });

    // Real subtitles are needed for Parts B (document processing) and C (translation).
    await importSubtitles();

    // ================================================================================
    // PART B -- Gemini document consolidate/summarize: the credential-free split-duration
    // control works, then both process types refuse cleanly through the exact same toast.
    // ================================================================================
    await clickControl('.download-btn-primary');
    const downloadModal = await $('.download-options-modal');
    await downloadModal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the Download Center modal never opened' });
    await clickTabLabelled('.download-tabs', 'Process Text'); // consolidate active by default

    // Exercise both rejection and incomplete-result paths. Both must retire
    // processing notifications and leave one error toast without saving output.
    const splitSlider = '#consolidation-split-duration-slider';
    await actuateNativeRange({ driver: browser, selector: splitSlider, value: 5, label: 'consolidation-split-duration-slider' });
    const splitLabel = await browser.execute(() => document.querySelector('.split-duration-slider-container .slider-value-display')?.textContent ?? null);
    assert.match(splitLabel ?? '', /5/u, 'the split-duration slider label did not reflect the committed native value');
    await actuateNativeRange({ driver: browser, selector: splitSlider, value: 0, label: 'consolidation-split-duration-slider (reset to No Split)' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-document-split-duration-control',
      description: 'The Split Duration control is real, native and credential-free; it is reset to No Split before the refusal check below.',
      details: { splitLabel },
      focusSelector: '.download-options-modal',
    });

    const runDocumentRefusal = async (stepName, description, expectedMessage = GEMINI_CREDENTIAL_REQUIRED_MESSAGE) => {
      const before = durableState(root);
      const beforeArtifacts = before.counts.artifacts;
      await clickControl('.process-button');
      let toasts = null;
      await waitUntilWithDiagnostic(async () => {
        toasts = await browser.execute(collectTopDocumentToasts);
        const idle = await browser.execute(() => document.querySelector('.process-button')?.disabled ?? null);
        return toasts.errorToasts.length > 0 && idle === false;
      }, {
        timeout: 30_000,
        interval: 250,
        diagnostic: () => `${stepName}: the document-processing refusal never settled: ${JSON.stringify(toasts)}`,
      });
      const after = durableState(root);
      await assertCleanTextRefusal({
        toasts, expectedMessage, before, after, label: stepName,
      });
      await browser.waitUntil(() => browser.execute(() =>
        document.querySelectorAll('.toast-item.live .toast.toast-info').length === 0),
      { timeout: 5000, timeoutMsg: 'document failure left its processing toast alive' });
      const footer = await browser.execute(() => {
        const root = document.querySelector('.download-options-modal').getBoundingClientRect();
        return [...document.querySelectorAll('.download-options-modal > .modal-footer button')].map(button => {
          const rect = button.getBoundingClientRect();
          return { top: rect.top, bottomGap: root.bottom - rect.bottom, rightGap: root.right - rect.right };
        });
      });
      assert.ok(footer.every(button => button.bottomGap >= 12 && button.rightGap >= 12), 'footer actions touch the modal edge');
      assert.ok(Math.abs(footer[0].top - footer[1].top) <= 2, 'desktop footer actions are unexpectedly stacked');
      assert.equal(after.counts.artifacts, beforeArtifacts, `${stepName}: a missing credential produced a durable document artifact`);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: stepName,
        description,
        details: { errorToasts: toasts.errorToasts },
        allowVisibleProblems: {
          errorToasts: [{
            text: toasts.errorToasts[0],
            reason: 'The visible missing-credential refusal is the customer state under test.',
          }],
        },
      });
      await waitUntilWithDiagnostic(async () => (await browser.execute(collectTopDocumentToasts)).errorToasts.length === 0, {
        timeout: 15_000,
        interval: 250,
        diagnostic: () => `${stepName}: the refusal toast never auto-dismissed`,
      });
    };

    await runDocumentRefusal(
      '04-document-consolidate-refused',
      'Complete Document processing refuses through one bounded, actionable toast, with no durable artifact and no provider job.',
    );
    await actuateNativeRange({ driver: browser, selector: splitSlider, value: 5, label: 'split document refusal' });
    await runDocumentRefusal('04b-split-document-refused',
      'A split request reports one incomplete-result error and retires progress without saving an artifact.',
      'Error processing document: No usable output was returned. Retry the document.');
    await actuateNativeRange({ driver: browser, selector: splitSlider, value: 0, label: 'restore unsplit document control' });
    await clickTabLabelled('.process-tabs', 'Summarize (TXT)');
    await runDocumentRefusal(
      '05-document-summarize-refused',
      'Summarize processing refuses through the same bounded toast text as Complete Document, with no durable artifact and no provider job.',
    );
    await clickControl('.cancel-button');
    await downloadModal.waitForExist({ reverse: true, timeout: 30_000 });

    // ================================================================================
    // PART C -- Provider translation, MAIN track (not bulk): bulkTranslationFileIO.journey.js
    // already proves this exact wall for the bulk-only code path; this proves the separate
    // main-track path (useTranslationState.js's direct, unwrapped translateSubtitles call).
    // ================================================================================
    await clickControl('.add-chain-item-btn:not(.delimiter):not(.original)');
    const newLanguageInput = await $('.language-chain .chain-item:last-child input');
    await newLanguageInput.waitForDisplayed({ timeout: 15_000 });
    await newLanguageInput.setValue(TARGET_LANGUAGE);

    const beforeC = durableState(root);
    await clickControl('.translate-button');
    let refusalC = null;
    await waitUntilWithDiagnostic(async () => {
      refusalC = await browser.execute(collectTopDocumentToasts);
      const stillProcessing = await browser.execute(() => document.querySelector('.translate-button.processing') !== null);
      return !stillProcessing && refusalC.errorToasts.length > 0;
    }, {
      timeout: 60_000,
      interval: 500,
      diagnostic: () => `the credential-free MAIN-track translation refusal never settled: ${JSON.stringify(refusalC)}`,
    });
    const afterC = durableState(root);
    await assertCleanTextRefusal({
      toasts: refusalC, expectedMessage: GEMINI_CREDENTIAL_REQUIRED_MESSAGE, before: beforeC, after: afterC, label: 'main-track translation',
    });
    assert.deepEqual(afterC.cues, beforeC.cues, 'a missing credential altered the main durable cue track');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-main-track-translation-refused',
      description: 'A real target language on the MAIN subtitle track (not the bulk pool) refuses through the same bounded toast, leaving the durable cue track and jobs table untouched.',
      details: { errorToasts: refusalC.errorToasts },
      allowVisibleProblems: {
        errorToasts: [{
          text: refusalC.errorToasts[0],
          reason: 'The visible missing-credential refusal is the customer state under test, the same as bulkTranslationFileIO for the bulk path.',
        }],
      },
    });
    await waitUntilWithDiagnostic(async () => (await browser.execute(collectTopDocumentToasts)).errorToasts.length === 0, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => 'the main-track translation refusal toast never auto-dismissed',
    });
    await clickControl('.language-chain .chain-item:last-child .remove-btn');

    // ================================================================================
    // PART D -- Gemini background image generation: the lyrics-to-prompt call refuses through
    // its missing-credential toast, leaving no generated prompt/image state and both image-generate buttons
    // honestly disabled because they still require a prompt this refusal never produced.
    // ================================================================================
    await clickControl('.background-generator-container .collapse-button');
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('.background-generator-container')?.classList.contains('collapsed') === false),
      { timeout: 15_000, interval: 200, timeoutMsg: 'the Background Image Generator never expanded' },
    );
    const lyricsTextarea = await $('.lyrics-input-container textarea');
    await lyricsTextarea.waitForDisplayed({ timeout: 15_000 });
    await lyricsTextarea.setValue(LYRICS_PROBE);

    const beforeD = durableState(root);
    await clickControl('.prompt-header .generate-button');
    let refusalD = null;
    await waitUntilWithDiagnostic(async () => {
      refusalD = await browser.execute(collectTopDocumentToasts);
      const idle = await browser.execute(() => document.querySelector('.prompt-header .generate-button')?.classList.contains('loading') ?? null);
      return refusalD.errorToasts.length > 0 && idle === false;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `the background-prompt refusal never settled: ${JSON.stringify(refusalD)}`,
    });
    const afterD = durableState(root);
    await assertCleanTextRefusal({
      toasts: refusalD, expectedMessage: 'Gemini API key not set. Please set it in settings.', before: beforeD, after: afterD, label: 'background prompt generation',
    });
    assert.equal(afterD.counts.artifacts, beforeD.counts.artifacts, 'a missing credential produced a durable generated-image artifact');
    const generatedPromptValue = await browser.execute(() => document.querySelector('.prompt-container textarea')?.value ?? null);
    assert.equal(generatedPromptValue, '', 'a refused prompt generation left text in the Generated Prompt field');
    const imageButtonsDisabled = await browser.execute(() => ({
      samePrompt: document.querySelector('.image-header-actions .generate-button:not(.new-prompt-button)')?.disabled ?? null,
      uniquePrompts: document.querySelector('.image-header-actions .new-prompt-button')?.disabled ?? null,
    }));
    assert.equal(imageButtonsDisabled.samePrompt, true, 'Generate with Same Prompt stayed enabled with no generated prompt');
    assert.equal(imageButtonsDisabled.uniquePrompts, true, 'Generate with Unique Prompts stayed enabled with no lyrics-derived prompt yet generated');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-background-image-prompt-refused',
      description: 'Background-image prompt generation names the missing credential; no prompt/image is produced and both image-generate buttons remain disabled.',
      details: { errorToasts: refusalD.errorToasts, imageButtonsDisabled },
      focusSelector: '.background-generator-container',
      allowVisibleProblems: {
        errorToasts: [{
          text: refusalD.errorToasts[0],
          reason: 'The visible missing-credential refusal is the customer state under test.',
        }],
      },
    });
    // Part E's own captures (steps 08/09) assert no top-document toast state at all, so this
    // refusal toast (default 8000ms + 500ms dismiss animation) must retire first rather than
    // leaking into step 08's screenshot -- the same leftover-toast race step 03 above was fixed
    // against, not a new claim about Part D.
    await waitUntilWithDiagnostic(async () => (await browser.execute(collectTopDocumentToasts)).errorToasts.length === 0, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => 'the background-image refusal toast from Part D never auto-dismissed before Part E',
    });

    // ================================================================================
    // PART E -- PromptDJ (background live music): its own embedded app is told the credential
    // is unavailable entirely client-side, and its own play/pause control refuses with its own
    // bounded toast without ever reaching a native Tauri command.
    // ================================================================================
    await browser.execute(() => document.querySelector('.music-generator-section')?.scrollIntoView({ block: 'center' }));

    // The direct PromptDJ iframe is same-origin, so its application state remains inspectable
    // without an inert srcDoc wrapper or a second browsing context.
    const promptDjState = () => browser.execute(() => {
      const outer = document.querySelector('iframe[title="promptdj-midi"]');
      const promptDjDocument = outer?.contentDocument;
      if (!promptDjDocument) return null;
      const pdj = promptDjDocument.querySelector('prompt-dj-midi');
      const toast = promptDjDocument.querySelector('toast-message');
      return {
        credentialAvailable: pdj ? pdj.credentialAvailable : null,
        toastShowing: toast ? toast.showing : null,
        toastMessage: toast ? toast.message : null,
      };
    });

    let djState = null;
    await waitUntilWithDiagnostic(async () => {
      djState = await promptDjState();
      return djState !== null && djState.credentialAvailable === false;
    }, {
      timeout: 30_000,
      interval: 500,
      diagnostic: () => `PromptDJ never reported the missing-credential state to its embedded app: ${JSON.stringify(djState)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-promptdj-unavailable',
      description: 'PromptDJ is told, through its own real native-availability bridge, that no Gemini credential is available -- entirely client-side, before any customer click.',
      details: { credentialAvailable: djState.credentialAvailable },
      focusSelector: '.music-generator-section',
    });

    const beforeE = durableState(root);
    const clicked = await browser.execute(() => {
      const outer = document.querySelector('iframe[title="promptdj-midi"]');
      const pdj = outer?.contentDocument?.querySelector('prompt-dj-midi');
      // play-pause-morph renders its own React button directly into its light DOM (no shadow root
      // of its own); prompt-dj-midi itself IS a shadow-DOM Lit element, so the button is reached
      // through its shadowRoot.
      const button = pdj?.shadowRoot?.querySelector('play-pause-morph [role="button"]');
      if (!button) return false;
      button.click();
      return true;
    });
    assert.equal(clicked, true, 'the PromptDJ play/pause control could not be found in its own embedded document');

    let djRefusal = null;
    await waitUntilWithDiagnostic(async () => {
      djRefusal = await promptDjState();
      return djRefusal?.toastShowing === true;
    }, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => `PromptDJ never showed its own missing-credential toast: ${JSON.stringify(djRefusal)}`,
    });
    assert.equal(djRefusal.toastMessage, PROMPTDJ_MESSAGE, "PromptDJ's own missing-credential toast text changed");
    const afterE = durableState(root);
    assert.deepEqual(afterE.jobs, beforeE.jobs, 'clicking PromptDJ play/pause without a credential registered a native job -- it must never leave the WebView');
    // The refusal toast lives inside the PromptDJ iframe's own document, so the top-document
    // screenshot guard (workflowEvidence.js's collectVisibleStateFromPage) never sees it and needs
    // no allowVisibleProblems entry here.
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '09-promptdj-refused',
      description: "PromptDJ's real play/pause control refuses entirely inside its own embedded app, with its own bounded toast, and never reaches a native Tauri command.",
      details: { toastMessage: djRefusal.toastMessage },
      focusSelector: '.music-generator-section',
    });
  });
});
