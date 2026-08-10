import {
  createNativeNarrationAdapter,
  createNativeSpeechProfile,
} from './nativeNarrationAdapter';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const REFERENCE_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';

const runningJob = {
  id: JOB_ID,
  kind: 'synthesizeNarration',
  state: 'running',
  progress: { basisPoints: 0 },
  sequence: 1,
};

const artifact = {
  artifactId: ARTIFACT_ID,
  format: 'wav',
  bytes: 2_048,
  durationMicros: 900_000,
  sampleRateHz: 24_000,
  channels: 1,
};

describe('legacy-to-native speech settings', () => {
  test('converts F5, Chatterbox, Edge, and gTTS controls without path or process options', () => {
    expect(createNativeSpeechProfile('f5tts', {
      speechRate: 1.25,
      nfeStep: 16,
      swayCoef: -0.5,
      cfgStrength: 2.5,
      removeSilence: false,
    })).toMatchObject({
      backend: 'f5Tts',
      speechRateMilli: 1_250,
      nfeSteps: 16,
      swayMilli: -500,
      guidanceMilli: 2_500,
      removeSilence: false,
    });
    expect(createNativeSpeechProfile('chatterbox', {
      lang: 'ko',
      exaggeration: 1.2,
      cfgWeight: 0.4,
    })).toMatchObject({
      backend: 'chatterbox',
      language: 'ko',
      exaggerationMilli: 1_200,
      cfgWeightMilli: 400,
    });
    expect(createNativeSpeechProfile('edge-tts', {
      voice: 'en-US-AriaNeural',
      rate: '+15%',
      volume: '-4%',
      pitch: '+8Hz',
    })).toMatchObject({ ratePercent: 15, volumePercent: -4, pitchHz: 8 });
    expect(createNativeSpeechProfile('gtts', {
      lang: 'en',
      tld: 'co.uk',
      slow: true,
    })).toEqual({
      backend: 'gtts',
      language: 'en',
      domain: 'co.uk',
      slow: true,
    });
  });

  test('Gemini requires a credential ID and rejects browser-held keys', () => {
    expect(createNativeSpeechProfile('gemini', {
      credentialId: JOB_ID,
      voice: 'Kore',
    })).toMatchObject({ backend: 'geminiTts', credentialId: JOB_ID, voice: 'Kore' });
    expect(() => createNativeSpeechProfile('gemini', {
      credentialId: JOB_ID,
      apiKey: 'browser-secret',
    })).toThrow('invalid');
  });

  test('all backends reject secret, path, and process controls at the adapter boundary', () => {
    expect(() => createNativeSpeechProfile('f5tts', {
      gemini_api_key: 'browser-secret',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('chatterbox', {
      referencePath: 'C:/private/reference.wav',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('edge-tts', {
      voice: 'en-US-AriaNeural',
      serverUrl: 'http://127.0.0.1:9999',
    })).toThrow('invalid');
    expect(() => createNativeSpeechProfile('gtts', {
      lang: 'en',
      pythonPath: 'C:/Python/python.exe',
    })).toThrow('invalid');
  });
});

describe('native narration compatibility adapter', () => {
  test('maps streamed native artifacts into path-free legacy result records', async () => {
    const startSpeechJob = vi.fn(async (request, handlers) => {
      handlers.onProgress({
        event: 'progress',
        jobId: JOB_ID,
        segmentId: 'segment-1',
        index: 1,
        total: 1,
        phase: 'synthesizing',
        fractionMillionths: 500_000,
      });
      handlers.onSegmentCompleted({
        event: 'segmentCompleted',
        jobId: JOB_ID,
        index: 1,
        total: 1,
        result: { status: 'completed', segmentId: 'segment-1', artifact },
      });
      handlers.onCompleted({
        event: 'completed',
        job: { ...runningJob, state: 'succeeded' },
        results: [{ status: 'completed', segmentId: 'segment-1', artifact }],
      });
      return runningJob;
    });
    const speech = {
      startSpeechJob,
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      releaseSpeechPlayback: vi.fn(),
      resolveSpeechArtifact: vi.fn(),
      getSpeechJobResults: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const onProgress = vi.fn();
    const onResult = vi.fn();
    const onComplete = vi.fn();
    const adapter = createNativeNarrationAdapter({ speech });
    const started = await adapter.generate({
      method: 'gtts',
      subtitles: [{
        id: 42,
        text: 'Hello',
        original_ids: [7, 8],
        start: 1.25,
        end: 2.5,
      }],
      settings: { lang: 'en' },
    }, { onProgress, onResult, onComplete });

    expect(started.initialResults).toEqual([expect.objectContaining({
      subtitle_id: 42,
      pending: true,
      filename: null,
      audioData: null,
      original_ids: [7, 8],
      start: 1.25,
      end: 2.5,
    })]);
    expect(startSpeechJob.mock.calls[0][0]).toEqual({
      segments: [{ id: 'segment-1', text: 'Hello' }],
      profile: { backend: 'gtts', language: 'en', domain: 'com', slow: false },
      referenceArtifactId: null,
    });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ fraction: 0.5 }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      subtitle_id: 42,
      success: true,
      pending: false,
      nativeArtifactId: ARTIFACT_ID,
      filename: `osg-speech-artifact:${ARTIFACT_ID}`,
      audioData: null,
      original_ids: [7, 8],
      start: 1.25,
      end: 2.5,
    }), 1, 1);
    expect(onComplete).toHaveBeenCalledWith([
      expect.objectContaining({ nativeArtifactId: ARTIFACT_ID }),
    ]);
    const encoded = JSON.stringify(startSpeechJob.mock.calls[0][0]);
    expect(encoded).not.toContain('filepath');
    expect(encoded).not.toContain('apiKey');
  });

  test('uses only a durable artifact capability for reference-based synthesis', async () => {
    const speech = {
      startSpeechJob: vi.fn(async () => runningJob),
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      releaseSpeechPlayback: vi.fn(),
      resolveSpeechArtifact: vi.fn(),
      getSpeechJobResults: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const adapter = createNativeNarrationAdapter({ speech });
    await adapter.generate({
      method: 'f5tts',
      subtitles: [{ id: 'a', text: 'Hello' }],
      settings: { referenceText: 'Reference words' },
      reference: { nativeArtifactId: REFERENCE_ID },
    });
    expect(speech.startSpeechJob.mock.calls[0][0]).toMatchObject({
      referenceArtifactId: REFERENCE_ID,
      profile: { backend: 'f5Tts', referenceText: 'Reference words' },
    });
  });

  test('rejects filesystem-bearing references and ignored references for non-reference engines', async () => {
    const speech = {
      startSpeechJob: vi.fn(async () => runningJob),
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      releaseSpeechPlayback: vi.fn(),
      resolveSpeechArtifact: vi.fn(),
      getSpeechJobResults: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const adapter = createNativeNarrationAdapter({ speech });
    await expect(adapter.generate({
      method: 'f5tts',
      subtitles: [{ id: 1, text: 'Hello' }],
      reference: {
        nativeArtifactId: REFERENCE_ID,
        filepath: 'C:/private/reference.wav',
      },
    })).rejects.toThrow('invalid');
    await expect(adapter.generate({
      method: 'gtts',
      subtitles: [{ id: 1, text: 'Hello' }],
      settings: { lang: 'en' },
      reference: { nativeArtifactId: REFERENCE_ID },
    })).rejects.toThrow('invalid');
    await expect(adapter.generate({
      method: 'f5tts',
      subtitles: [{ id: 1, text: 'Hello' }],
      reference: {
        nativeArtifactId: REFERENCE_ID,
        artifact: {
          artifactId: REFERENCE_ID,
          path: 'C:/private/reference.wav',
        },
      },
    })).rejects.toThrow('invalid');
    expect(speech.startSpeechJob).not.toHaveBeenCalled();
  });

  test('resolves playback lazily and releases the opaque registration', async () => {
    const speech = {
      resolveSpeechArtifact: vi.fn(async () => ({
        artifact,
        playback: {
          id: PLAYBACK_ID,
          playbackUrl: 'http://127.0.0.1:43210/asset/tokenized',
          mimeType: 'audio/wav',
          byteLength: artifact.bytes,
        },
      })),
      releaseSpeechPlayback: vi.fn(async () => true),
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      startSpeechJob: vi.fn(),
      getSpeechJobResults: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const adapter = createNativeNarrationAdapter({ speech });
    const playable = await adapter.resolvePlayback({ nativeArtifactId: ARTIFACT_ID });
    expect(playable).toMatchObject({
      nativeArtifactId: ARTIFACT_ID,
      nativePlaybackId: PLAYBACK_ID,
    });
    await expect(adapter.releasePlayback(playable)).resolves.toBe(true);
    expect(speech.releaseSpeechPlayback).toHaveBeenCalledWith(PLAYBACK_ID);
  });

  test('imports references and edits artifacts without accepting extra path-bearing fields', async () => {
    const editedArtifact = {
      ...artifact,
      artifactId: REFERENCE_ID,
      durationMicros: 450_000,
    };
    const speech = {
      importSpeechReference: vi.fn(async () => ({
        artifact: { ...artifact, artifactId: REFERENCE_ID },
        playback: {
          id: PLAYBACK_ID,
          playbackUrl: 'http://127.0.0.1:43210/asset/tokenized',
          mimeType: 'audio/wav',
          byteLength: artifact.bytes,
        },
      })),
      editSpeechArtifact: vi.fn(async () => editedArtifact),
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      releaseSpeechPlayback: vi.fn(),
      resolveSpeechArtifact: vi.fn(),
      startSpeechJob: vi.fn(),
      getSpeechJobResults: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const adapter = createNativeNarrationAdapter({ speech });
    await expect(adapter.importReference({
      method: 'f5tts',
      assetId: JOB_ID,
    })).resolves.toMatchObject({ nativeArtifactId: REFERENCE_ID });
    expect(speech.importSpeechReference).toHaveBeenCalledWith({
      backend: 'f5Tts',
      assetId: JOB_ID,
    });
    await expect(adapter.editArtifact({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.5,
    })).resolves.toEqual(editedArtifact);
    expect(speech.editSpeechArtifact).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.5,
    });
    await expect(adapter.importReference({
      method: 'f5tts',
      assetId: JOB_ID,
      filepath: 'C:/private/reference.wav',
    })).rejects.toThrow('invalid');
    await expect(adapter.editArtifact({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0,
      normalizedEnd: 1,
      speedFactor: 1,
      outputPath: 'C:/private/output.wav',
    })).rejects.toThrow('invalid');
  });

  test('restores durable results using deterministic segment identities', async () => {
    const speech = {
      getSpeechJobResults: vi.fn(async () => ({
        job: runningJob,
        backend: 'edgeTts',
        results: [{ status: 'completed', segmentId: 'segment-2', artifact }],
      })),
      getSpeechStatus: vi.fn(),
      probeSpeechBackend: vi.fn(),
      stopSpeechRuntime: vi.fn(),
      cancelSpeechJob: vi.fn(),
      selectSpeechReference: vi.fn(),
      extractSpeechReference: vi.fn(),
      releaseSpeechPlayback: vi.fn(),
      resolveSpeechArtifact: vi.fn(),
      startSpeechJob: vi.fn(),
      startVoiceConversionJob: vi.fn(),
    };
    const adapter = createNativeNarrationAdapter({ speech });
    await expect(adapter.restore({
      jobId: JOB_ID,
      method: 'edge-tts',
      subtitles: [{ id: 9, text: 'One' }, { id: 10, text: 'Two' }],
    })).resolves.toMatchObject({
      results: [{ subtitle_id: 10, text: 'Two', nativeArtifactId: ARTIFACT_ID }],
    });
  });
});
