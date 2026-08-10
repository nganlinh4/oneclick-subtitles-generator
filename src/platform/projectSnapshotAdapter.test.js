import { version as uuidVersion } from 'uuid';
import {
  canonicalTrackToLegacyRows,
  legacyRowsToCanonicalTrack,
  normalizeProjectSnapshot,
  readLegacySubtitleTrack,
  removeLegacySubtitleTrack,
  replaceLegacySubtitleTrack,
} from './projectSnapshotAdapter';

const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000001';
const TRACK_ID = '01890f39-7b62-7c4e-8c9a-000000000002';
const CUE_ONE_ID = '01890f39-7b62-7c4e-8c9a-000000000003';
const CUE_TWO_ID = '01890f39-7b62-7c4e-8c9a-000000000004';

const emptySnapshot = () => ({
  metadata: { id: PROJECT_ID, name: 'Example' },
  stateVersion: 0,
  media: [],
  tracks: [],
});

test('removes only the selected cached subtitle track without changing media or other tracks', () => {
  const otherTrack = {
    ...canonicalTrack(),
    id: '01890f39-7b62-7c4e-8c9a-000000000104',
    label: 'Imported SRT',
    origin: 'srt',
  };
  const cached = replaceLegacySubtitleTrack(emptySnapshot(), [
    { id: 1, start: 1.25, end: 2.5, text: 'Stored' },
  ], { label: 'Cached subtitles' });
  const withOtherTrack = { ...cached, tracks: [...cached.tracks, otherTrack] };

  const cleared = removeLegacySubtitleTrack(withOtherTrack, { label: 'Cached subtitles' });

  expect(cleared.media).toEqual(withOtherTrack.media);
  expect(cleared.tracks).toEqual([otherTrack]);
  expect(removeLegacySubtitleTrack(cleared, { label: 'Cached subtitles' })).toEqual(cleared);
});

const canonicalTrack = () => ({
  id: TRACK_ID,
  label: 'Cached subtitles',
  origin: 'legacyJson',
  cues: [
    {
      id: CUE_ONE_ID,
      ordinal: 1,
      startMs: 2_745,
      endMs: 4_025,
      text: 'First',
      sourceId: null,
    },
    {
      id: CUE_TWO_ID,
      ordinal: 2,
      startMs: 4_100,
      endMs: 5_200,
      text: 'Second',
      sourceId: CUE_ONE_ID,
    },
  ],
});

it('maps legacy seconds and lineage to sorted canonical millisecond cues', () => {
  const track = legacyRowsToCanonicalTrack([
    { id: 11, startTime: 4.1, endTime: 5.2, text: 'Second', originalId: 10 },
    { id: 10, start: 2.745, end: 4.025, text: 'First', transientUiFlag: true },
  ], { label: 'Cached subtitles' });

  expect(uuidVersion(track.id)).toBe(7);
  expect(track).toMatchObject({ label: 'Cached subtitles', origin: 'legacyJson' });
  expect(track.cues.map((cue) => ({
    ordinal: cue.ordinal,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
  }))).toEqual([
    { ordinal: 1, startMs: 2_745, endMs: 4_025, text: 'First' },
    { ordinal: 2, startMs: 4_100, endMs: 5_200, text: 'Second' },
  ]);
  expect(track.cues[1].sourceId).toBe(track.cues[0].id);
  track.cues.forEach((cue) => expect(uuidVersion(cue.id)).toBe(7));
});

it('rounds legacy floating point seconds exactly like the Rust compatibility parser', () => {
  const track = legacyRowsToCanonicalTrack([
    { start: 2.7445, end: 4.0005, text: 'Rounded once at the boundary' },
  ]);

  expect(track.cues[0]).toMatchObject({ startMs: 2_745, endMs: 4_000 });
});

it('round-trips canonical timing, text, order, and lineage back to legacy rows', () => {
  expect(canonicalTrackToLegacyRows(canonicalTrack())).toEqual([
    { id: 1, start: 2.745, end: 4.025, text: 'First' },
    { id: 2, start: 4.1, end: 5.2, text: 'Second', originalId: 1 },
  ]);
});

it('reuses durable track and cue IDs when editing rows loaded from a project', () => {
  const existing = canonicalTrack();
  const editedRows = canonicalTrackToLegacyRows(existing);
  editedRows[0].text = 'Edited';

  const replacement = legacyRowsToCanonicalTrack(editedRows, { existingTrack: existing });

  expect(replacement.id).toBe(TRACK_ID);
  expect(replacement.cues.map((cue) => cue.id)).toEqual([CUE_ONE_ID, CUE_TWO_ID]);
  expect(replacement.cues[0].text).toBe('Edited');
});

it('replaces only the cache track and leaves stateVersion and unrelated tracks untouched', () => {
  const srtTrack = {
    ...canonicalTrack(),
    id: '01890f39-7b62-7c4e-8c9a-000000000005',
    label: 'Imported SRT',
    origin: 'srt',
    cues: [{
      id: '01890f39-7b62-7c4e-8c9a-000000000006',
      ordinal: 1,
      startMs: 0,
      endMs: 1_000,
      text: 'SRT',
      sourceId: null,
    }],
  };
  const snapshot = { ...emptySnapshot(), stateVersion: 8, tracks: [srtTrack, canonicalTrack()] };

  const changed = replaceLegacySubtitleTrack(snapshot, [
    { id: 1, start: 1, end: 2, text: 'Changed' },
  ], { label: 'Cached subtitles' });

  expect(changed.stateVersion).toBe(8);
  expect(changed.tracks[0]).toEqual(srtTrack);
  expect(changed.tracks[1].id).toBe(TRACK_ID);
  expect(readLegacySubtitleTrack(changed, { label: 'Cached subtitles' })).toEqual([
    { id: 1, start: 1, end: 2, text: 'Changed' },
  ]);
});

it('copies only the path-free ProjectSnapshot contract', () => {
  const snapshot = {
    ...emptySnapshot(),
    canonicalPath: 'C:\\private\\video.mp4',
    metadata: { ...emptySnapshot().metadata, path: '/private/project' },
  };

  expect(normalizeProjectSnapshot(snapshot)).toEqual(emptySnapshot());
});

it.each([
  [[], 'emptyLegacySubtitles'],
  [[{ start: -1, end: 1, text: 'bad' }], 'invalidLegacySubtitleTime'],
  [[{ start: 1, end: 1.0001, text: 'rounds closed' }], 'invalidSubtitleRange'],
  [[{ start: 0, end: 1 }], 'invalidProjectField'],
  [[
    { id: 1, start: 0, end: 1, text: 'one' },
    { id: 1, start: 1, end: 2, text: 'two' },
  ], 'duplicateLegacySubtitleId'],
])('rejects legacy input that cannot be represented without corruption', (rows, code) => {
  expect(() => legacyRowsToCanonicalTrack(rows)).toThrow(expect.objectContaining({ code }));
});
