import { createNativeGeminiImage } from './nativeGeminiImage';

vi.mock('@tauri-apps/api/core', () => ({ Channel: class {} }));

const CREDENTIAL_A = '01890f39-7b62-7c4e-8c9a-000000000301';
const CREDENTIAL_B = '01890f39-7b62-7c4e-8c9a-000000000302';
const REFERENCE_ID = '01890f39-7b62-7c4e-8c9a-000000000303';
const JOB_A = '01890f39-7b62-7c4e-8c9a-000000000304';
const JOB_B = '01890f39-7b62-7c4e-8c9a-000000000305';

const snapshot = (id, state, sequence = 1) => ({
  id,
  kind: 'generateImage',
  state,
  progress: { basisPoints: state === 'succeeded' ? 10_000 : 0 },
  sequence,
});

class FakeChannel {
  onmessage = null;
}

const createHarness = ({ invokeImplementation, credentials = [CREDENTIAL_A] } = {}) => {
  let activeIndex = 0;
  const importImage = vi.fn().mockResolvedValue({
    assetId: REFERENCE_ID,
    mimeType: 'image/png',
    sizeBytes: 16,
  });
  const releaseImage = vi.fn().mockResolvedValue(true);
  const rotateCredential = vi.fn(async () => {
    activeIndex += 1;
  });
  const invokeCommand = vi.fn(invokeImplementation ?? (async (_command, args) => {
    queueMicrotask(() => {
      args.onImage.onmessage(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      args.onEvent.onmessage({
        event: 'completed',
        job: snapshot(JOB_A, 'succeeded', 2),
        mimeType: 'image/png',
        sizeBytes: 4,
      });
    });
    return snapshot(JOB_A, 'running');
  }));
  const cancel = vi.fn().mockResolvedValue(snapshot(JOB_A, 'cancelled', 2));
  const service = createNativeGeminiImage({
    prepareCredentials: vi.fn().mockResolvedValue(undefined),
    getCredentialId: vi.fn(() => credentials[activeIndex] ?? null),
    getCredentialSnapshot: vi.fn(() => ({
      gemini: { availableCredentialIds: credentials },
    })),
    rotateCredential,
    importImage,
    releaseImage,
    invokeCommand,
    ChannelConstructor: FakeChannel,
    cancel,
    isNativeRuntime: () => true,
  });
  return {
    service,
    importImage,
    releaseImage,
    rotateCredential,
    invokeCommand,
    cancel,
  };
};

test('keeps the credential opaque and receives generated image bytes on a raw channel', async () => {
  const harness = createHarness();
  const referenceBlob = new Blob(['reference'], { type: 'image/png' });

  await expect(harness.service.generate({
    referenceBlob,
    prompt: 'Expand this cover into a landscape image',
  })).resolves.toMatchObject({
    mimeType: 'image/png',
    job: snapshot(JOB_A, 'succeeded', 2),
  });
  const result = await harness.service.generate({
    referenceBlob,
    prompt: 'Generate a second image',
  });
  expect([...result.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(harness.invokeCommand).toHaveBeenCalledWith('gemini_image_start', {
    request: {
      credentialId: CREDENTIAL_A,
      model: 'gemini-3.1-flash-image',
      prompt: expect.any(String),
      referenceAssetId: REFERENCE_ID,
    },
    onEvent: expect.any(FakeChannel),
    onImage: expect.any(FakeChannel),
  });
  expect(harness.releaseImage).toHaveBeenCalledWith(REFERENCE_ID);
});

test('rotates credentials only after a sanitized credential failure', async () => {
  let call = 0;
  const harness = createHarness({
    credentials: [CREDENTIAL_A, CREDENTIAL_B],
    invokeImplementation: async (_command, args) => {
      call += 1;
      const id = call === 1 ? JOB_A : JOB_B;
      queueMicrotask(() => {
        if (call === 1) {
          args.onEvent.onmessage({
            event: 'failed',
            job: snapshot(id, 'failed', 2),
            error: { code: 'geminiRateLimited', message: 'fixed host message' },
          });
        } else {
          args.onImage.onmessage(new Uint8Array([1, 2, 3]));
          args.onEvent.onmessage({
            event: 'completed',
            job: snapshot(id, 'succeeded', 2),
            mimeType: 'image/jpeg',
            sizeBytes: 3,
          });
        }
      });
      return snapshot(id, 'running');
    },
  });

  await expect(harness.service.generate({
    referenceBlob: new Blob(['reference'], { type: 'image/png' }),
    prompt: 'Generate',
  })).resolves.toMatchObject({ mimeType: 'image/jpeg' });
  expect(harness.rotateCredential).toHaveBeenCalledWith({
    cooldownCredentialId: CREDENTIAL_A,
  });
  expect(harness.invokeCommand.mock.calls[1][1].request.credentialId).toBe(CREDENTIAL_B);
});

test('protocol corruption cancels the durable job and always releases the reference', async () => {
  const harness = createHarness({
    invokeImplementation: async (_command, args) => {
      queueMicrotask(() => args.onImage.onmessage('not binary'));
      return snapshot(JOB_A, 'running');
    },
  });

  await expect(harness.service.generate({
    referenceBlob: new Blob(['reference'], { type: 'image/png' }),
    prompt: 'Generate',
  })).rejects.toMatchObject({ code: 'invalidGeminiImageResponse' });
  expect(harness.cancel).toHaveBeenCalledWith(JOB_A);
  expect(harness.releaseImage).toHaveBeenCalledWith(REFERENCE_ID);
});

test('a pre-aborted request performs no import or native invocation', async () => {
  const harness = createHarness();
  const controller = new AbortController();
  controller.abort();

  await expect(harness.service.generate({
    referenceBlob: new Blob(['reference'], { type: 'image/png' }),
    prompt: 'Generate',
    signal: controller.signal,
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(harness.importImage).not.toHaveBeenCalled();
  expect(harness.invokeCommand).not.toHaveBeenCalled();
});
