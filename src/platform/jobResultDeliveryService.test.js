import { v7 as uuidv7 } from 'uuid';

import {
  acknowledgeJobResult,
  claimJobResult,
  listPendingJobResults,
  normalizeClaimedJobResult,
} from './jobResultDeliveryService';

const succeededJob = (id, kind = 'transcribe') => ({
  id,
  kind,
  state: 'succeeded',
  progress: { basisPoints: 10_000 },
  sequence: 2,
});

const claimed = ({ jobId = uuidv7(), deliveryId = uuidv7(), kind = 'asrTranscription' } = {}) => ({
  job: succeededJob(jobId),
  delivery: {
    deliveryId,
    jobId,
    kind,
    projectId: null,
    assetId: uuidv7(),
    payload: { schemaVersion: 1, timelineOffsetMs: 0, transcription: {} },
    createdAtMs: 123,
  },
});

test('discovers bounded identities and claims an exact succeeded-job payload without acknowledging it', async () => {
  const raw = claimed();
  const invokeCommand = vi.fn(async (command, args) => {
    if (command === 'job_result_pending') {
      expect(args).toEqual({ kind: null, afterDeliveryId: null });
      return [{
        deliveryId: raw.delivery.deliveryId,
        jobId: raw.delivery.jobId,
        kind: raw.delivery.kind,
      }];
    }
    expect(command).toBe('job_result_claim');
    expect(args).toEqual({ jobId: raw.job.id });
    return raw;
  });

  await expect(listPendingJobResults({ invokeCommand })).resolves.toHaveLength(1);
  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'job_result_pending', {
    kind: null,
    afterDeliveryId: null,
  });
  await expect(claimJobResult(raw.job.id, { invokeCommand })).resolves.toEqual(
    normalizeClaimedJobResult(raw),
  );
  expect(invokeCommand).not.toHaveBeenCalledWith('job_result_ack', expect.anything());
});

test('requests an exact native delivery kind and rejects a cross-kind response', async () => {
  const raw = claimed();
  const invokeCommand = vi.fn().mockResolvedValue([{
    deliveryId: raw.delivery.deliveryId,
    jobId: raw.delivery.jobId,
    kind: 'asrTranscription',
  }]);

  await expect(listPendingJobResults({ invokeCommand, kind: 'geminiText' }))
    .rejects.toMatchObject({ code: 'invalidJobResult' });
  expect(invokeCommand).toHaveBeenCalledExactlyOnceWith('job_result_pending', {
    kind: 'geminiText',
    afterDeliveryId: null,
  });
});

test('requires the exact job and delivery identities before treating acknowledgement as complete', async () => {
  const jobId = uuidv7();
  const deliveryId = uuidv7();
  const accepted = vi.fn().mockResolvedValue(true);
  await expect(acknowledgeJobResult(jobId, deliveryId, { invokeCommand: accepted }))
    .resolves.toBeUndefined();
  expect(accepted).toHaveBeenCalledWith('job_result_ack', { jobId, deliveryId });

  const rejected = vi.fn().mockResolvedValue(false);
  await expect(acknowledgeJobResult(jobId, deliveryId, { invokeCommand: rejected }))
    .rejects.toMatchObject({ code: 'invalidJobResult' });
});

test('rejects mismatched, nonterminal, or malformed claimed deliveries', () => {
  const raw = claimed();
  expect(() => normalizeClaimedJobResult({
    ...raw,
    delivery: { ...raw.delivery, jobId: uuidv7() },
  })).toThrow();
  expect(() => normalizeClaimedJobResult({
    ...raw,
    job: { ...raw.job, state: 'running', progress: { basisPoints: 0 }, sequence: 1 },
  })).toThrow();
  expect(() => normalizeClaimedJobResult({
    ...raw,
    delivery: { ...raw.delivery, privatePath: 'C:\\private\\result.json' },
  })).toThrow();
});
