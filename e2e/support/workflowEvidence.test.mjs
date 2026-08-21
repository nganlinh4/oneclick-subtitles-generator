import { strict as assert } from 'node:assert';
import { existsSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  WORKFLOW_EVIDENCE_ROOT,
  resetWorkflowEvidence,
  workflowEvidenceDirectory,
  workflowNameForJourney,
} from './workflowEvidence.js';

test('derives stable readable workflow folders from journey file names', () => {
  assert.equal(workflowNameForJourney('journeys/nativeExportDecoded.journey.js'), 'native-export-decoded');
  assert.equal(workflowNameForJourney('urlToPreview.journey.js'), 'url-to-preview');
});

test('evidence reset is confined to one validated target workflow directory', () => {
  const workflow = 'contract-test';
  const directory = resetWorkflowEvidence(workflow);
  try {
    const inside = relative(resolve(WORKFLOW_EVIDENCE_ROOT), resolve(directory));
    assert.ok(inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`));
    assert.equal(existsSync(directory), true);
    assert.equal(workflowEvidenceDirectory(workflow), directory);
    assert.throws(() => workflowEvidenceDirectory('../outside'), /bounded slug/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
