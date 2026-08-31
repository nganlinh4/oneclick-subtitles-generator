/* global browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-live-music-success';

const liveMusicDiagnostics = (root) => {
  try {
    return readFileSync(join(root, 'logs', 'osg.log'), 'utf8')
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => typeof entry?.event === 'string' && entry.event.startsWith('live-music.'));
  } catch {
    return [];
  }
};

const promptDjState = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const promptDjDocument = outer?.contentDocument;
  const host = promptDjDocument?.querySelector('prompt-dj-midi');
  const toast = promptDjDocument?.querySelector('toast-message');
  return {
    ready: host !== null && host !== undefined,
    credentialAvailable: host?.credentialAvailable ?? null,
    playbackState: host?.playbackState ?? null,
    audioLevel: Number(host?.audioLevel ?? 0),
    toast: toast?.showing === true && typeof toast.message === 'string'
      ? toast.message.replace(/\s+/gu, ' ').trim()
      : '',
  };
});

const clickPromptDjTransport = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const host = outer?.contentDocument?.querySelector('prompt-dj-midi');
  const control = host?.shadowRoot?.querySelector('play-pause-morph [role="button"]');
  if (typeof control?.click !== 'function') return false;
  control.click();
  return true;
});

const activePromptKnob = () => browser.execute(() => {
  const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
  const host = outer?.contentDocument?.querySelector('prompt-dj-midi');
  const controller = [...(host?.shadowRoot?.querySelectorAll('prompt-controller') ?? [])]
    .find((candidate) => Number(candidate.weight) > 0);
  const knob = controller?.shadowRoot?.querySelector('weight-knob');
  const target = knob?.shadowRoot?.querySelector('svg:last-of-type');
  if (!outer || !knob || !target) return null;
  const outerRect = outer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  return {
    promptId: controller.promptId,
    weight: Number(knob.value),
    x: Math.round(outerRect.left + targetRect.left + targetRect.width / 2),
    y: Math.round(outerRect.top + targetRect.top + targetRect.height / 2),
  };
});

const clickActivePromptKnob = async () => {
  const before = await activePromptKnob();
  assert.ok(before, 'PromptDJ has no active weighted prompt control');
  const clicked = await browser.execute((promptId) => {
    const outer = document.querySelector('.music-generator-section iframe[title="promptdj-midi"]');
    const host = outer?.contentDocument?.querySelector('prompt-dj-midi');
    const controller = [...(host?.shadowRoot?.querySelectorAll('prompt-controller') ?? [])]
      .find((candidate) => candidate.promptId === promptId);
    const knob = controller?.shadowRoot?.querySelector('weight-knob');
    if (typeof knob?.click !== 'function') return false;
    knob.click();
    return true;
  }, before.promptId);
  assert.equal(clicked, true, `PromptDJ weight ${before.promptId} is not clickable`);
  return before;
};

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

    const initialSession = liveMusicDiagnostics(root).find((entry) => entry.event === 'live-music.started')?.session;
    assert.ok(initialSession, 'the playing surface has no native live-music session receipt');
    const beforeMutation = await clickActivePromptKnob();
    await browser.waitUntil(async () => {
      const after = await activePromptKnob();
      return after?.promptId === beforeMutation.promptId
        && after.weight > beforeMutation.weight
        && liveMusicDiagnostics(root).filter((entry) => (
          entry.event === 'live-music.prompts-sent' && entry.session === initialSession
        )).length >= 2;
    }, { timeout: 30_000, interval: 100, timeoutMsg: 'the real prompt-weight click never reached Gemini' });

    assert.equal(await clickPromptDjTransport(), true, 'the PromptDJ pause control disappeared');
    await browser.waitUntil(async () => (
      (await promptDjState()).playbackState === 'paused'
      && liveMusicDiagnostics(root).some((entry) => (
        entry.event === 'live-music.control'
        && entry.session === initialSession
        && entry.control === 'Pause'
      ))
    ), { timeout: 30_000, interval: 100, timeoutMsg: 'PromptDJ did not pause its native session' });

    assert.equal(await clickPromptDjTransport(), true, 'the PromptDJ resume control disappeared');
    peakLevel = 0;
    await browser.waitUntil(async () => {
      const resumed = await promptDjState();
      peakLevel = Math.max(peakLevel, resumed.audioLevel);
      const diagnostics = liveMusicDiagnostics(root);
      return resumed.playbackState === 'playing'
        && peakLevel > 0.0001
        && diagnostics.filter((entry) => entry.event === 'live-music.started').length === 1
        && diagnostics.some((entry) => (
          entry.event === 'live-music.control'
          && entry.session === initialSession
          && entry.control === 'Play'
        ));
    }, { timeout: 60_000, interval: 100, timeoutMsg: 'PromptDJ did not resume the same native session' });

    await clickControl('.music-generator-section button[title="Reset"]');
    await browser.waitUntil(async () => liveMusicDiagnostics(root).some((entry) => (
      entry.event === 'live-music.control'
      && entry.session === initialSession
      && entry.control === 'ResetContext'
    )), { timeout: 30_000, interval: 100, timeoutMsg: 'PromptDJ reset never reached the native session' });
    assert.equal(
      liveMusicDiagnostics(root).filter((entry) => entry.event === 'live-music.started').length,
      1,
      'PromptDJ controls replaced the live session instead of controlling it',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-prompts-pause-resume-reset',
      description: 'A real knob drag updated Gemini, Pause and Play reused one session, and Reset Context was applied.',
      details: { session: initialSession, promptId: beforeMutation.promptId },
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
      step: '03-live-music-recorded',
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
    assert.equal(signature, '52494646', 'the exported recording is not a finite WAV container');

    assert.equal(await clickPromptDjTransport(), true, 'the real PromptDJ stop control disappeared');
    await browser.waitUntil(async () => ['paused', 'stopped'].includes((await promptDjState()).playbackState), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: 'PromptDJ did not stop after the customer clicked its transport',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-live-music-exported-and-paused',
      description: 'The recording exported as an independently identified WAV file and the live session paused cleanly.',
      details: { bytes: statSync(exported).size, signature },
      focusSelector: '.music-generator-section',
    });
  });
});
