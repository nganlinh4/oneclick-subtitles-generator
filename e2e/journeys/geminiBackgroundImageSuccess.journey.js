/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { collectTopDocumentToasts } from '../support/providerRefusalOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'gemini-background-image-success';
const LYRICS = 'A quiet dawn becomes a bright and hopeful journey across the open sky.';

const expandGenerator = async () => {
  const collapsed = await browser.execute(
    () => document.querySelector('.background-generator-container')?.classList.contains('collapsed') ?? null,
  );
  if (collapsed) await clickControl('.background-generator-container .collapse-button');
  await browser.waitUntil(
    async () => browser.execute(
      () => document.querySelector('.background-generator-container')?.classList.contains('collapsed') === false,
    ),
    { timeout: 30_000, interval: 200, timeoutMsg: 'the background generator did not expand' },
  );
};

const visibleGeneratedImage = () => browser.execute(() => {
  const image = document.querySelector('.background-generator-container .image-grid img');
  return image === null ? null : {
    src: image.getAttribute('src'),
    complete: image.complete,
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
});

describe('a customer generates and restores a project-owned Gemini background image', () => {
  it('uses a real prompt, real reference image and durable native artifact', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the background-image journey requires an isolated root');
    assert.ok(PHASE === 'seed' || PHASE === 'verify', 'run this journey through its scenario');

    if (PHASE === 'verify') {
      await openEditor();
      await expandGenerator();
      let image = null;
      await browser.waitUntil(async () => {
        image = await visibleGeneratedImage();
        return image?.complete === true && image.width > 0 && image.height > 0;
      }, {
        timeout: 180_000,
        interval: 500,
        timeoutMsg: 'the second desktop process did not restore the generated image',
      });
      const generated = durableState(root).artifacts.filter(
        ({ kind, state }) => kind.startsWith('generatedBackgroundImage:') && state === 'ready',
      );
      assert.equal(generated.length, 1, 'relaunch did not retain exactly one ready generated image');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-generated-image-restored',
        description: 'A second desktop process reopened the same project-owned generated image from its durable native artifact.',
        details: { width: image.width, height: image.height, artifactCount: generated.length },
        focusSelector: '.background-generator-container',
      });
      return;
    }

    assert.ok(process.env.OSG_E2E_MEDIA_SELECTION_SEQUENCE, 'seed needs video then reference-image selections');
    await openProjectWithMedia();
    await importSubtitles();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20);
    await expandGenerator();

    const lyrics = await $('.lyrics-input-container textarea');
    await lyrics.waitForDisplayed({ timeout: 30_000 });
    await lyrics.setValue(LYRICS);
    await clickControl('.prompt-header .generate-button');
    let prompt = '';
    await browser.waitUntil(async () => {
      prompt = await browser.execute(() => document.querySelector('.prompt-container textarea')?.value?.trim() ?? '');
      const loading = await browser.execute(
        () => document.querySelector('.prompt-header .generate-button')?.classList.contains('loading') ?? true,
      );
      return prompt.length >= 20 && !loading;
    }, { timeout: 10 * 60 * 1_000, interval: 1_000, timeoutMsg: 'Gemini returned no usable background prompt' });

    await clickControl('.album-art-preview .floating-upload-button');
    await browser.waitUntil(async () => browser.execute(() => {
      const image = document.querySelector('.album-art-preview img');
      return image?.complete === true && image.naturalWidth > 0;
    }), { timeout: 60_000, interval: 250, timeoutMsg: 'the staged reference image did not load' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-prompt-and-reference-ready',
      description: 'Live Gemini produced a visible prompt and the customer-selected reference image loaded through the native capability boundary.',
      details: { promptCharacters: prompt.length, enrolledCredentialCount: enrollment.enrolled },
      focusSelector: '.background-generator-container',
    });

    const before = durableState(root);
    await clickControl('.image-header-actions .generate-button:not(.new-prompt-button)');
    let image = null;
    let terminalFailure = null;
    await browser.waitUntil(async () => {
      image = await visibleGeneratedImage();
      const toasts = await browser.execute(collectTopDocumentToasts);
      const failure = await browser.execute(() => ({
        failedTiles: [...document.querySelectorAll('.image-grid .preview-placeholder')]
          .filter((node) => /fail|error/i.test(node.textContent || ''))
          .map((node) => (node.innerText || node.textContent || '').replace(/\s+/gu, ' ').trim()),
        loading: document.querySelector('.image-header-actions .generate-button:not(.new-prompt-button)')
          ?.classList.contains('loading') ?? null,
      }));
      if ((toasts.errorMessages.length > 0 || failure.failedTiles.length > 0)
          && failure.loading === false) {
        terminalFailure = { ...failure, errorMessages: toasts.errorMessages };
        return true;
      }
      return image?.complete === true && image.width > 0 && image.height > 0;
    }, { timeout: 15 * 60 * 1_000, interval: 1_000, timeoutMsg: 'Gemini returned no visible generated image' });
    if (terminalFailure !== null) {
      throw new Error(`background image generation refused before publishing pixels: ${JSON.stringify(terminalFailure)}`);
    }

    const toasts = await browser.execute(collectTopDocumentToasts);
    assert.deepEqual(toasts.errorToasts, [], 'image generation completed with an error toast');
    assert.deepEqual(toasts.inlineErrors, [], 'image generation painted an inline error');
    const after = durableState(root);
    const generated = after.artifacts.filter(
      ({ kind, state }) => kind.startsWith('generatedBackgroundImage:') && state === 'ready',
    );
    assert.equal(generated.length, 1, 'the visible generated image has no unique ready native artifact');
    const newJobs = after.jobs.slice(before.jobs.length);
    assert.ok(newJobs.some(({ kind, state }) => kind === 'generateImage' && state === 'succeeded'),
      'the visible image has no succeeded native generation job');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-generated-image-durable',
      description: 'Gemini generated a visible image backed by exactly one ready project-owned native artifact and a succeeded native job.',
      details: { width: image.width, height: image.height, artifactBytes: generated[0].size_bytes },
      focusSelector: '.background-generator-container',
    });
  });
});
