/* global $, browser, describe, document, it */
import { strict as assert } from 'node:assert';
import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { importSubtitles } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

describe('customer SRT-only translation diagnostic', () => {
  it('captures whether translating without media reproduces the reported project refusal', async () => {
    await openEditor();
    await importSubtitles();
    await enrollGeminiCredentials({ limit: 1 });
    assert.equal(await browser.execute(() => document.querySelectorAll('video').length), 0);
    await clickControl('.add-chain-item-btn:not(.delimiter):not(.original)');
    await (await $('.language-chain .chain-item:last-child input')).setValue('Vietnamese');
    await (await $('.translation-section')).scrollIntoView({ block: 'start' });
    await captureWorkflowStep({ workflow: 'srt-only-translation-diagnostic', step: '01-imported-srt', description: 'Three imported cues, no media; ready to translate to Vietnamese.' });
    await clickControl('.translate-button');
    await browser.waitUntil(async () => browser.execute(() =>
      document.body.innerText.includes('No exact subtitle project is active for translation')
      || document.querySelector('.translation-preview-stats') !== null
    ), { timeout: 90000, interval: 100 });
    const reproduced = await browser.execute(() => document.body.innerText.includes('No exact subtitle project is active for translation'));
    await captureWorkflowStep({ workflow: 'srt-only-translation-diagnostic', step: '02-after-translate', description: 'Actual result after clicking Translate, not a success claim.', details: { customerErrorReproduced: reproduced } });
    assert.equal(reproduced, true, 'the exact customer refusal was not reproduced');
  });
});
