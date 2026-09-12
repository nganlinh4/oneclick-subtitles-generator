import { hasSpeakerData, normalizeSpeaker, subtitleDisplayText } from './subtitleSpeaker';
import { canonicalTrackToLegacyRows, legacyRowsToCanonicalTrack } from '../platform/projectSnapshotAdapter';
import { previewCueList } from '../components/previews/native/nativePreviewScene';
import { serializeSrtDocument } from './subtitleDocumentSerializer';

test.each([
  ['hidden', 'Hello'], ['colon', 'Min: Hello'], ['brackets', '[Min] Hello'], ['newLine', 'Min\nHello'],
])('speaker style %s survives storage mapping and produces the same preview/document text', (labelStyle, expected) => {
  const row = { id: 1, start: 0, end: 1, text: 'Hello', speaker: { id: 'w0:1', name: 'Min', labelStyle } };
  const [restored] = canonicalTrackToLegacyRows(legacyRowsToCanonicalTrack([row]));
  expect(restored.speaker).toEqual(row.speaker);
  expect(restored.text).toBe('Hello');
  expect(subtitleDisplayText(restored)).toBe(expected);
  expect(previewCueList([restored])[0].text).toBe(expected);
  expect(serializeSrtDocument([restored])).toContain(expected);
});

test('provider identity defaults to hidden and invalid names never enter snapshots', () => {
  expect(normalizeSpeaker('w0:1')).toEqual({ id: 'w0:1', name: 'w0:1', labelStyle: 'hidden' });
  for (const name of ['', ' ', 'A\nB', 'x'.repeat(201)]) {
    expect(() => normalizeSpeaker({ id: 'w0:1', name })).toThrow();
  }
  let calls = 0;
  expect(() => normalizeSpeaker({ id: 'a', get name() { calls++; return 'x'; } })).toThrow();
  expect(calls).toBe(0);
});

test('speaker controls are available only for tracks carrying valid speaker metadata', () => {
  expect(hasSpeakerData([{ text: 'ordinary cue', speaker: null }])).toBe(false);
  expect(hasSpeakerData([{ text: 'legacy cue without the field' }])).toBe(false);
  expect(hasSpeakerData([{ text: 'spoken cue', speaker: { id: 'w0:1', name: 'Min' } }])).toBe(true);
  expect(hasSpeakerData([{ text: 'damaged cue', speaker: { id: '', name: '' } }])).toBe(false);
});
