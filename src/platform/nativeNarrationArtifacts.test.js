import { nativeNarrationAdapter } from './nativeNarrationAdapter';
import {
  downloadNativeNarration,
  downloadNativeNarrations,
  editNativeNarration,
} from './nativeNarrationArtifacts';
import { exportSpeechArtifacts } from './speechService';

vi.mock('./nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    resolvePlayback: vi.fn(),
    releasePlayback: vi.fn(),
    editArtifact: vi.fn(),
  },
}));

vi.mock('./speechService', () => ({
  exportSpeechArtifacts: vi.fn(),
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const EDITED_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';

const result = {
  subtitle_id: 7,
  success: true,
  nativeArtifactId: ARTIFACT_ID,
  nativeFormat: 'wav',
  filename: `osg-speech-artifact:${ARTIFACT_ID}`,
};

describe('native narration artifact lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exportSpeechArtifacts.mockResolvedValue(true);
  });

  test('exports one artifact through a path-free native save command without resolving playback', async () => {
    const hostileFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('WebView fetch must remain unreachable')
    );
    await expect(downloadNativeNarration(result, 'narration.wav')).resolves.toBe(true);
    expect(exportSpeechArtifacts).toHaveBeenCalledWith({
      entries: [{ artifactId: ARTIFACT_ID, fileName: 'narration.wav' }],
      archiveName: null,
    });
    expect(nativeNarrationAdapter.resolvePlayback).not.toHaveBeenCalled();
    expect(hostileFetch).not.toHaveBeenCalled();
    hostileFetch.mockRestore();
  });

  test('exports a bounded archive with unique safe names and no capability URLs', async () => {
    await downloadNativeNarrations([
      result,
      { ...result, nativeArtifactId: EDITED_ID },
    ]);
    expect(exportSpeechArtifacts).toHaveBeenCalledWith({
      entries: [
        { artifactId: ARTIFACT_ID, fileName: 'narration_7.wav' },
        { artifactId: EDITED_ID, fileName: 'narration_7_2.wav' },
      ],
      archiveName: 'narration_audio.zip',
    });
    expect(JSON.stringify(exportSpeechArtifacts.mock.calls[0][0])).not.toMatch(
      /(?:127\.0\.0\.1|localhost|token=|playbackUrl|audioUrl|[A-Za-z]:[\\/])/i
    );
  });

  test('publishes immutable edit metadata without paths or audio bytes', async () => {
    nativeNarrationAdapter.editArtifact.mockResolvedValue({
      artifactId: EDITED_ID,
      format: 'wav',
      durationMicros: 500_000,
    });
    await expect(editNativeNarration(result, {
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.5,
    })).resolves.toMatchObject({
      nativeArtifactId: EDITED_ID,
      filename: `osg-speech-artifact:${EDITED_ID}`,
      audioData: null,
    });
    expect(nativeNarrationAdapter.editArtifact).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      normalizedStart: 0.25,
      normalizedEnd: 0.75,
      speedFactor: 1.5,
    });
  });
});
