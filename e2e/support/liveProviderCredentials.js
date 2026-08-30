import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl } from './editor.js';
import { REPOSITORY_ROOT } from './environment.js';

const GEMINI_PREFIX = 'GEMINI_API_KEY';
const MAX_GEMINI_KEYS = 20;

const unquote = (value) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const parseDotEnv = (contents) => Object.fromEntries(
  contents
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u))
    .filter(Boolean)
    .map((match) => [match[1], unquote(match[2])]),
);

const slotName = (index) => (index === 1 ? GEMINI_PREFIX : `${GEMINI_PREFIX}_${index}`);

/**
 * Read the ignored live-test pool into this WDIO worker only. Values are never returned in errors,
 * copied into evidence, inherited by the desktop process, or read by shipping application code.
 */
export const readGeminiCredentialPool = ({
  environment = process.env,
  envPath = join(REPOSITORY_ROOT, '.env'),
} = {}) => {
  const fileValues = parseDotEnv(readFileSync(envPath, 'utf8'));
  const credentials = [];
  for (let index = 1; index <= MAX_GEMINI_KEYS; index += 1) {
    const name = slotName(index);
    const value = unquote(environment[name] ?? fileValues[name] ?? '');
    if (value !== '') credentials.push({ name, value });
  }
  if (credentials.length === 0) {
    throw new Error('no Gemini live-test credential slots are configured');
  }
  return credentials;
};

/** Enrol live credentials through the same write-only Settings controls a customer uses. */
export const enrollGeminiCredentials = async ({ limit = 1 } = {}) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_GEMINI_KEYS) {
    throw new Error('Gemini credential enrollment limit is outside the reviewed bound');
  }
  const selected = readGeminiCredentialPool().slice(0, limit);
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="api-keys"]');
  const input = await globalThis.$('#new-gemini-key-input');
  await input.waitForDisplayed({ timeout: 15_000 });

  for (let index = 0; index < selected.length; index += 1) {
    // WebDriver owns this write-only interaction. The application clears the field before IPC and
    // the harness captures no screenshot or diagnostic while the secret is present in the DOM.
    await input.setValue(selected[index].value);
    await clickControl('.add-key-button');
    await globalThis.browser.waitUntil(async () => globalThis.browser.execute(
      (expected) => document.querySelectorAll('.gemini-key-item').length === expected
        && document.querySelector('#new-gemini-key-input')?.value === '',
      index + 1,
    ), {
      timeout: 30_000,
      interval: 200,
      timeoutMsg: `Gemini credential slot ${index + 1} was not enrolled through Settings`,
    });
  }

  await clickControl('[data-settings-action="close"]');
  await globalThis.$('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
  return { enrolled: selected.length };
};

