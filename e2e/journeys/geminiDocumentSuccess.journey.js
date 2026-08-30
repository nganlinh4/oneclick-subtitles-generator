/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { collectTopDocumentToasts } from '../support/providerRefusalOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'gemini-document-success';

const clickTabLabelled = async (containerSelector, label) => {
  const result = await browser.execute((container, text) => {
    const marker = 'data-e2e-document-tab';
    document.querySelector(`[${marker}]`)?.removeAttribute(marker);
    const buttons = [...document.querySelectorAll(`${container} .tab-btn`)];
    const button = buttons.find((node) => (
      (node.querySelector('.tab-label')?.textContent ?? node.textContent ?? '').trim() === text
    ));
    if (button === undefined) return { found: false, labels: buttons.map((node) => node.textContent?.trim()) };
    button.setAttribute(marker, '1');
    return { found: true };
  }, containerSelector, label);
  assert.equal(result.found, true, `no ${containerSelector} tab labelled ${label}: ${JSON.stringify(result)}`);
  await clickControl('[data-e2e-document-tab="1"]');
};

const outputFiles = (root) => {
  const output = join(root, 'output');
  return existsSync(output)
    ? readdirSync(output).filter((name) => name.toLowerCase().endsWith('.txt')).sort()
    : [];
};

const runDocumentOperation = async ({ root, processLabel, expectedSuffix, step, description }) => {
  const before = durableState(root);
  const beforeFiles = outputFiles(root);

  await clickControl('.download-btn-primary');
  const modal = await $('.download-options-modal');
  await modal.waitForDisplayed({ timeout: 30_000 });
  await clickTabLabelled('.download-tabs', 'Process Text');
  if (processLabel !== 'Complete Document (TXT)') {
    await clickTabLabelled('.process-tabs', processLabel);
  }
  await clickControl('.process-button');

  let files = [];
  let toasts = null;
  await browser.waitUntil(async () => {
    files = outputFiles(root).filter((name) => !beforeFiles.includes(name));
    toasts = await browser.execute(collectTopDocumentToasts);
    const open = await browser.execute(() => document.querySelector('.download-options-modal') !== null);
    return files.length === 1 && !open;
  }, {
    timeout: 10 * 60 * 1_000,
    interval: 1_000,
    timeoutMsg: `${processLabel} never produced exactly one staged text document`,
  });

  assert.deepEqual(toasts?.errorToasts ?? [], [], `${processLabel} completed with an error toast`);
  assert.deepEqual(toasts?.inlineErrors ?? [], [], `${processLabel} painted an inline error`);
  assert.match(files[0], expectedSuffix, `${processLabel} used the wrong customer filename`);
  const path = join(root, 'output', files[0]);
  const text = readFileSync(path, 'utf8').trim();
  assert.ok(text.length >= 20, `${processLabel} saved an implausibly short document`);
  assert.ok(!text.includes('{"'), `${processLabel} leaked a structured provider envelope`);

  const after = durableState(root);
  const newJobs = after.jobs.slice(before.jobs.length);
  assert.ok(newJobs.length >= 1, `${processLabel} registered no native provider job`);
  assert.ok(newJobs.every(({ state }) => state === 'succeeded'), `${processLabel} left a non-succeeded provider job`);

  await captureWorkflowStep({
    workflow: WORKFLOW,
    step,
    description,
    details: {
      outputFile: files[0],
      outputBytes: Buffer.byteLength(text),
      providerJobCount: newJobs.length,
    },
    focusSelector: '.translation-section',
  });
  return { text, file: files[0] };
};

describe('a customer completes and summarizes subtitle text through live Gemini', () => {
  it('saves both real provider results through the guarded native destination', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Gemini document journey requires an isolated root');
    await openProjectWithMedia();
    await importSubtitles();
    const enrollment = await enrollGeminiCredentials({ limit: 20 });
    assert.equal(enrollment.enrolled, 20, 'the reviewed credential pool was not enrolled');

    const completed = await runDocumentOperation({
      root,
      processLabel: 'Complete Document (TXT)',
      expectedSuffix: /_completed\.txt$/u,
      step: '01-completed-document-saved',
      description: 'Complete Document ran through live Gemini and saved one non-empty plain-text result through the guarded native destination.',
    });
    const summarized = await runDocumentOperation({
      root,
      processLabel: 'Summarize (TXT)',
      expectedSuffix: /_summary\.txt$/u,
      step: '02-summary-saved',
      description: 'Summarize ran through a distinct live Gemini job and saved one non-empty plain-text result through the guarded native destination.',
    });
    assert.notEqual(summarized.text, completed.text, 'summary and completion returned identical documents');
  });
});
