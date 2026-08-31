/* global browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-live-music-success';

const promptDjState = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const inner = outer?.contentDocument?.getElementById('promptdj-inner');
  const innerDocument = inner?.contentDocument;
  const host = innerDocument?.querySelector('prompt-dj-midi');
  const toast = innerDocument?.querySelector('toast-message');
  return {
    ready: host !== null && host !== undefined,
    credentialAvailable: host?.credentialAvailable ?? null,
    playbackState: host?.playbackState ?? null,
    audioLevel: Number(host?.audioLevel ?? 0),
    toast: (toast?.shadowRoot?.textContent ?? '').replace(/\s+/gu, ' ').trim(),
  };
});

const clickPromptDjTransport = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const inner = outer?.contentDocument?.getElementById('promptdj-inner');
  const host = inner?.contentDocument?.querySelector('prompt-dj-midi');
  const control = host?.shadowRoot?.querySelector('play-pause-morph [role="button"]');
  if (typeof control?.click !== 'function') return false;
  control.click();
  return true;
});

describe('a customer generates, records and exports live Gemini music', () => {
  it('drives PromptDJ through its real nested WebViews and receives real PCM', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the live-music journey requires an isolated root');
    await openEditor();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20);

    const collapsed = await browser.execute(
      () => document.querySelector('.music-generator-section')?.classList.contains('collapsed') ?? null,
    );
    if (collapsed) await clickControl('.music-generator-section .collapse-button');
    await browser.waitUntil(async () => (await promptDjState()).ready, {
      timeout: 60_000,
      interval: 250,
      timeoutMsg: 'the nested PromptDJ application did not become reachable',
    });
    await browser.waitUntil(async () => (await promptDjState()).credentialAvailable === true, {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'the enrolled Gemini credential did not reach PromptDJ',
    });
    assert.equal(await clickPromptDjTransport(), true, 'the real PromptDJ play control is unavailable');

    let live = null;
    let peakLevel = 0;
    await browser.waitUntil(async () => {
      live = await promptDjState();
      peakLevel = Math.max(peakLevel, live.audioLevel);
      if (live.toast) throw new Error(`PromptDJ refused live generation: ${live.toast}`);
      return live.playbackState === 'playing' && peakLevel > 0.0001;
    }, {
      timeout: 5 * 60_000,
      interval: 250,
      timeoutMsg: 'Gemini live music produced no playable PCM',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-live-music-playing',
      description: 'The real PromptDJ transport reached playing state and received non-silent native Gemini PCM.',
      details: { enrolledCredentialCount: enrollment.enrolled, peakLevel },
      focusSelector: '.music-generator-section',
    });

    await clickControl('.music-generator-section .header-controls .pill-button.primary');
    await browser.waitUntil(async () => browser.execute(() => (
      document.querySelector('.music-generator-section .header-controls .pill-button.error') !== null
    )), { timeout: 30_000, interval: 100, timeoutMsg: 'PromptDJ recording did not start' });
    await browser.pause(5_000);
    await clickControl('.music-generator-section .header-controls .pill-button.error');
    await browser.waitUntil(async () => browser.execute(() => {
      const audio = document.querySelector('.music-generator-section .audio-preview audio');
      return typeof audio?.src === 'string' && audio.src.startsWith('blob:')
        && Number.isFinite(audio.duration) && audio.duration > 0;
    }), { timeout: 60_000, interval: 250, timeoutMsg: 'the recorded live music preview is empty' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-live-music-recorded',
      description: 'The customer Record and Stop controls produced a playable, non-empty audio preview.',
      details: { recordingSeconds: 5 },
      focusSelector: '.music-generator-section',
    });

    await clickControl('.music-generator-section .audio-preview [title="Download audio"]');
    let exported = null;
    await browser.waitUntil(async () => {
      const files = readdirSync(join(root, 'output'));
      if (files.length !== 1) return false;
      exported = join(root, 'output', files[0]);
      return statSync(exported).size > 1_024;
    }, { timeout: 60_000, interval: 250, timeoutMsg: 'the recorded live music was not exported' });
    const signature = readFileSync(exported).subarray(0, 4).toString('hex');
    assert.equal(signature, '1a45dfa3', 'the exported recording is not a WebM container');

    assert.equal(await clickPromptDjTransport(), true, 'the real PromptDJ stop control disappeared');
    await browser.waitUntil(async () => ['paused', 'stopped'].includes((await promptDjState()).playbackState), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'PromptDJ did not stop after the customer clicked its transport',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-live-music-exported-and-stopped',
      description: 'The recording exported as an independently identified WebM file and the live session stopped cleanly.',
      details: { bytes: statSync(exported).size, signature },
      focusSelector: '.music-generator-section',
    });
  });
});
