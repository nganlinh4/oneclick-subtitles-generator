import { createNativeSpeechService } from './speechService';
import {
  ARTIFACT_ID,
  DELIVERY_ID,
  EDITED_ARTIFACT_ID,
  FakeChannel,
  JOB_ID,
  OTHER_PROJECT_ID,
  PLAYBACK_ID,
  PROJECT_ID,
  TOKEN,
  artifact,
  playable,
  playableReference,
  projectNarration,
  projectReference,
} from './speechServiceTestFixtures';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

describe('native speech response validation', () => {
  test('accepts only scoped loopback playback URLs', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_artifact_resolve') return playable();
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.resolveSpeechArtifact(ARTIFACT_ID)).resolves.toMatchObject({
      artifact: { artifactId: ARTIFACT_ID },
      playback: { id: PLAYBACK_ID },
    });

    invokeCommand.mockImplementationOnce(async () => ({
      ...playable(),
      playback: {
        ...playable().playback,
        playbackUrl: `https://attacker.invalid/asset/${PLAYBACK_ID}?token=${TOKEN}`,
      },
    }));
    await expect(service.resolveSpeechArtifact(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('imports opaque audio assets and emits fixed-point edit requests only', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_reference_import') return playableReference();
      if (command === 'speech_artifact_edit') {
        return {
          projectId: PROJECT_ID,
          expectedProjectStateVersion: 7,
          artifact: {
            ...artifact(), artifactId: EDITED_ARTIFACT_ID, durationMicros: 500_000,
          },
        };
      }
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.importSpeechReference({
      backend: 'f5Tts',
      assetId: JOB_ID,
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 0,
    })).resolves.toMatchObject({
      reference: { projectId: PROJECT_ID, referenceVersion: 1 },
      playable: { artifact: { artifactId: ARTIFACT_ID } },
    });
    expect(invokeCommand).toHaveBeenCalledWith('speech_reference_import', {
      request: {
        backend: 'f5Tts',
        assetId: JOB_ID,
        projectId: PROJECT_ID,
        expectedProjectStateVersion: 7,
        expectedReferenceVersion: 0,
      },
    });
    await expect(service.editSpeechArtifact({
      artifactId: ARTIFACT_ID,
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      normalizedStart: 0.125,
      normalizedEnd: 0.875,
      speedFactor: 1.5,
    })).resolves.toMatchObject({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      artifact: { artifactId: EDITED_ARTIFACT_ID },
    });
    expect(invokeCommand).toHaveBeenCalledWith('speech_artifact_edit', {
      request: {
        artifactId: ARTIFACT_ID,
        projectId: PROJECT_ID,
        expectedProjectStateVersion: 7,
        normalizedStartMillionths: 125_000,
        normalizedEndMillionths: 875_000,
        speedMilli: 1_500,
      },
    });
    await expect(service.importSpeechReference({
      backend: 'f5Tts',
      assetId: JOB_ID,
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 0,
      filepath: 'C:/private/reference.wav',
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    await expect(service.editSpeechArtifact({
      artifactId: ARTIFACT_ID,
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      normalizedStart: 0,
      normalizedEnd: 1,
      speedFactor: 1,
      outputPath: 'C:/private/output.wav',
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
  });

  test('restores, commits, and clears only an exact project-owned reference record', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_reference_get') return playableReference();
      if (command === 'speech_reference_commit') {
        return projectReference({
          referenceVersion: 2,
          transcript: 'spoken words',
          language: 'English',
          pendingDelivery: { jobId: JOB_ID, deliveryId: DELIVERY_ID },
        });
      }
      if (command === 'speech_reference_clear') return true;
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });

    await expect(service.getProjectSpeechReference(PROJECT_ID)).resolves.toMatchObject({
      reference: { projectId: PROJECT_ID, referenceVersion: 1 },
      playable: { artifact: { artifactId: ARTIFACT_ID } },
    });
    const commit = {
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 1,
      artifactId: ARTIFACT_ID,
      transcript: 'spoken words',
      language: 'English',
      deliveryJobId: JOB_ID,
      deliveryId: DELIVERY_ID,
    };
    await expect(service.commitProjectSpeechReference(commit)).resolves.toMatchObject({
      referenceVersion: 2,
      pendingDelivery: { jobId: JOB_ID, deliveryId: DELIVERY_ID },
    });
    await expect(service.clearProjectSpeechReference({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 2,
    })).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'speech_reference_get', {
      request: { projectId: PROJECT_ID },
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'speech_reference_commit', {
      request: commit,
    });
  });

  test('refuses a restore response owned by another project', async () => {
    const service = createNativeSpeechService({
      invokeCommand: vi.fn(async () => playableReference({
        reference: { projectId: OTHER_PROJECT_ID },
      })),
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.getProjectSpeechReference(PROJECT_ID)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('stores and restores exact revision-owned narration without browser-shaped fields', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_project_narration_put'
          || command === 'speech_project_narration_get') return projectNarration();
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    const request = {
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      source: 'original',
      results: [{
        subtitleId: 1,
        text: 'spoken words',
        artifactId: ARTIFACT_ID,
        method: 'gtts',
        outputIndex: 0,
        originalIds: [1],
        startMicros: 0,
        endMicros: 1_000_000,
      }],
    };

    await expect(service.putProjectNarration(request)).resolves.toEqual(projectNarration());
    await expect(service.getProjectNarration(PROJECT_ID, 'original'))
      .resolves.toEqual(projectNarration());
    expect(invokeCommand).toHaveBeenNthCalledWith(1, 'speech_project_narration_put', {
      request,
    });
    expect(invokeCommand).toHaveBeenNthCalledWith(2, 'speech_project_narration_get', {
      projectId: PROJECT_ID,
      source: 'original',
    });
    expect(JSON.stringify(invokeCommand.mock.calls)).not.toMatch(
      /(?:localStorage|audioData|playbackUrl|[A-Za-z]:[\\/])/u
    );
  });

  test('refuses duplicate, overlong, or rewritten narration records at the bridge', async () => {
    const invokeCommand = vi.fn(async () => projectNarration({
      results: [{
        ...projectNarration().results[0],
        text: 'native rewrote the request',
      }],
    }));
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    const result = {
      subtitleId: 1,
      text: 'spoken words',
      artifactId: ARTIFACT_ID,
      method: 'gtts',
      outputIndex: 0,
      originalIds: [1],
      startMicros: 0,
      endMicros: 1_000_000,
    };
    const request = {
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      source: 'original',
      results: [result],
    };
    await expect(service.putProjectNarration(request)).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });

    await expect(service.putProjectNarration({
      ...request,
      results: [result, { ...result }],
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    await expect(service.putProjectNarration({
      ...request,
      results: [{ ...result, endMicros: (4 * 60 * 60 * 1_000_000) + 1 }],
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    invokeCommand.mockResolvedValueOnce(projectNarration({
      results: [
        projectNarration().results[0],
        { ...projectNarration().results[0], artifact: { ...artifact(), artifactId: EDITED_ARTIFACT_ID } },
      ],
    }));
    await expect(service.getProjectNarration(PROJECT_ID, 'original')).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });

    // A malformed project id in the host's reply is a response fault, not a request fault.
    invokeCommand.mockResolvedValueOnce(projectNarration({ projectId: 'not-a-uuid' }));
    await expect(service.getProjectNarration(PROJECT_ID, 'original')).rejects.toMatchObject({
      code: 'invalidSpeechResponse',
    });
  });

  test('exports only opaque artifacts and safe leaf names through native save UI', async () => {
    const invokeCommand = vi.fn(async (command) => {
      if (command === 'speech_artifact_export') return true;
      throw new Error('unexpected command');
    });
    const service = createNativeSpeechService({
      invokeCommand,
      ChannelConstructor: FakeChannel,
      isNativeRuntime: () => true,
    });
    await expect(service.exportSpeechArtifacts({
      entries: [{ artifactId: ARTIFACT_ID, fileName: 'narration_1.wav' }],
      archiveName: null,
    })).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith('speech_artifact_export', {
      request: {
        entries: [{ artifactId: ARTIFACT_ID, fileName: 'narration_1.wav' }],
        archiveName: null,
      },
    });
    expect(JSON.stringify(invokeCommand.mock.calls[0][1])).not.toMatch(
      /(?:127\.0\.0\.1|localhost|token=|playbackUrl|audioUrl|[A-Za-z]:[\\/])/i
    );
    await expect(service.exportSpeechArtifacts({
      entries: [{
        artifactId: ARTIFACT_ID,
        fileName: '../private.wav',
        outputPath: 'C:/private/audio.wav',
      }],
      archiveName: null,
    })).rejects.toMatchObject({ code: 'invalidSpeechRequest' });
    expect(invokeCommand).toHaveBeenCalledTimes(1);
  });
});
