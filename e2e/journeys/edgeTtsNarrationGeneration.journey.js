// Prove the Edge provider itself with real decoded output. Alignment and export are exercised by
// the provider-independent narration journey and are intentionally not repeated here.
/* global browser, describe, it */

import { strict as assert } from 'node:assert';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { ensureEngineReady } from '../support/engines.js';
import { runProviderNarrationGeneration } from '../support/providerNarrationJourney.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const ENGINE = 'edge-tts';
const WORKFLOW = 'edge-tts-narration-generation';

describe('a customer generates narration with the Edge TTS provider', () => {
  it('installs the provider package and produces decoded, non-silent per-cue audio', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');
    await openProjectWithMedia();
    await importSubtitles();
    await browser.waitUntil(() => durableState(root).cues.length === 3, {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: 'the imported cue plan never became durable before narration generation',
    });
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed Edge TTS package is visibly installed and available on demand.',
        details: { ...state, proofClass: 'network-dependent Edge TTS provider proof' },
      }),
    });
    await runProviderNarrationGeneration({
      root,
      method: ENGINE,
      workflow: WORKFLOW,
      providerLabel: 'Edge TTS',
    });
  });
});
