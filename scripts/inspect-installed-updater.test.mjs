import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPersistence,
  assertUpdateStatus,
  parseArguments,
  waitForUpdateOffer,
} from './inspect-installed-updater.mjs';

const projectId = '018f0e4a-7b3c-7def-8abc-0123456789ab';
const baseVersion = '1.0.0-rc.1';
const updatedVersion = '1.0.0-rc.2';
const persistence = {
  setting: JSON.stringify({
    schemaVersion: 1,
    version: baseVersion,
    purpose: 'installed-lifecycle',
    projectId,
  }),
  project: {
    metadata: { id: projectId, name: 'OSG installed lifecycle probe committed' },
    stateVersion: 3,
    media: [],
    tracks: [],
  },
  history: {
    stateVersion: 3,
    canUndo: true,
    canRedo: false,
    undoReason: 'OSG installed lifecycle revision',
    redoReason: null,
  },
};

test('updater inspector accepts only the exact bounded CLI', () => {
  assert.deepEqual(parseArguments([
    '--port', '38444', '--mode', 'trigger', '--base-version', baseVersion,
    '--updated-version', updatedVersion, '--project-id', projectId, '--screenshot', 'before.png',
  ]), {
    port: 38444,
    mode: 'trigger',
    baseVersion,
    updatedVersion,
    projectId,
    screenshot: 'before.png',
  });
  assert.throws(() => parseArguments([
    '--port', '80', '--mode', 'trigger', '--base-version', baseVersion,
    '--updated-version', updatedVersion, '--project-id', projectId, '--screenshot', 'before.png',
  ]), /unprivileged/);
  assert.throws(() => parseArguments([
    '--port', '38444', '--mode', 'other', '--base-version', baseVersion,
    '--updated-version', updatedVersion, '--project-id', projectId, '--screenshot', 'before.png',
  ]), /mode/);
  assert.throws(() => parseArguments([
    '--port', '38444', '--mode', 'trigger', '--base-version', baseVersion,
    '--updated-version', baseVersion, '--project-id', projectId, '--screenshot', 'before.png',
  ]), /versions/);
});

test('updater status requires exact current and offered versions', () => {
  const available = {
    configured: true,
    currentVersion: baseVersion,
    update: {
      version: updatedVersion,
      publishedAt: '2026-08-12T00:00:00.000Z',
      notes: 'Signed fixture',
    },
  };
  assert.equal(assertUpdateStatus(available, {
    currentVersion: baseVersion, updatedVersion, available: true,
  }), available);
  assert.throws(() => assertUpdateStatus({ ...available, extra: true }, {
    currentVersion: baseVersion, updatedVersion, available: true,
  }), /invalid status/);
  assert.throws(() => assertUpdateStatus({
    ...available, update: { ...available.update, version: '9.0.0' },
  }, {
    currentVersion: baseVersion, updatedVersion, available: true,
  }), /reviewed fixture/);
  assert.doesNotThrow(() => assertUpdateStatus({
    configured: true, currentVersion: updatedVersion, update: null,
  }, {
    currentVersion: updatedVersion, updatedVersion, available: false,
  }));
});

test('updater persistence rejects setting, project, and cursor drift', () => {
  assert.equal(assertPersistence(persistence, { baseVersion, projectId }), persistence);
  for (const mutation of [
    { setting: persistence.setting.replace(baseVersion, updatedVersion) },
    { project: { ...persistence.project, stateVersion: 4 } },
    { history: { ...persistence.history, canRedo: true } },
  ]) {
    assert.throws(() => assertPersistence({ ...persistence, ...mutation }, {
      baseVersion, projectId,
    }));
  }
});

test('update offer polling accepts one translated bounded toast and times out closed', async () => {
  let calls = 0;
  const offer = await waitForUpdateOffer(async () => {
    calls += 1;
    return calls === 1
      ? { found: false, candidateCount: 0 }
      : {
        found: true,
        candidateCount: 1,
        buttonText: 'Cài đặt bản cập nhật',
        message: `OSG ${updatedVersion} đã sẵn sàng để cài đặt.`,
      };
  }, updatedVersion, { delay: async () => undefined });
  assert.equal(offer.candidateCount, 1);
  await assert.rejects(() => waitForUpdateOffer(
    async () => ({ found: false, candidateCount: 2 }),
    updatedVersion,
    { timeoutMs: 1, delay: async () => undefined, now: (() => {
      let value = 0;
      return () => value += 1;
    })() },
  ), /last candidate count was 2/);
});
