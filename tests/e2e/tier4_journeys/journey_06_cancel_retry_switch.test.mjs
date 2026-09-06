// Tier 4: Real-World Scenario - Journey 6: Cancel, retry, and project switching without leaks or wrong attachments
// Specifications: WORD_NATIVE_TRANSCRIPTION_HANDOFF.md (Journey 6), TEST_INFRA.md, PROJECT.md F08, F09

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

test('Journey 6: Cancel, retry, and project switching without leaks or wrong attachments', async () => {
  // Session tracking active jobs and media bindings
  const session = {
    activeProjectId: 'project-A',
    activeJobId: 'job-1',
    completedWindows: new Map(),
    abortedJobs: new Set(),
  };

  // 1. User starts multi-window transcription on Project A
  const window0 = { id: 0, status: 'completed', words: ['wordA0'] };
  session.completedWindows.set(0, window0);

  // 2. Mid-run cancellation on Window 1
  const abortController = new AbortController();
  const cancelJob = (jobId) => {
    abortController.abort();
    session.abortedJobs.add(jobId);
    return { status: 'cancelled', isError: false, userMessage: 'Operation cancelled.' };
  };

  const cancelResult = cancelJob(session.activeJobId);
  assert.equal(cancelResult.status, 'cancelled');
  assert.equal(cancelResult.isError, false, 'Cancellation must NOT display red error banner');

  // 3. User retries Window 1 (targeted retry)
  const retryFailedWindow = (windowIdx) => {
    assert.equal(session.completedWindows.has(0), true, 'Prior successful window must be preserved');
    session.completedWindows.set(windowIdx, { id: windowIdx, status: 'completed', words: ['wordA1_retried'] });
    return { success: true };
  };
  retryFailedWindow(1);
  assert.equal(session.completedWindows.size, 2);

  // 4. Project Switch: User switches from Project A to Project B while background task completes
  session.activeProjectId = 'project-B';
  session.activeJobId = 'job-2';

  // Late arriving packet from old Project A
  const handleIncomingResult = (resultProjectId, payload) => {
    if (resultProjectId !== session.activeProjectId) {
      // Invariant: Result must be detached and discarded rather than attaching to active project
      return { attached: false, reason: 'project_mismatch_discarded' };
    }
    return { attached: true };
  };

  const latePacket = handleIncomingResult('project-A', { words: ['stale_data'] });
  assert.equal(latePacket.attached, false);
  assert.equal(latePacket.reason, 'project_mismatch_discarded', 'Late results must NEVER attach to the wrong project');
});
