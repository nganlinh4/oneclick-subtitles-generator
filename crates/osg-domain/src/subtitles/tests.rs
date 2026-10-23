//! Subtitle track tests: canonical ordering, indexed lookup, and the command-boundary payloads.

use uuid::{Uuid, Version};

use super::{SubtitleCue, SubtitleTrack, TrackOrigin};

fn cue(start_ms: i64, end_ms: i64, text: &str) -> SubtitleCue {
    SubtitleCue::new(start_ms, end_ms, text.to_owned()).expect("valid cue")
}

#[test]
fn track_sorts_and_reindexes_cues() {
    let track = SubtitleTrack::new(
        "Track".to_owned(),
        TrackOrigin::Srt,
        vec![cue(2_000, 3_000, "second"), cue(0, 1_000, "first")],
    )
    .expect("valid track");

    assert_eq!(track.cues()[0].text(), "first");
    assert_eq!(track.cues()[0].ordinal(), 1);
    assert_eq!(track.cues()[1].ordinal(), 2);
}

#[test]
fn new_tracks_and_cues_use_time_sortable_ids() {
    let cue = cue(0, 1_000, "first");
    assert_eq!(cue.id().as_uuid().get_version(), Some(Version::SortRand));

    let track = SubtitleTrack::new("Track", TrackOrigin::Srt, vec![cue]).expect("valid track");
    assert_eq!(track.id().as_uuid().get_version(), Some(Version::SortRand));
}

#[test]
fn indexed_lookup_handles_overlapping_cues() {
    let track = SubtitleTrack::new(
        "Track".to_owned(),
        TrackOrigin::Srt,
        vec![
            cue(0, 10_000, "long"),
            cue(1_000, 2_000, "short"),
            cue(12_000, 13_000, "later"),
        ],
    )
    .expect("valid track");

    assert_eq!(
        track.active_cue_at(1_500).map(SubtitleCue::text),
        Some("short")
    );
    assert_eq!(
        track.active_cue_at(5_000).map(SubtitleCue::text),
        Some("long")
    );
    assert!(track.active_cue_at(11_000).is_none());
}

#[test]
fn lookup_scales_to_large_tracks() {
    let cues = (0..10_000)
        .map(|index| {
            let start = i64::from(index) * 1_000;
            cue(start, start + 800, "caption")
        })
        .collect();
    let track =
        SubtitleTrack::new("Large".to_owned(), TrackOrigin::Srt, cues).expect("valid track");

    assert_eq!(
        track.active_cue_at(9_999_100).map(SubtitleCue::ordinal),
        Some(10_000)
    );
}

#[test]
fn persisted_tracks_rebuild_indexes_and_reject_noncanonical_data() {
    let track = SubtitleTrack::new(
        "English",
        TrackOrigin::Srt,
        vec![cue(0, 3_000, "long"), cue(1_000, 2_000, "short")],
    )
    .expect("valid track");
    let json = serde_json::to_string(&track).expect("serializable track");
    let restored: SubtitleTrack = serde_json::from_str(&json).expect("valid snapshot");

    assert_eq!(restored, track);
    assert_eq!(restored.duration_ms(), 3_000);

    let legacy_id = Uuid::new_v4();
    let invalid = json.replacen(&track.id().to_string(), &legacy_id.to_string(), 1);
    assert!(serde_json::from_str::<SubtitleTrack>(&invalid).is_err());

    let invalid_ordinal = json.replacen("\"ordinal\":1", "\"ordinal\":3", 1);
    assert!(serde_json::from_str::<SubtitleTrack>(&invalid_ordinal).is_err());
}

/// `project_track_commit` (apps/desktop/src-tauri/src/commands.rs) receives `before_track`
/// and `after_track` as `Option<SubtitleTrack>` -- this is the exact wire boundary Tauri
/// deserializes before the command body ever runs. A range move that translates several cues
/// at once (osg-editor's own move -- see src/hooks/useLyricsEditorHelpers.js on the frontend)
/// sends a track shaped exactly like this: multiple cues, consecutive ordinals, no source
/// links. This locks that the boundary accepts it byte-for-byte as JSON, not just as a Rust
/// value.
#[test]
fn command_boundary_accepts_a_real_multi_cue_range_move_payload() {
    let track = SubtitleTrack::new(
        "Cached subtitles".to_owned(),
        TrackOrigin::LegacyJson,
        vec![
            cue(
                0,
                19_010,
                "Interior cue for direct start and end drag tests",
            ),
            cue(15_710, 16_710, "First cue of the move-together range"),
            cue(17_210, 18_210, "Second cue of the move-together range"),
            cue(8_000, 8_500, "Sticky cascade base cue"),
            cue(9_000, 9_500, "Sticky cascade follower cue"),
        ],
    )
    .expect("valid multi-cue track");
    let json = serde_json::to_string(&track).expect("serializable track");

    // `before_track`/`after_track` are `Option<SubtitleTrack>`: a present track wire-encodes
    // as the plain object, exactly what serde_json produces above.
    let wire: Option<SubtitleTrack> = serde_json::from_str(&json).expect("wire payload parses");
    assert_eq!(wire, Some(track));
}

/// The one field this boundary has ever rejected with `invalid type: null, expected u32` is a
/// cue's `ordinal`. Every producer on the frontend (`legacyRowsToCanonicalTrack` in
/// src/platform/projectSnapshotAdapter.js) always computes it as a real `index + 1`, so this
/// characterizes -- and locks -- the exact failure a malformed payload would hit, rather than
/// silently accepting a cue that lost its position.
#[test]
fn command_boundary_rejects_a_cue_with_a_null_ordinal() {
    let track = SubtitleTrack::new(
        "Cached subtitles".to_owned(),
        TrackOrigin::LegacyJson,
        vec![
            cue(3_000, 4_000, "First cue of the move-together range"),
            cue(4_500, 5_500, "Second cue of the move-together range"),
        ],
    )
    .expect("valid track");
    let json = serde_json::to_string(&track).expect("serializable track");
    let malformed = json.replacen("\"ordinal\":1", "\"ordinal\":null", 1);

    let error = serde_json::from_str::<SubtitleTrack>(&malformed)
        .expect_err("a null ordinal must not silently become a valid cue");
    assert!(
        error
            .to_string()
            .contains("invalid type: null, expected u32"),
        "unexpected error message: {error}"
    );
}

/// A field investigation into a customer failure ("timelineAdvancedEditing", digest
/// `6a001ac4...`) reported `invalid type: null, expected u32` at small byte columns (the
/// 80s-280s) inside a command's JSON body during the multi-cue range-move step. This test
/// closes that lead formally: a null `ordinal`, wrapped in the *real* `project_track_commit`
/// envelope `commitTrackDetached` builds in `src/platform/projectService.js`
/// (`{id, selector, expectedHistoryVersion, beforeTrack, afterTrack, reason}`), cannot land
/// anywhere near those columns -- `id`, `selector` and `expectedHistoryVersion` alone already
/// consume well over 100 bytes before `beforeTrack` even starts, and the first cue inside it
/// contributes another ~150 bytes of its own `id`/UUID before `ordinal` is reached. So even
/// though `ordinal` is the only `u32` this boundary has ever rejected, it is not — and cannot
/// be — the field the field investigation was chasing. That failure is real and unexplained by
/// this crate; it is not `SubtitleTrack::ordinal`.
#[test]
fn a_null_ordinal_inside_the_real_commit_envelope_lands_well_past_the_observed_small_offsets() {
    use serde::Deserialize;

    /// Mirrors the exact argument shape `commitTrackDetached`
    /// (`src/platform/projectService.js`) sends `project_track_commit`:
    /// `{id, selector, expectedHistoryVersion, beforeTrack, afterTrack, reason}`.
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    #[allow(dead_code, reason = "only ever deserialized to reach a failing column")]
    struct Envelope {
        id: String,
        selector: serde_json::Value,
        expected_history_version: u64,
        before_track: Option<SubtitleTrack>,
        after_track: Option<SubtitleTrack>,
        reason: String,
    }

    let track = SubtitleTrack::new(
        "Cached subtitles".to_owned(),
        TrackOrigin::LegacyJson,
        vec![cue(
            0,
            1_000,
            "Interior cue for direct start and end drag tests",
        )],
    )
    .expect("valid track");
    let track_json = serde_json::to_string(&track).expect("serializable track");
    let malformed_track = track_json.replacen("\"ordinal\":1", "\"ordinal\":null", 1);

    // Mirrors the exact argument shape and key order `commitTrackDetached` sends:
    // { id, selector, expectedHistoryVersion, beforeTrack, afterTrack, reason }.
    let envelope = format!(
        "{{\"id\":\"01978b1a-0000-7000-8000-000000000001\",\
             \"selector\":{{\"label\":\"Cached subtitles\",\"origin\":\"legacyJson\"}},\
             \"expectedHistoryVersion\":3,\
             \"beforeTrack\":{malformed_track},\
             \"afterTrack\":{malformed_track},\
             \"reason\":\"OSG lyrics editor v1: timing drag\"}}"
    );

    let error = serde_json::from_str::<Envelope>(&envelope)
        .expect_err("a null ordinal must still be rejected inside the real envelope");
    let message = error.to_string();
    assert!(
        message.contains("invalid type: null, expected u32"),
        "unexpected error message: {message}"
    );
    let column: usize = message
        .rsplit("column ")
        .next()
        .and_then(|tail| tail.parse().ok())
        .expect("a text-parsed struct error always reports a column");
    assert!(
        column > 300,
        "a null ordinal inside the real commit envelope landed at column {column}, which \
             would make it a plausible match for the observed small-offset product failure -- \
             re-open the ordinal theory instead of trusting this comment"
    );
}
