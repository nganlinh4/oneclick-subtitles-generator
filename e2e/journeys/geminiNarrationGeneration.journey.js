// A billed live-provider proof for Gemini narration. Credentials enter only through the public
// Settings surface; evidence contains counts and timing, never credential IDs, keys, or cue text.
/* global browser, describe, it */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import { runProviderNarrationGeneration } from '../support/providerNarrationJourney.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const CONCURRENCY = 3;
const WORKFLOW = 'gemini-narration-generation';

const diagnostics = (root) => readFileSync(join(root, 'logs', 'osg.log'), 'utf8')
  .split(/\r?\n/u)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

describe('a customer generates narration with Gemini TTS', () => {
  it('auto-prepares the engine and really synthesizes cues across the requested key pool', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');
    await openProjectWithMedia();
    await importSubtitles();
    await browser.waitUntil(() => durableState(root).cues.length === CONCURRENCY, {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: 'the imported cue plan never became durable before Gemini narration',
    });
    const enrollment = await enrollGeminiCredentials({ limit: CONCURRENCY });
    assert.equal(enrollment.enrolled, CONCURRENCY, 'the requested Gemini key pool was not enrolled');

    await runProviderNarrationGeneration({
      root,
      method: 'gemini',
      workflow: WORKFLOW,
      providerLabel: 'Gemini TTS',
      expectedFormat: 'wav',
      timeoutMs: 900_000,
      prepare: async () => {
        const range = await actuateNativeRange({
          driver: browser,
          selector: '#gemini-concurrent-clients',
          value: CONCURRENCY,
          label: 'Gemini narration concurrency',
        });
        assert.equal(range.value, CONCURRENCY);
        await captureWorkflowStep({
          workflow: WORKFLOW,
          step: '01-provider-configured',
          description: 'Three customer-enrolled Gemini keys and concurrency 3 are selected.',
          details: { enrolledCredentials: enrollment.enrolled, requestedConcurrency: CONCURRENCY },
          focusSelector: '.narration-section',
        });
      },
      afterGeneration: async ({ generation }) => {
        const observed = diagnostics(root).filter(({ event, job }) => (
          event === 'speech.concurrency_observed' && job === generation.job.id
        ));
        assert.equal(observed.length, 1, 'Gemini narration has no single concurrency receipt');
        const [receipt] = observed;
        assert.deepEqual({
          backend: receipt.backend,
          configured: Number(receipt.configured),
          workers: Number(receipt.workers),
          observedPeak: Number(receipt.observedPeak),
        }, {
          backend: 'GeminiTts',
          configured: CONCURRENCY,
          workers: CONCURRENCY,
          observedPeak: CONCURRENCY,
        }, 'Gemini narration did not honor the visible concurrency and key-pool controls');
        return { concurrencyReceipt: {
          configured: Number(receipt.configured),
          workers: Number(receipt.workers),
          observedPeak: Number(receipt.observedPeak),
        } };
      },
    });
  });
});
