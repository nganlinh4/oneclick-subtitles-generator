import {
  attachNativeNarrationArtifact,
  createNativeNarrationToken,
  getNativeNarrationArtifactId,
  hydrateNativeNarrationResults,
  parseNativeNarrationToken,
} from './nativeNarrationCapabilities';

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const NEXT_ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';

test('round-trips only UUIDv7 speech artifact tokens', () => {
  const token = createNativeNarrationToken(ARTIFACT_ID);
  expect(token).toBe(`osg-speech-artifact:${ARTIFACT_ID}`);
  expect(parseNativeNarrationToken(token)).toBe(ARTIFACT_ID);
  expect(parseNativeNarrationToken('C:/private/narration.wav')).toBeNull();
  expect(parseNativeNarrationToken('osg-speech-artifact:550e8400-e29b-41d4-a716-446655440000'))
    .toBeNull();
});

test('hydrates cached tokens and replaces immutable edit artifacts without byte payloads', () => {
  const [hydrated] = hydrateNativeNarrationResults([{
    subtitle_id: 1,
    filename: createNativeNarrationToken(ARTIFACT_ID),
    success: true,
    audioData: 'legacy-bytes',
  }]);
  expect(hydrated).toMatchObject({
    nativeArtifactId: ARTIFACT_ID,
    filename: createNativeNarrationToken(ARTIFACT_ID),
    audioData: null,
  });
  const edited = attachNativeNarrationArtifact(hydrated, {
    artifactId: NEXT_ARTIFACT_ID,
    format: 'wav',
    durationMicros: 500_000,
  });
  expect(getNativeNarrationArtifactId(edited)).toBe(NEXT_ARTIFACT_ID);
  expect(edited).toMatchObject({
    filename: createNativeNarrationToken(NEXT_ARTIFACT_ID),
    audioData: null,
    durationMicros: 500_000,
  });
  expect(JSON.stringify(edited)).not.toContain('C:/');
  expect(JSON.stringify(edited)).not.toContain('base64');
});
