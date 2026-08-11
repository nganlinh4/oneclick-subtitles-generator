import { describe, expect, it, vi } from 'vitest';
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
      phase: 'downloading', bytesDone: 10, totalBytes: 20, basisPoints: 5000,
    }).basisPoints).toBe(5000);
    expect(() => normalizeVoiceSamplePlayback({ ...playback(), path: 'C:\\private.wav' }))
      .toThrow(VoiceSampleServiceError);
    expect(() => normalizeVoiceSamplePlayback({
      ...playback(), playbackUrl: 'https://attacker.invalid/sample.wav',
    })).toThrow(VoiceSampleServiceError);
  });

  it('resolves through one fixed native command and streams validated progress', async () => {
    const events = [];
    const invokeCommand = vi.fn(async (command, args) => {
      expect(command).toBe('voice_sample_resolve');
      expect(args.voiceId).toBe('achernar');
      args.onEvent.onmessage({
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
    const invokeCommand = vi.fn(async (command) => {
      expect(command).toBe('voice_samples_cancel');
      return true;
    });
    const service = createVoiceSampleService({ invokeCommand, nativeRuntime: () => true });
    await expect(service.cancel()).resolves.toBe(true);
  });
});
