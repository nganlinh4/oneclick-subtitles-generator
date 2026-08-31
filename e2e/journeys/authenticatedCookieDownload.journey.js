/* global $, browser, describe, document, fetch, it, process */

import { strict as assert } from 'node:assert';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { confirmDownloadOnly } from '../support/download.js';
import { clickControl, openEditor } from '../support/editor.js';
import { readDownloadFixtureEvents } from '../support/downloadFixtureOrigin.js';
import { probeMedia } from '../support/nativeMediaOracle.js';
import { clickSettingsControl } from '../support/settingsControls.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = process.env.OSG_E2E_WORKFLOW;
const AUTHORITY = WORKFLOW === 'browser-profile-cookie-download'
  ? 'isolated-browser-profile'
  : 'isolated-cookie-file';
assert.ok(
  WORKFLOW === 'authenticated-cookie-download' || WORKFLOW === 'browser-profile-cookie-download',
  'the authenticated download journey received an unknown workflow authority',
);

const switchSelected = (selector) => browser.execute(
  (target) => document.querySelector(target)?.selected ?? null, selector,
);

const enableCookiesThroughSettings = async () => {
  await clickControl('[data-app-action="open-settings"]');
  await $('.settings-modal').waitForDisplayed({ timeout: 30_000 });
  await clickControl('[data-settings-tab="video-processing"]');
  await $('#use-cookies-download').waitForExist({ timeout: 30_000 });
  if (!(await switchSelected('#use-cookies-download'))) {
    await clickSettingsControl('#use-cookies-download');
  }
  assert.equal(await switchSelected('#use-cookies-download'), true, 'the cookie switch did not enable');
  const save = await $('.save-btn');
  await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: 'Settings never made the cookie edit saveable',
  });
  await clickControl('.save-btn');
  await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
};

describe('a customer uses browser-cookie authentication for a protected download', () => {
  it('crosses the real yt-dlp cookie boundary without reading a customer browser profile', async () => {
    const url = process.env.OSG_E2E_MULTI_FORMAT_URL;
    const eventsPath = process.env.OSG_E2E_DOWNLOAD_FIXTURE_EVENTS;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(url && eventsPath && destination, 'the protected fixture authority is incomplete');

    const unauthenticated = await fetch(url);
    assert.equal(unauthenticated.status, 401, 'the protected origin did not require authentication');
    await openEditor();
    await enableCookiesThroughSettings();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-cookie-setting-enabled',
      description: 'The public Settings surface enabled the reviewed browser-cookie source.',
      details: {
        browserSource: 'chrome',
        authority: AUTHORITY,
        unauthenticatedStatus: unauthenticated.status,
      },
    });

    const before = new Set(readdirSync(destination));
    const field = await $('.url-field');
    await field.setValue(url);
    await browser.waitUntil(async () => browser.execute(
      (expected) => document.querySelector('.video-url-value')?.textContent?.trim() === expected,
      url,
    ), { timeout: 30_000, interval: 100, timeoutMsg: 'the protected URL was not selected' });
    await clickControl('.download-only-btn');
    await $('.header-badge.cookie-enabled').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'the download modal did not consume the saved cookie preference',
    });
    await confirmDownloadOnly({
      afterScan: async ({ qualities }) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-protected-formats-scanned',
        description: 'The real yt-dlp scan crossed the protected origin and exposed its formats.',
        details: { qualities },
        focusSelector: '.download-only-modal',
      }),
    });

    let written = [];
    await browser.waitUntil(async () => {
      written = readdirSync(destination).filter((name) => !before.has(name));
      return written.length === 1 && statSync(join(destination, written[0])).size > 50_000;
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: 'the authenticated download did not publish exactly one file',
    });
    const output = join(destination, written[0]);
    const probe = probeMedia(output);
    const video = probe.streams.find(({ codec_type: kind }) => kind === 'video');
    assert.equal(video?.height, 180, 'the authenticated output is not the selected protected format');

    const events = readDownloadFixtureEvents(eventsPath);
    const starts = events.filter(({ event }) => event === 'request-start');
    assert.ok(starts.length > 0, 'the protected origin observed no product request');
    assert.ok(starts.every(({ authenticated }) => authenticated === true),
      'the product reached protected bytes without its cookie authority');
    assert.ok(events.some(({ status, authenticated }) => status === 401 && authenticated === false),
      'the exact origin never proved its unauthenticated refusal');
    assert.deepEqual(
      await browser.execute(() => [...document.querySelectorAll('.toast-error, [role="alert"]')]
        .map((node) => (node.textContent || '').trim()).filter(Boolean)),
      [],
      'the authenticated flow left a visible failure',
    );

    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'authenticated-download',
      source: output,
      description: 'The independently decoded file fetched through the isolated cookie authority.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-protected-file-published',
      description: 'Exactly one protected video was decoded with no live browser-profile access.',
      details: {
        bytes: statSync(output).size,
        width: video.width,
        height: video.height,
        authenticatedRequests: starts.length,
        authority: AUTHORITY,
      },
    });
  });
});
