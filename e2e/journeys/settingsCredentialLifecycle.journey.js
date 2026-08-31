/* global $, browser, describe, document, it, localStorage, process */

import { strict as assert } from 'node:assert';

import { withDatabase } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
import { clickSettingsControl } from '../support/settingsControls.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-credential-lifecycle';
const GENIUS_DRAFT = 'osg-e2e-genius-write-only-draft';
const YOUTUBE_DRAFT = 'osg-e2e-youtube-write-only-draft';
const OAUTH_CLIENT_ID = 'osg-e2e.apps.googleusercontent.com';
const OAUTH_CLIENT_SECRET = 'osg-e2e-oauth-client-write-only-draft';
const SECRET_ALIASES = Object.freeze([
  'gemini_api_key', 'gemini_api_keys', 'gemini_token', 'genius_token',
  'youtube_api_key', 'youtube_client_id', 'youtube_client_secret', 'youtube_oauth_token',
]);

const credentialPurposes = (root) => withDatabase(root, (database) => (
  database.prepare('SELECT purpose FROM credential_refs ORDER BY purpose').all()
    .map(({ purpose }) => purpose)
));

const openApiKeys = async () => {
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="api-keys"]');
  await $('.api-key-section').waitForDisplayed({ timeout: 30_000 });
};

const saveSettings = async () => {
  const save = await $('.save-btn');
  await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: 'Settings never marked the credential edit as saveable',
  });
  await clickControl('.save-btn');
  await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
};

const confirmWarning = async () => {
  const toast = await $('.toast.toast-warning');
  await toast.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'credential removal skipped confirmation' });
  await clickControl('.toast.toast-warning .toast-button');
};

const waitForPurposes = async (root, expected) => {
  await browser.waitUntil(async () => (
    JSON.stringify(credentialPurposes(root)) === JSON.stringify(expected)
  ), {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `credential purposes did not settle to ${JSON.stringify(expected)}`,
  });
};

const browserSecretState = () => browser.execute((aliases) => ({
  aliases: Object.fromEntries(aliases.map((key) => [key, localStorage.getItem(key)])),
  fields: {
    gemini: document.querySelector('#new-gemini-key-input')?.value ?? null,
    genius: document.querySelector('#genius-key-input')?.value ?? null,
    youtube: document.querySelector('#youtube-key-input')?.value ?? null,
    clientId: document.querySelector('#client-id-input')?.value ?? null,
    clientSecret: document.querySelector('#client-secret-input')?.value ?? null,
  },
}), SECRET_ALIASES);

describe('credential settings are write-only, persistent and individually removable', () => {
  it('stores safe references, clears each purpose, and recovers a partial OAuth setup', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');
    await openEditor();
    assert.deepEqual(credentialPurposes(root), []);

    // This is the same real credential pool used by green live-provider journeys. The helper clears
    // the input before IPC and never includes the secret in evidence or desktop environment state.
    await enrollGeminiCredentials({ limit: 1 });
    await waitForPurposes(root, ['geminiApiKey']);

    // Enable the shipping YouTube credential surface through its public setting.
    await clickControl('[data-app-action="open-settings"]');
    await clickControl('[data-settings-tab="video-processing"]');
    await clickSettingsControl('#enable-youtube-search');
    await saveSettings();

    await openApiKeys();
    await $('#genius-key-input').setValue(GENIUS_DRAFT);
    await $('#youtube-key-input').setValue(YOUTUBE_DRAFT);
    await saveSettings();
    await waitForPurposes(root, ['geminiApiKey', 'geniusAccessToken', 'youtubeApiKey']);

    await openApiKeys();
    const redacted = await browserSecretState();
    assert.deepEqual(Object.values(redacted.aliases), SECRET_ALIASES.map(() => null));
    assert.equal(redacted.fields.gemini, '');
    assert.equal(redacted.fields.genius, '');
    assert.equal(redacted.fields.youtube, '');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-safe-references-persisted',
      description: 'Gemini, Genius and YouTube show configured status while every browser secret field and legacy alias is empty.',
      details: { purposes: credentialPurposes(root), redacted },
      focusSelector: '[data-credential-action="clear-genius"]',
    });

    await clickSettingsControl('[data-credential-action="clear-genius"]');
    await confirmWarning();
    await waitForPurposes(root, ['geminiApiKey', 'youtubeApiKey']);

    await clickSettingsControl('[data-credential-action="clear-youtube-api-key"]');
    await confirmWarning();
    await waitForPurposes(root, ['geminiApiKey']);

    await clickSettingsControl('.gemini-key-item .remove-key');
    await waitForPurposes(root, []);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-individual-credentials-cleared',
      description: 'Each stored provider credential is removed through its own public control without factory reset.',
      details: { purposes: credentialPurposes(root) },
      focusSelector: '.no-keys-message',
    });

    // A failed OAuth attempt can leave a client reference without a token. Save that exact shape,
    // reopen Settings (proving durability), then clear it while the UI is still unauthenticated.
    await clickControl('.auth-toggle-btn:nth-child(2)');
    await $('#client-id-input').setValue(OAUTH_CLIENT_ID);
    await $('#client-secret-input').setValue(OAUTH_CLIENT_SECRET);
    await saveSettings();
    await waitForPurposes(root, ['youtubeOauthClient']);

    await openApiKeys();
    const oauthRedacted = await browserSecretState();
    assert.equal(oauthRedacted.fields.clientId, '');
    assert.equal(oauthRedacted.fields.clientSecret, '');
    await clickSettingsControl('[data-credential-action="clear-youtube-oauth"]');
    await confirmWarning();
    await waitForPurposes(root, []);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-partial-oauth-cleared',
      description: 'An unauthenticated but persisted OAuth client can be cleared without a successful login or factory reset.',
      details: { purposes: credentialPurposes(root), oauthRedacted },
      focusSelector: '[data-credential-action="clear-youtube-oauth"]',
    });

    await clickControl('[data-settings-action="close"]');
  });
});
