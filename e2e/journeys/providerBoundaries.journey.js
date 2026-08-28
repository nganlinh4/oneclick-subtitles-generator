// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's entries this journey is cited
// from (geminiDocumentConsolidateAndSummarize, geminiTranscriptionSuccessAndWindowing,
// providerTranslation, backgroundImageGeneration, backgroundMusicPromptDj). Never launches the
// desktop binary or wdio from this lane; the next lane to run it owns turning this into a passing
// (or honestly failing) real-binary attempt.
//
// GROUND TRUTH READ FROM SOURCE BEFORE WRITING ANY STEP. This journey groups five customer
// capabilities that all sit against the SAME wall: src/platform/nativeGeminiJobLifecycle.js's
// createNativeGeminiJobRunner (used directly by transcription and, through
// src/platform/nativeGeminiText.js, by document processing and translation) resolves a Gemini
// credential BEFORE any native command is invoked. With none configured, `getCredentialId()`
// resolves null, the attempt loop breaks immediately, and it throws the fixed
// `NativeGeminiError('geminiCredentialUnavailable')` whose message is exactly
// "The native Gemini operation could not be completed" -- no job/artifact row is ever written. That
// exact text is asserted through e2e/support/providerRefusalOracle.js so document
// processing/translation/PromptDJ never retype it, and bulkTranslationFileIO.journey.js already
// proves the identical text for BULK translation; this journey's Part C proves the untested
// MAIN-TRACK translation code path (useTranslationState.js:681-701's direct `translateSubtitles`
// call, not the per-file bulk-failure wrapper). geminiCredentialBoundary.journey.js already proves
// this same wall for Gemini transcription end to end with full modal-layout containment checks;
// this journey's Part A does not repeat those, it proves the INCREMENTAL fact that journey does
// not: both transcription methods are offered and the max-duration request-window control is real.
//
// BACKGROUND IMAGE GENERATION HAS NO FRIENDLY MESSAGE FOR THIS FAILURE.
// src/components/background/errorMessages.js's getFriendlyErrorMessage pattern-matches known error
// shapes ("api key not set", HTTP status codes, quota, CORS, ...) and falls back to
// t('backgroundGenerator.error.generic', 'Generation failed') for anything else. The raw
// NativeGeminiError message above matches NONE of those patterns, so the customer-visible toast for
// a missing credential here is the generic "Generation failed" -- bounded and actionable (a toast,
// never inline), but less specific than transcription's "Please set your API key..." copy. This
// journey asserts the REAL text rather than a nicer one it does not produce.
//
// PROMPTDJ'S REFUSAL NEVER REACHES RUST AT ALL. src/components/BackgroundMusicSection.jsx posts
// `{ type: 'pm-dj-native-init', available: getActiveGeminiCredentialId() !== null }` into the
// embedded promptdj-midi app (promptdj-midi/index.tsx) on mount and on every credential-state
// change; with no credential that is `available: false`. promptdj-midi/components/PromptDjMidi.ts's
// `playPause()` checks `this.credentialAvailable` and, when false, dispatches an `error` CustomEvent
// with the fixed text 'Please set your Gemini API key in the main app first.' BEFORE ever
// dispatching the `play` event BackgroundMusicSection.jsx would forward as `pm-dj-native-start` --
// so clicking play/pause without a credential never posts anything to the parent, never calls
// `startLiveMusicSession`, and never invokes a Tauri command. apps/desktop/src-tauri/src/live_music.rs
// has no `diagnostics::record` call at all, so there is no log event to assert against; SQLite
// silence is the only oracle, exactly as the credential-free client-only refusal it is. Reading
// PromptDJ's own state requires walking two same-origin iframes (the outer srcDoc wrapper
// BackgroundMusicSection.jsx renders, then its nested `#promptdj-inner` pointing at
// /promptdj/index.html) via `contentDocument`/`contentWindow` from `browser.execute` -- there is no
// existing harness precedent for this, so it is done explicitly and commented at each step rather
// than through a shared helper that would hide the two-iframe shape.
//
// TRANSCRIPTION WINDOW SPLITTING: WHAT IS AND IS NOT PROVEN HERE.
// src/utils/parallelProcessingUtils.js's splitSegmentForParallelProcessing is a pure function of
// (segment, maxDurationPerRequest) with no credential dependency; it is proven directly, including
// a 204s/60s -> 4-window case matching the real e2e/support/fourWindowAsrFixture.js shape, by the
// colocated src/utils/parallelProcessingUtils.test.js (`npx vitest run`). The customer-visible
// wiring for that math -- src/components/VideoProcessingModalGeminiPanel.js's
// `#max-duration-slider` and its live ".parallel-info" split-count preview -- is proven here, but
// the pinned real-media fixture this journey (like almost every other journey) opens through
// openProjectWithMedia() is only ~19 seconds: even at the tightest 1-minute cap that is ONE request,
// so the customer-visible split preview correctly stays absent and
// src/components/app/handlers/processingHandlers.js's own `processing-ranges` CustomEvent (only
// dispatched when `subSegments.length > 1`) never fires. Observing an ACTUAL N>1 Gemini
// request-window split therefore needs either a Gemini credential or a purpose-built long-form
// fixture through a dedicated scenario (the same shape multiWindowAsrPersistence.mjs already uses
// for local ASR's four-window split, over e2e/support/fourWindowAsrFixture.js's 204-second real
// speech clip) -- not built in this pass; recorded precisely in this journey's inventory entry
// rather than left as a vague gap.

/* global $, browser, describe, document, it */

import assert from 'node:assert/strict';
import process from 'node:process';

import { actuateNativeRange } from '../support/nativeRange.js';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  NATIVE_GEMINI_REFUSAL_MESSAGE, PROVIDER_JOB_KINDS, collectTopDocumentToasts,
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
 * referenceVoiceAndPerCueNarration.journey.js.
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
  assert.equal(toasts.errorToasts[0], expectedMessage, `${label}: refusal toast text changed`);
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
    // Only Vercel-mode disables the old method (TranscriptionMethodSelectionOverlay.js); the
    // e2e-automation desktop binary is never Vercel, so it must be offered too.
    assert.equal(methodAvailability.oldMethod, 'true', 'the old Gemini transcription method is not offered on this non-Vercel build');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-transcription-methods-available',
      description: 'Both Gemini transcription methods (new and old) are offered as selectable customer methods before any credential is required.',
      details: { methodAvailability },
    });
    await newMethod.click();

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
      }));
      return refusalA.errorToasts.some((message) => /API/i.test(message))
        && idle.generateDisabled === false
        && idle.processModalPresent === false;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `the new-method transcription refusal never settled: ${JSON.stringify(refusalA)}`,
    });
    assert.deepEqual(refusalA.inlineErrors, [], 'the transcription refusal rendered inline over the video -- an explicitly watched defect class');
    const afterA = durableState(root);
    assert.deepEqual(jobsOfKind(afterA), jobsOfKind(beforeA), 'missing credential started a provider job during transcription windowing');
    assert.equal(afterA.counts.cues, 0, 'missing credential published subtitle cues');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-transcription-refused',
      description: 'The new Gemini transcription method refuses safely, with the native request-window control already proven responsive, before any provider job or cue.',
      details: { errorToasts: refusalA.errorToasts },
      allowVisibleProblems: {
        errorToasts: refusalA.errorToasts.map((toast) => ({
          text: toast,
          reason: 'The visible missing-credential refusal is the customer state under test, matching geminiCredentialBoundary.',
        })),
      },
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

    // Split Duration is entirely local chunk-count arithmetic (no provider call) -- a genuinely
    // credential-free customer control, proven positively before it is reset for the clean
    // (unsplit) refusal path below. GROUND TRUTH: a NONZERO split duration takes
    // src/services/gemini/consolidationService.js's completeDocumentByChunks path, which CATCHES
    // each chunk's NativeGeminiError internally and resolves a `{status:'refused'|'partial'}`
    // object instead of throwing -- LyricsDisplay.js's handleProcess then only updates the inline
    // `.consolidation-status` line and returns without re-throwing, so DownloadOptionsModal never
    // shows a toast for that path. This journey deliberately keeps Split Duration at its default
    // (0, "No Split") for the toast-based refusal assertions below, which is the one path that
    // throws directly and produces the actionable toast this journey checks.
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

    const runDocumentRefusal = async (stepName, description) => {
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
        toasts, expectedMessage: NATIVE_GEMINI_REFUSAL_MESSAGE, before, after, label: stepName,
      });
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
      toasts: refusalC, expectedMessage: NATIVE_GEMINI_REFUSAL_MESSAGE, before: beforeC, after: afterC, label: 'main-track translation',
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
    // its generic fallback toast (its friendly-error matcher does not recognize this raw
    // message), leaving no generated prompt/image state and both image-generate buttons
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
      toasts: refusalD, expectedMessage: 'Generation failed', before: beforeD, after: afterD, label: 'background prompt generation',
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
      description: 'Background-image prompt generation refuses through its generic fallback toast; no prompt/image is produced and both image-generate buttons remain honestly disabled.',
      details: { errorToasts: refusalD.errorToasts, imageButtonsDisabled },
      focusSelector: '.background-generator-container',
      allowVisibleProblems: {
        errorToasts: [{
          text: refusalD.errorToasts[0],
          reason: 'The visible missing-credential refusal is the customer state under test.',
        }],
      },
    });

    // ================================================================================
    // PART E -- PromptDJ (background live music): its own embedded app is told the credential
    // is unavailable entirely client-side, and its own play/pause control refuses with its own
    // bounded toast without ever reaching a native Tauri command.
    // ================================================================================
    await browser.execute(() => document.querySelector('.music-generator-section')?.scrollIntoView({ block: 'center' }));

    // Two same-origin iframes deep: BackgroundMusicSection.jsx's own srcDoc wrapper, then that
    // wrapper's nested #promptdj-inner pointing at /promptdj/index.html. Both are same-origin, so
    // contentDocument/contentWindow are reachable directly from the top document.
    const promptDjState = () => browser.execute(() => {
      const outer = document.querySelector('iframe[title="promptdj-midi"]');
      const innerDoc = outer?.contentDocument?.getElementById('promptdj-inner')?.contentDocument;
      if (!innerDoc) return null;
      const pdj = innerDoc.querySelector('prompt-dj-midi');
      const toast = innerDoc.querySelector('toast-message');
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
      const innerDoc = outer?.contentDocument?.getElementById('promptdj-inner')?.contentDocument;
      const pdj = innerDoc?.querySelector('prompt-dj-midi');
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
    // The refusal toast lives inside the nested iframe's own document, so the top-document
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
