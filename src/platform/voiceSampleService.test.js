import { describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';
import {
  VoiceSampleServiceError,
  createVoiceSampleService,
  normalizeVoiceSamplePlayback,
  normalizeVoiceSampleProgress,
  normalizeVoiceSampleStatus,
} from './voiceSampleService';

const ID = '87e99e20-dd3f-4f6d-9f2f-998813fd5d1d';
const TOKEN = 'a'.repeat(64);
const playback = () => ({
  id: ID,
  playbackUrl: `http://127.0.0.1:49152/asset/${ID}?token=${TOKEN}`,
  mimeType: 'audio/wav',
  byteLength: 499244,
});
const playbackForId = (id) => ({
  ...playback(),
  id,
  playbackUrl: `http://127.0.0.1:49152/asset/${id}?token=${TOKEN}`,
});
const status = () => ({
  id: 'gemini-voice-samples',
  label: 'Gemini voice previews',
  deliveryAvailable: true,
  installed: false,
  updateAvailable: false,
  state: 'missing',
  version: null,
  availableVersion: '2026.08.11',
  installedBytes: 0,
  downloadBytes: 13520118,
  availableInstalledBytes: 16384680,
});

class TestChannel {
  onmessage = null;
}

describe('voiceSampleService', () => {
  it('accepts only exact path-free playback, status, and progress shapes', () => {
    expect(normalizeVoiceSamplePlayback(playback()).playbackUrl).toContain('/asset/');
    expect(normalizeVoiceSampleStatus(status()).state).toBe('missing');
    expect(normalizeVoiceSampleProgress({
      operationId: uuidv7(),
      phase: 'downloading', bytesDone: 10, totalBytes: 20, basisPoints: 5000,
    }).basisPoints).toBe(5000);
    expect(() => normalizeVoiceSamplePlayback({ ...playback(), path: 'C:\\private.wav' }))
      .toThrow(VoiceSampleServiceError);
    expect(() => normalizeVoiceSamplePlayback({
      ...playback(), playbackUrl: 'https://attacker.invalid/sample.wav',
    })).toThrow(VoiceSampleServiceError);
  });

  it('requires one canonical UUIDv4 media id shared by the response and playback URL', () => {
    const canonicalId = uuidv4();
    expect(normalizeVoiceSamplePlayback(playbackForId(canonicalId)).id).toBe(canonicalId);

    for (const invalidId of [
      '-'.repeat(36),
      uuidv7(),
      canonicalId.toUpperCase(),
    ]) {
      expect(() => normalizeVoiceSamplePlayback(playbackForId(invalidId)))
        .toThrow(VoiceSampleServiceError);
    }

    expect(() => normalizeVoiceSamplePlayback({
      ...playbackForId(canonicalId),
      playbackUrl: playbackForId(uuidv4()).playbackUrl,
    })).toThrow(VoiceSampleServiceError);
  });

  it('resolves through one fixed native command and streams validated progress', async () => {
    const events = [];
    const invokeCommand = vi.fn(async (command, args) => {
      expect(command).toBe('voice_sample_resolve');
      expect(args.voiceId).toBe('achernar');
      args.onEvent.onmessage({
        operationId: args.operationId,
        phase: 'downloading', bytesDone: 6760059, totalBytes: 13520118, basisPoints: 5000,
      });
      return playback();
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });
    const result = await service.resolve('ACHERNAR', { onProgress: (event) => events.push(event) });
    expect(result.mimeType).toBe('audio/wav');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(invokeCommand.mock.calls)).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('isolates throwing presentation callbacks from native protocol handling', async () => {
    const onProtocolError = vi.fn(() => { throw new Error('presentation only'); });
    const invokeCommand = vi.fn(async (_command, args) => {
      args.onEvent.onmessage({
        operationId: args.operationId,
        phase: 'downloading', bytesDone: 10, totalBytes: 20, basisPoints: 5000,
      });
      return playback();
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });

    await expect(service.resolve('achernar', {
      onProgress: () => { throw new Error('render failed'); },
      onProtocolError,
    })).resolves.toEqual(playback());
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  it('cancels malformed progress exactly once before returning a fixed protocol error', async () => {
    const privatePath = 'C:\\Users\\person\\voice-samples.zip';
    const onProtocolError = vi.fn(() => { throw new Error(privatePath); });
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'voice_samples_cancel') {
        throw { code: 'packageStorage', message: privatePath, cause: privatePath };
      }
      args.onEvent.onmessage({
        operationId: args.operationId,
        phase: 'downloading', bytesDone: 21, totalBytes: 20, basisPoints: 5000,
      });
      args.onEvent.onmessage({ privatePath });
      return playback();
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });

    const error = await service.resolve('achernar', { onProtocolError }).catch((failure) => failure);
    expect(error).toMatchObject({
      code: 'invalidVoiceSampleResponse',
      message: 'The desktop voice sample response is invalid.',
    });
    expect(String(error)).not.toContain(privatePath);
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'voice_samples_cancel'))
      .toHaveLength(1);
  });

  it('detaches a settled channel so it cannot cancel a replacement operation', async () => {
    const channels = [];
    let finishReplacement;
    const replacement = new Promise((resolve) => { finishReplacement = resolve; });
    const onProtocolError = vi.fn();
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'voice_sample_resolve') {
        channels.push(args.onEvent);
        return playback();
      }
      if (command === 'voice_samples_install') {
        channels.push(args.onEvent);
        return replacement;
      }
      return true;
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });

    await service.resolve('achernar', { onProtocolError });
    const installing = service.install();
    expect(channels).toHaveLength(2);
    channels[0].onmessage({ privatePath: 'C:\\Users\\person\\stale.zip' });
    channels[0].onmessage({
      operationId: uuidv7(),
      phase: 'downloading', bytesDone: 1, totalBytes: 2, basisPoints: 5000,
    });

    expect(onProtocolError).not.toHaveBeenCalled();
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'voice_samples_cancel'))
      .toHaveLength(0);
    finishReplacement(status());
    await expect(installing).resolves.toEqual(status());
  });

  it('fails closed outside desktop and on hostile voice identifiers', async () => {
    const invokeCommand = vi.fn();
    const browser = createVoiceSampleService({ invokeCommand, nativeRuntime: () => false });
    await expect(browser.status()).rejects.toMatchObject({ code: 'voiceSampleUnavailable' });
    const desktop = createVoiceSampleService({ invokeCommand, nativeRuntime: () => true });
    expect(() => desktop.resolve('../../private')).toThrow(VoiceSampleServiceError);
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  it('supports immediate managed removal without a restart contract', async () => {
    const invokeCommand = vi.fn(async (command, args) => {
      expect(command).toBe('voice_samples_remove');
      args.onEvent.onmessage({
        operationId: args.operationId,
        phase: 'removing', bytesDone: 16384680, totalBytes: 16384680, basisPoints: 10000,
      });
      return status();
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });
    await expect(service.remove()).resolves.toMatchObject({ installed: false, state: 'missing' });
  });

  it('allows the compact Tools row to install the same reviewed pack explicitly', async () => {
    const invokeCommand = vi.fn(async (command) => {
      expect(command).toBe('voice_samples_install');
      return { ...status(), installed: true, state: 'installed', version: '2026.08.11' };
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });
    await expect(service.install()).resolves.toMatchObject({ installed: true });
  });

  it('cancels only the currently active voice-pack operation', async () => {
    let finishInstall;
    const installPending = new Promise((resolve) => { finishInstall = resolve; });
    let startedOperationId;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'voice_samples_install') {
        startedOperationId = args.operationId;
        return installPending;
      }
      expect(command).toBe('voice_samples_cancel');
      expect(args).toEqual({ operationId: startedOperationId });
      return true;
    });
    const service = createVoiceSampleService({
      invokeCommand, ChannelConstructor: TestChannel, nativeRuntime: () => true,
    });
    const installing = service.install();
    await vi.waitFor(() => expect(startedOperationId).toBeDefined());
    await expect(service.cancel()).resolves.toBe(true);
    finishInstall({ ...status(), installed: true, state: 'installed', version: '2026.08.11' });
    await installing;
    await expect(service.cancel()).resolves.toBe(false);
  });

  it('a queued malformed-operation cancel cannot cancel its replacement owner', async () => {
    const firstOperationId = uuidv7();
    const secondOperationId = uuidv7();
    const generatedIds = [firstOperationId, secondOperationId];
    let releaseStaleCancel;
    const staleCancelPending = new Promise((resolve) => { releaseStaleCancel = resolve; });
    let finishReplacement;
    const replacementPending = new Promise((resolve) => { finishReplacement = resolve; });
    let nativeOwner = firstOperationId;
    let replacementCancelled = false;
    const invokeCommand = vi.fn(async (command, args) => {
      if (command === 'voice_samples_install') {
        args.onEvent.onmessage({
          operationId: firstOperationId,
          phase: 'downloading',
          bytesDone: 21,
          totalBytes: 20,
          basisPoints: 5000,
        });
        return status();
      }
      if (command === 'voice_samples_remove') {
        nativeOwner = args.operationId;
        return replacementPending;
      }
      if (command === 'voice_samples_cancel') {
        await staleCancelPending;
        if (args.operationId === nativeOwner) {
          replacementCancelled = nativeOwner === secondOperationId;
          return true;
        }
        return false;
      }
      throw new Error('unexpected command');
    });
    const service = createVoiceSampleService({
      invokeCommand,
      ChannelConstructor: TestChannel,
      nativeRuntime: () => true,
      createOperationId: () => generatedIds.shift(),
    });

    const stale = service.install();
    await vi.waitFor(() => {
      expect(invokeCommand.mock.calls.some(([command]) => command === 'voice_samples_cancel'))
        .toBe(true);
    });
    const replacement = service.remove();
    await vi.waitFor(() => expect(nativeOwner).toBe(secondOperationId));
    releaseStaleCancel();

    await expect(stale).rejects.toMatchObject({ code: 'invalidVoiceSampleResponse' });
    expect(replacementCancelled).toBe(false);
    const cancelCall = invokeCommand.mock.calls.find(([command]) => command === 'voice_samples_cancel');
    expect(cancelCall[1]).toEqual({ operationId: firstOperationId });
    finishReplacement(status());
    await expect(replacement).resolves.toEqual(status());
  });

  it('retains known native codes while redacting messages and causes', async () => {
    const privatePath = 'C:\\Users\\person\\voice-samples.zip';
    const service = createVoiceSampleService({
      invokeCommand: vi.fn().mockRejectedValue({
        code: 'packageNetwork',
        message: privatePath,
        cause: { path: privatePath },
      }),
      nativeRuntime: () => true,
    });
    const error = await service.status().catch((failure) => failure);
    expect(error).toMatchObject({
      code: 'packageNetwork',
      message: 'The managed voice preview is unavailable.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(privatePath);
    expect(String(error)).not.toContain(privatePath);
  });

  it('maps cancellation and collapses malformed or unknown native codes', async () => {
    const cancelled = createVoiceSampleService({
      invokeCommand: vi.fn().mockRejectedValue({ code: 'enginePackageCancelled' }),
      ChannelConstructor: TestChannel,
      nativeRuntime: () => true,
    });
    await expect(cancelled.install()).rejects.toMatchObject({ code: 'voiceSampleCancelled' });

    for (const rejection of [
      { code: 'privateDiagnosticCode', message: 'C:\\private' },
      { code: 'packageNetwork/C:\\private', message: 'C:\\private' },
      new Error('C:\\private'),
    ]) {
      const service = createVoiceSampleService({
        invokeCommand: vi.fn().mockRejectedValue(rejection),
        nativeRuntime: () => true,
      });
      await expect(service.status()).rejects.toMatchObject({
        code: 'voiceSampleUnavailable',
        message: 'The managed voice preview is unavailable.',
      });
    }
  });
});
