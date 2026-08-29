import assert from 'node:assert/strict';
import test from 'node:test';

import { runScenarioAttemptWithEvidence } from './twoProcessScenario.js';

const publication = Object.freeze({
  applicationHash: 'a'.repeat(64),
  binaryPath: 'C:\\managed\\osg-desktop.exe',
});

test('a staging copy throw is preserved and finalized before caller-owned root cleanup', () => {
  const events = [];
  const result = runScenarioAttemptWithEvidence({
    label: 'injected scenario',
    spec: './journeys/editPersistRelaunch.journey.js',
    root: 'C:\\managed\\run-root',
    publication,
    operation: () => {
      events.push('copy');
      throw new Error('injected copyFileSync refusal');
    },
  }, {
    resetWorkflowEvidence: () => {
      events.push('begin');
      return 'C:\\evidence\\attempts\\attempt-1';
    },
    preserveRunRootEvidence: ({ runRoot, attemptId }) => {
      events.push(`preserve:${runRoot}:${attemptId}`);
    },
    finalizeWorkflowEvidence: ({ outcome, failure }) => {
      events.push(`finalize:${outcome}:${failure}`);
    },
  });
  assert.equal(result, false);
  assert.deepEqual(events, [
    'begin',
    'copy',
    'preserve:C:\\managed\\run-root:attempt-1',
    'finalize:fail:injected copyFileSync refusal',
  ]);
});

test('a normal two-process refusal still publishes root evidence before finalization', () => {
  const events = [];
  const result = runScenarioAttemptWithEvidence({
    label: 'two-process fixture',
    spec: './journeys/editPersistRelaunch.journey.js',
    root: 'C:\\managed\\run-root',
    publication,
    operation: () => {
      events.push('processes');
      return false;
    },
  }, {
    resetWorkflowEvidence: () => {
      events.push('begin');
      return 'C:\\evidence\\attempts\\attempt-2';
    },
    preserveRunRootEvidence: () => events.push('preserve'),
    finalizeWorkflowEvidence: ({ outcome }) => events.push(`finalize:${outcome}`),
  });
  assert.equal(result, false);
  assert.deepEqual(events, ['begin', 'processes', 'preserve', 'finalize:fail']);
});
