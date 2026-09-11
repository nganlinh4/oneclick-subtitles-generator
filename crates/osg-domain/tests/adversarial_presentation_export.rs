use osg_domain::{
    formats::write_ass,
    ids::{AssetId, CueId, ProjectId, TranscriptRevisionId},
    subtitles::{SubtitleCue, SubtitleTrack, TrackOrigin},
    transcripts::{CompletionState, TimedWord, TranscriptRevision},
};

fn make_test_revision(words: Vec<TimedWord>) -> TranscriptRevision {
    let start_ms = words.first().map_or(0, TimedWord::start_ms);
    let end_ms = words.iter().map(TimedWord::end_ms).max().unwrap_or(1000);
    TranscriptRevision::new(
        ProjectId::new(),
        Some(AssetId::new()),
        start_ms,
        end_ms,
        "gemini".to_string(),
        "gemini-3.5-transcribe".to_string(),
        1,
        CompletionState::Completed,
        "fp".to_string(),
        1000,
        words,
        Vec::new(),
    )
    .expect("valid revision")
}

#[test]
fn test_ass_karaoke_duration_sum_with_inter_word_gaps() {
    // Cue duration: 2700 - 1000 = 1700ms = 170 centiseconds
    let cue = SubtitleCue::new(1000, 2700, "Word Highlight Check".to_string()).unwrap();
    let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();

    let rev_id = TranscriptRevisionId::new();
    // w1: 1000..1400 (400ms = 40cs)
    let w1 = TimedWord::new(
        rev_id, 0, "Word", "1.000s", "1.400s", 1000, 1400, None, None,
    )
    .unwrap();
    // 100ms pause: 1400..1500
    // w2: 1500..2100 (600ms = 60cs)
    let w2 = TimedWord::new(
        rev_id,
        1,
        "Highlight",
        "1.500s",
        "2.100s",
        1500,
        2100,
        None,
        None,
    )
    .unwrap();
    // 100ms pause: 2100..2200
    // w3: 2200..2700 (500ms = 50cs)
    let w3 = TimedWord::new(
        rev_id, 2, "Check", "2.200s", "2.700s", 2200, 2700, None, None,
    )
    .unwrap();

    let rev = make_test_revision(vec![w1, w2, w3]);
    let ass = write_ass(&track, Some(&rev));

    // Parse the dialogue line:
    // Format: Dialogue: 0,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
    let dialogue_line = ass
        .lines()
        .find(|line| line.starts_with("Dialogue:"))
        .expect("must have dialogue line");

    let parts: Vec<&str> = dialogue_line.splitn(10, ',').collect();
    assert_eq!(parts.len(), 10);
    let text = parts[9];

    // Extract all \k<cs> tags and sum them
    let mut total_k_cs = 0;
    for segment in text.split("{\\k") {
        if let Some(end_brace) = segment.find('}') {
            let cs_str = &segment[..end_brace];
            if let Ok(cs) = cs_str.parse::<i64>() {
                total_k_cs += cs;
            }
        }
    }

    let cue_duration_cs = (2700 - 1000) / 10; // 170 centiseconds
    println!("Total \\k centiseconds: {total_k_cs}, Cue duration cs: {cue_duration_cs}");
    println!("Generated ASS text: {text}");

    assert_eq!(
        total_k_cs, cue_duration_cs,
        "ASS karaoke tags must account for inter-word pauses and sum strictly to cue duration!"
    );
    assert_eq!(total_k_cs, 170);
    assert_eq!(cue_duration_cs, 170);
}

#[test]
fn test_ass_export_translation_track_with_source_revision() {
    // Translated cue in Vietnamese
    let trans_cue = SubtitleCue::with_id(
        CueId::new(),
        1000,
        2700,
        "Trí tuệ nhân tạo đang thay đổi".to_string(),
        None,
    )
    .unwrap();

    let trans_track =
        SubtitleTrack::new("Vietnamese".to_string(), TrackOrigin::Srt, vec![trans_cue]).unwrap();

    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(
        rev_id,
        0,
        "Artificial",
        "1.000s",
        "1.800s",
        1000,
        1800,
        None,
        None,
    )
    .unwrap();
    let w2 = TimedWord::new(
        rev_id,
        1,
        "Intelligence",
        "1.900s",
        "2.700s",
        1900,
        2700,
        None,
        None,
    )
    .unwrap();
    let rev = make_test_revision(vec![w1, w2]);

    // When exporting translation track with source revision:
    let ass_with_rev = write_ass(&trans_track, Some(&rev));
    let dialogue = ass_with_rev
        .lines()
        .find(|l| l.starts_with("Dialogue:"))
        .unwrap();
    println!("Dialogue line: {dialogue}");

    assert!(
        dialogue.contains("Trí tuệ nhân tạo đang thay đổi"),
        "write_ass must preserve translated cue text when exporting translation track!"
    );
    assert!(
        !dialogue.contains("Artificial") && !dialogue.contains("Intelligence"),
        "dialogue must not contain source transcript words when exporting translation track!"
    );
}
