import {
  GEMINI_SPEECH_MODELS,
  createNativeSpeechService,
  createSpeechLifecycleState,
  normalizeSpeechProfile,
  normalizeSpeechStartRequest,
  normalizeSpeechStatus,
} from './speechService';
import {
  ARTIFACT_ID,
  FakeChannel,
  JOB_ID,
  PLAYBACK_ID,
  PROJECT_ID,
  backendStatus,
  status,
} from './speechServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native speech request validation', () => {
  test('normalizes useful defaults for every supported backend', () => {
    expect(normalizeSpeechProfile({ backend: 'f5Tts' })).toEqual({
      backend: 'f5Tts',
      referenceText: null,
      model: null,
      speechRateMilli: 1_100,
      nfeSteps: 32,
      swayMilli: -1_000,
      guidanceMilli: 2_000,
      seed: null,
      removeSilence: true,
    });
    expect(normalizeSpeechProfile({
      backend: 'chatterbox',
      language: 'ko',
    })).toMatchObject({ exaggerationMilli: 1_000, cfgWeightMilli: 500 });
    expect(normalizeSpeechProfile({
      backend: 'edgeTts',
      voice: 'en-US-AriaNeural',
    })).toMatchObject({ ratePercent: 0, volumePercent: 0, pitchHz: 0 });
    expect(normalizeSpeechProfile({
      backend: 'gtts',
      language: 'en',
    })).toEqual({ backend: 'gtts', language: 'en', domain: 'com', slow: false });
    expect(normalizeSpeechProfile({
      backend: 'geminiTts',
      credentialIds: [JOB_ID],
    })).toMatchObject({
      model: GEMINI_SPEECH_MODELS[0],
      voice: 'Aoede',
      language: 'en-US',
      maxConcurrency: 5,
    });
    expect(normalizeSpeechProfile({
      backend: 'geminiTts', credentialIds: [JOB_ID], maxConcurrency: 10,
    }).maxConcurrency).toBe(10);
  });

  test('requires an opaque reference only for reference-based engines', () => {
    expect(() => normalizeSpeechStartRequest({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'f5Tts' },
      referenceArtifactId: null,
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'gtts', language: 'en' },
      referenceArtifactId: ARTIFACT_ID,
    })).toThrow('invalid');
  });

  test.each([undefined, null, 'not-a-project', PLAYBACK_ID])(
    'requires a UUIDv7 project capability: %s',
    (projectId) => {
      expect(() => normalizeSpeechStartRequest({
        projectId,
        expectedProjectStateVersion: 7,
        lifecycleEpoch: 0,
        segments: [{ id: 'one', text: 'hello' }],
        profile: { backend: 'gtts', language: 'en' },
      })).toThrow('invalid');
    },
  );

  test('rejects duplicate IDs, controls, oversized Chatterbox text, and unknown options', () => {
    expect(() => normalizeSpeechStartRequest({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 0,
      segments: [{ id: 'same', text: 'a' }, { id: 'same', text: 'b' }],
      profile: { backend: 'gtts', language: 'en' },
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'a\u0000b' }],
      profile: { backend: 'gtts', language: 'en' },
    })).toThrow('invalid');
    expect(() => normalizeSpeechStartRequest({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 0,
      segments: [{ id: 'one', text: 'x'.repeat(301) }],
      profile: { backend: 'chatterbox' },
      referenceArtifactId: ARTIFACT_ID,
    })).toThrow('invalid');
    expect(() => normalizeSpeechProfile({
      backend: 'geminiTts',
      credentialIds: [JOB_ID],
      apiKey: 'must-not-cross',
    })).toThrow('invalid');
  });
});

describe('native speech response validation', () => {
  test('accepts a complete status catalog and rejects impossible readiness', () => {
    expect(normalizeSpeechStatus(status()).backends).toHaveLength(5);
    const invalid = status();
    invalid.backends[0] = backendStatus('f5Tts', { ready: true });
    expect(() => normalizeSpeechStatus(invalid)).toThrow('invalid');
  });

  test('reads cached warm inventory through the non-starting native command only', async () => {
    const lifecycleState = createSpeechLifecycleState();
    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 7, enabled: true, installed: true, ready: true, warm: true,
    }));
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_voice_inventory') {
        return {
          backend: 'edgeTts',
          epoch: 7,
          enabled: true,
          warm: true,
          voices: [{
            id: 'en-US-AriaNeural',
            displayName: 'Aria',
            language: 'en-US',
            gender: 'female',
          }],
        };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });

    await expect(service.getSpeechVoiceInventory('edgeTts', 7)).resolves.toMatchObject({
      backend: 'edgeTts',
      epoch: 7,
      voices: [{ id: 'en-US-AriaNeural' }],
    });
    expect(invokeCommand).toHaveBeenCalledExactlyOnceWith(
      'speech_voice_inventory',
      { backend: 'edgeTts', epoch: 7 }
    );
    expect(invokeCommand).not.toHaveBeenCalledWith('speech_probe', expect.anything());
    expect(invokeCommand).not.toHaveBeenCalledWith('speech_start', expect.anything());
    await expect(service.getSpeechVoiceInventory('f5Tts', 7)).rejects.toMatchObject({
      code: 'invalidSpeechRequest',
    });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });

  test('rejects inventory returned for a different backend', async () => {
    const lifecycleState = createSpeechLifecycleState();
    lifecycleState.apply(backendStatus('edgeTts', {
      epoch: 4, enabled: true, installed: true, ready: true, warm: true,
    }));
    const service = createNativeSpeechService({
      invokeCommand: vi.fn(async () => ({
        backend: 'gtts', epoch: 4, enabled: true, warm: true, voices: [],
      })),
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    await expect(service.getSpeechVoiceInventory('edgeTts', 4)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('rejects late inventory and stale starts after an authoritative Stop epoch', async () => {
    const lifecycleState = createSpeechLifecycleState();
    const running = backendStatus('edgeTts', {
      epoch: 9, enabled: true, installed: true, ready: true, warm: true,
    });
    lifecycleState.apply(running);
    let resolveInventory;
    const invokeCommand = vi.fn((command) => {
      if (command === 'speech_voice_inventory') {
        return new Promise((resolve) => { resolveInventory = resolve; });
      }
      if (command === 'speech_runtime_stop') {
        return Promise.resolve(backendStatus('edgeTts', {
          epoch: 10, enabled: false, installed: true, ready: false, warm: false,
        }));
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
      lifecycleState,
    });
    const lifecycleObserver = vi.fn();
    lifecycleState.subscribe(lifecycleObserver);
    const lateInventory = service.getSpeechVoiceInventory('edgeTts', 9);

    await expect(service.stopSpeechRuntime('edgeTts')).resolves.toMatchObject({
      epoch: 10, enabled: false, warm: false,
    });
    expect(lifecycleObserver).toHaveBeenLastCalledWith(expect.objectContaining({
      backend: 'edgeTts', epoch: 10, enabled: false, warm: false,
    }));
    lifecycleState.apply(running);
    expect(lifecycleState.getSnapshot('edgeTts')).toMatchObject({
      epoch: 10, enabled: false, warm: false,
    });
    resolveInventory({
      backend: 'edgeTts', epoch: 9, enabled: true, warm: true, voices: [],
    });
    await expect(lateInventory).rejects.toMatchObject({ code: 'speechRuntimeStopped' });
    await expect(service.startSpeechJob({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      lifecycleEpoch: 9,
      segments: [{ id: 'one', text: 'hello' }],
      profile: { backend: 'edgeTts', voice: 'en-US-AriaNeural' },
    })).rejects.toMatchObject({ code: 'speechRuntimeStopped' });
    expect(invokeCommand.mock.calls.filter(([command]) => command === 'speech_start')).toHaveLength(0);
  });

});
