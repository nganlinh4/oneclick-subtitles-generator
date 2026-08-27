/* global $, browser, describe, it, document, getComputedStyle */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-credential-boundary';

describe('Gemini generation refuses safely without a credential', () => {
  it('returns to idle without starting a provider job or publishing cues', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'Gemini boundary journey requires an isolated root');
    await openProjectWithMedia();
    const before = durableState(root);

    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the Gemini range selector never became available',
    });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);

    const method = await $('[data-transcription-method="new"]');
    await method.waitForClickable({ timeout: 60_000 });
    assert.equal(await method.getAttribute('data-method-available'), 'true');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-method-selection',
      description: 'Gemini generation is presented as a selectable customer method before submission.',
    });
    await method.click();

    const modalLayout = await browser.execute(() => {
      const modal = document.querySelector('.video-processing-modal');
      const footer = modal?.querySelector('.modal-footer');
      const button = footer?.querySelector('[data-osg-action="process-subtitles"]');
      const token = footer?.querySelector('.footer-token-info');
      const box = (node) => {
        if (node === null || node === undefined) return null;
        const rect = node.getBoundingClientRect();
        return {
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height,
        };
      };
      return {
        modal: box(modal),
        footer: box(footer),
        button: box(button),
        token: box(token),
        footerDisplay: footer === null ? null : getComputedStyle(footer).display,
      };
    });
    const isInside = (child, parent) => child !== null && parent !== null
      && child.left >= parent.left - 1
      && child.top >= parent.top - 1
      && child.right <= parent.right + 1
      && child.bottom <= parent.bottom + 1;
    assert.equal(modalLayout.footerDisplay, 'flex', `processing footer lost its layout: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.footer, modalLayout.modal), `processing footer escaped its modal: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.button, modalLayout.footer), `process button escaped its footer: ${JSON.stringify(modalLayout)}`);
    assert.ok(isInside(modalLayout.token, modalLayout.footer), `token summary escaped its footer: ${JSON.stringify(modalLayout)}`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-processing-options',
      description: 'The full-range Gemini options and their footer remain contained and aligned before submission.',
      details: { modalLayout },
      focusSelector: '.video-processing-modal',
    });
    await clickControl('[data-osg-action="process-subtitles"]');

    let surface = null;
    try {
      await browser.waitUntil(async () => {
        surface = await browser.execute(() => ({
          errorToasts: [...document.querySelectorAll('.toast-error')]
            .map((node) => (node.innerText || '').trim()).filter(Boolean),
          forceStopPresent: document.querySelector('.force-stop-btn') !== null,
          generateDisabled: document.querySelector('[data-osg-action="generate-subtitles"]')
            ?.disabled ?? null,
          processModalPresent: document.querySelector('.processing-modal-overlay') !== null,
        }));
        return surface.errorToasts.some((message) => /API/i.test(message))
          && surface.forceStopPresent === false
          && surface.generateDisabled === false;
      }, {
        timeout: 30_000,
        interval: 250,
        timeoutMsg: 'missing-credential refusal did not settle',
      });
    } catch (error) {
      throw new Error(
        `missing-credential refusal did not settle: ${JSON.stringify(surface)}`,
        { cause: error },
      );
    }

    // The UI is the stimulus and the visible refusal is one oracle. SQLite and the native log are
    // independent oracles that distinguish a genuine pre-provider refusal from a request that was
    // started and merely failed quickly.
    const after = durableState(root);
    const providerKinds = new Set(['transcribe', 'translate', 'analyzeSubtitles']);
    assert.deepEqual(
      after.jobs.filter(({ kind }) => providerKinds.has(kind)),
      before.jobs.filter(({ kind }) => providerKinds.has(kind)),
      'missing Gemini credential started a provider-owned durable job',
    );
    assert.equal(after.counts.cues, 0, 'missing Gemini credential published subtitle cues');
    const log = readFileSync(join(root, 'logs', 'osg.log'), 'utf8');
    assert.doesNotMatch(log, /"event":"gemini\.(?:started|progress|completed|failed|cancelled)"/);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-actionable-refusal',
      description: 'A missing credential produces a visible refusal and returns controls to idle without side effects.',
      details: { errorToasts: surface.errorToasts },
      allowVisibleProblems: {
        errorToasts: surface.errorToasts.map((toast) => ({
          text: toast,
          reason: 'The visible missing-credential refusal is the customer state under test.',
        })),
      },
    });
  });
});
