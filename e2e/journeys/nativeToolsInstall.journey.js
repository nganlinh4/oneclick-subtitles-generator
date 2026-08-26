/* global browser, describe, it, document, window */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import { verifyNativeToolsInstall } from '../support/nativeToolsOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const TOOL_IDS = Object.freeze(['media-tools', 'yt-dlp', 'deno']);
const PHASE = process.env.OSG_E2E_NATIVE_TOOLS_PHASE;
const TIMEOUT_MS = 45 * 60 * 1_000;
const WORKFLOW = 'native-tools-install';

const readRows = () => browser.execute((ids) => ids.map((id) => {
  const row = document.querySelector(`[data-native-tool-id="${id}"]`);
  const states = ['unavailable', 'missing', 'installed', 'corrupt', 'installing', 'removing'];
  return {
    id,
    state: states.find((candidate) => row?.classList.contains(`engine-card--${candidate}`)) ?? null,
    actions: row === null ? [] : [...row.querySelectorAll('[data-tool-action]')]
      .map((button) => button.getAttribute('data-tool-action')).sort(),
    errors: row === null ? [] : [...row.querySelectorAll('.engine-card__error')]
      .map((node) => node.textContent?.trim() ?? ''),
  };
}), TOOL_IDS);

const waitForRows = async (expected) => {
  let last = null;
  try {
    await browser.waitUntil(async () => {
      last = await readRows();
      return TOOL_IDS.every((id) => {
        const accepted = Array.isArray(expected[id]) ? expected[id] : [expected[id]];
        return accepted.includes(last.find((row) => row.id === id)?.state);
      })
        && last.every((row) => row.errors.length === 0);
    }, {
      timeout: TIMEOUT_MS,
      interval: 1_000,
      timeoutMsg: 'native tools did not reach the requested states before their timeout',
    });
  } catch (error) {
    last = await readRows();
    throw new Error(
      `native tools did not reach ${JSON.stringify(expected)}; last=${JSON.stringify(last)}`,
      { cause: error },
    );
  }
  return last;
};

const nativeStatus = () => browser.execute(
  () => window.__TAURI_INTERNALS__?.invoke('native_tools_status'),
);

const assertInstalledStatus = (status) => {
  assert.equal(status?.schemaVersion, 1);
  assert.deepEqual(status.tools.map(({ id }) => id).sort(), [...TOOL_IDS].sort());
  const versions = {};
  for (const tool of status.tools) {
    assert.equal(tool.state, 'installed', `${tool.id} is not installed`);
    assert.equal(tool.installed, true, `${tool.id} is not owned by an installed receipt`);
    assert.equal(tool.activeRuntime, true, `${tool.id} is not active without restart`);
    assert.equal(tool.pendingRemoval, false);
    assert.equal(tool.restartRequired, false);
    assert.equal(tool.version, tool.availableVersion);
    assert.ok(tool.installedBytes > 0);
    versions[tool.id] = tool.version;
  }
  return versions;
};

const openTools = async () => {
  await openEditor();
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="tools"]');
  await browser.waitUntil(async () => browser.execute(
    () => document.querySelector('[data-settings-panel="tools"].active') !== null,
  ), { timeout: 30_000, interval: 250, timeoutMsg: 'the Tools settings panel never activated' });
};

const clickInstall = (id) => clickControl(
  `[data-native-tool-id="${id}"] [data-tool-action="install"]`,
);

describe('a clean machine installs and repairs every native tool', () => {
  it('uses the real Tools UI and leaves only catalog-owned verified bytes', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'native-tool journey requires an isolated root');
    assert.ok(PHASE === 'install' || PHASE === 'repair', 'run through nativeToolsInstall.mjs');
    await openTools();

    if (PHASE === 'install') {
      const missing = await waitForRows(Object.fromEntries(TOOL_IDS.map((id) => [id, 'missing'])));
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-clean-machine',
        description: 'A clean profile truthfully presents all required runtime tools as missing and installable.',
        details: { rows: missing },
      });
      for (const id of TOOL_IDS) await clickInstall(id);
    } else {
      // Reconciliation may expose the invalid receipt as `corrupt`, or atomically quarantine it
      // before the first UI status and therefore expose `missing`. Both are fail-closed; installed
      // is the one forbidden answer after the external same-size mutation.
      const refused = await waitForRows({
        'media-tools': 'installed', 'yt-dlp': ['corrupt', 'missing'], deno: 'installed',
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-tamper-refused',
        description: 'A same-size yt-dlp mutation is visibly refused as corrupt or missing, never trusted.',
        details: { rows: refused },
      });
      await clickInstall('yt-dlp');
    }

    const installedRows = await waitForRows(
      Object.fromEntries(TOOL_IDS.map((id) => [id, 'installed'])),
    );
    const proof = verifyNativeToolsInstall(root, assertInstalledStatus(await nativeStatus()));
    const name = PHASE === 'install' ? 'native-tools-installed.json' : 'native-tools-repaired.json';
    writeFileSync(join(root, 'evidence', name), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: PHASE === 'install' ? '02-tools-installed' : '04-tool-repaired',
      description: PHASE === 'install'
        ? 'All three catalog-owned runtime tools are visibly installed and active.'
        : 'Repair returns the tampered runtime to an installed, active, independently verified state.',
      details: { rows: installedRows },
    });
  });
});
