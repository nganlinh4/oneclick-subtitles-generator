/* global $, browser, describe, document, it */
import { strict as assert } from 'node:assert';
import process from 'node:process';
import { durableState, durableTranslations } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

describe('customer SRT-only translation diagnostic', () => {
  it('translates a durable subtitle document without media and restores it after relaunch', async () => {
    await openEditor();
    const root = process.env.OSG_E2E_DATA_ROOT;
    const phase = process.env.OSG_E2E_PERSISTENCE_PHASE;
    if (phase === 'verify') {
      await browser.waitUntil(async () => browser.execute(() =>
        document.body.innerText.includes('First cue for the preview')
        && document.querySelector('.translation-preview-stats') !== null
      ), { timeout: 60000, interval: 250 });
      assert.equal(durableState(root).counts.projects, 1);
      assert.equal(durableState(root).counts.media, 0);
      assert.equal(durableTranslations(root)[0]?.translation?.status, 'complete');
      await (await $('.translation-section')).scrollIntoView({ block: 'start' });
      await captureWorkflowStep({ workflow: 'srt-only-translation-diagnostic', step: '03-relaunched', description: 'New process restores the standalone document and its translated result, without media.' });
      return;
    }
    await importSubtitles();
    await enrollGeminiCredentials({ limit: 1 });
    assert.equal(await browser.execute(() => document.querySelectorAll('video').length), 0);
    await (await $('.language-chain .chain-item input')).setValue('Vietnamese');
    await (await $('.translation-section')).scrollIntoView({ block: 'start' });
    await captureWorkflowStep({ workflow: 'srt-only-translation-diagnostic', step: '01-imported-srt', description: 'Three imported cues, no media; ready to translate to Vietnamese.' });
    await clickControl('.translate-button');
    await browser.waitUntil(async () => (
      durableTranslations(root)[0]?.translation?.status === 'complete'
      || await browser.execute(() => document.body.innerText.includes('No exact subtitle project is active for translation'))
    ), { timeout: 180000, interval: 250 });
    const reproduced = await browser.execute(() => document.body.innerText.includes('No exact subtitle project is active for translation'));
    await captureWorkflowStep({ workflow: 'srt-only-translation-diagnostic', step: '02-after-translate', description: 'Actual result after clicking Translate, not a success claim.', details: { customerErrorReproduced: reproduced } });
    assert.equal(reproduced, false, 'the customer project refusal must be fixed');
    const translation = durableTranslations(root)[0]?.translation;
    assert.equal(translation?.status, 'complete');
    assert.equal(translation.baseSubtitles.length, 3);
    assert.ok(translation.baseSubtitles.every(row => row.text.trim().length > 0));
    assert.notEqual(translation.baseSubtitles[0].text, 'First cue for the preview');
    assert.equal(durableState(root).counts.projects, 1);
    assert.equal(durableState(root).counts.media, 0);
  });
});
