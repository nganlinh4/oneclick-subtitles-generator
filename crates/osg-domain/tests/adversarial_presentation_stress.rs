#![allow(clippy::all, clippy::pedantic)]

use osg_domain::{
    formats::write_ass,
    ids::{AssetId, CueId, ProjectId, TranscriptRevisionId},
    subtitles::{SubtitleCue, SubtitleTrack, TrackOrigin},
    transcripts::{CompletionState, TimedWord, TranscriptRevision},
};

fn extract_total_k_cs(ass_dialogue_text: &str) -> i64 {
    let mut total = 0;
    for segment in ass_dialogue_text.split("{\\k") {
        if let Some(end_brace) = segment.find('}') {
            let cs_str = &segment[..end_brace];
            if let Ok(cs) = cs_str.parse::<i64>() {
                total += cs;
            }
        }
    }
    total
}

fn make_revision(words: Vec<TimedWord>) -> TranscriptRevision {
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
fn test_ass_stress_single_word_variations() {
    let rev_id = TranscriptRevisionId::new();

    // 1. Single word exactly matching cue duration
    {
        let cue = SubtitleCue::new(1000, 2000, "Solo".to_string()).unwrap();
        let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();
        let w = TimedWord::new(
            rev_id, 0, "Solo", "1.000s", "2.000s", 1000, 2000, None, None,
        )
        .unwrap();
        let rev = make_revision(vec![w]);
        let ass = write_ass(&track, Some(&rev));
        let line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
        let text = line.splitn(10, ',').nth(9).unwrap();
        let total_cs = extract_total_k_cs(text);
        let cue_dur_cs = (2000 - 1000) / 10;
        assert_eq!(
            total_cs, cue_dur_cs,
            "Single word exact: expected {cue_dur_cs}, got {total_cs}"
        );
    }

    // 2. Single word with lead-in and lead-out pause
    {
        let cue = SubtitleCue::new(1000, 3000, "Solo".to_string()).unwrap(); // 200cs
        let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();
        // lead-in 300ms, word 1000ms, lead-out 700ms
        let w = TimedWord::new(
            rev_id, 0, "Solo", "1.300s", "2.300s", 1300, 2300, None, None,
        )
        .unwrap();
        let rev = make_revision(vec![w]);
        let ass = write_ass(&track, Some(&rev));
        let line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
        let text = line.splitn(10, ',').nth(9).unwrap();
        let total_cs = extract_total_k_cs(text);
        let cue_dur_cs = (3000 - 1000) / 10;
        assert_eq!(
            total_cs, cue_dur_cs,
            "Single word with pauses: expected {cue_dur_cs}, got {total_cs}"
        );
        assert!(text.contains("{\\k30}"), "Expected 30cs lead-in");
        assert!(text.contains("{\\k100}Solo"), "Expected 100cs word");
        assert!(text.contains("{\\k70}"), "Expected 70cs lead-out");
    }
}

#[test]
fn test_ass_stress_many_words_with_irregular_gaps() {
    let rev_id = TranscriptRevisionId::new();
    let cue_start = 5000;
    let cue_end = 15000; // 10000ms = 1000cs
    let cue_dur_cs = (cue_end - cue_start) / 10;

    // 8 words with varying lengths and gaps
    let intervals = vec![
        (5200, 5800, "One"),     // gap 200 lead-in, word 600
        (6100, 6900, "Two"),     // gap 300, word 800
        (7000, 7500, "Three"),   // gap 100, word 500
        (7500, 8200, "Four"),    // gap 0, word 700
        (8500, 9300, "Five"),    // gap 300, word 800
        (9400, 10200, "Six"),    // gap 100, word 800
        (10500, 12000, "Seven"), // gap 300, word 1500
        (12500, 14200, "Eight"), // gap 500, word 1700, lead-out 800
    ];

    let mut words = Vec::new();
    let mut word_texts = Vec::new();
    for (idx, (st, et, txt)) in intervals.into_iter().enumerate() {
        let w = TimedWord::new(
            rev_id,
            idx as u32,
            txt,
            &format!("{st}"),
            &format!("{et}"),
            st,
            et,
            None,
            None,
        )
        .unwrap();
        words.push(w);
        word_texts.push(txt);
    }

    let cue_text = word_texts.join(" ");
    let cue = SubtitleCue::new(cue_start, cue_end, cue_text).unwrap();
    let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();
    let rev = make_revision(words);

    let ass = write_ass(&track, Some(&rev));
    let line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
    let text = line.splitn(10, ',').nth(9).unwrap();
    let total_cs = extract_total_k_cs(text);

    assert_eq!(
        total_cs, cue_dur_cs,
        "Sum of tags must match cue duration exactly: {total_cs} == {cue_dur_cs}"
    );
}

#[test]
fn test_ass_stress_rounding_and_fractional_centiseconds() {
    let rev_id = TranscriptRevisionId::new();

    // Cue duration not a clean multiple of 10ms:
    // e.g. 1003ms to 2507ms -> duration 1504ms.
    // In centiseconds: (1504 + 5) / 10 = 1509 / 10 = 150cs.
    let cue = SubtitleCue::new(1003, 2507, "Alpha Beta Gamma".to_string()).unwrap();
    let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();

    let w1 = TimedWord::new(
        rev_id, 0, "Alpha", "1.003s", "1.407s", 1003, 1407, None, None,
    )
    .unwrap();
    let w2 = TimedWord::new(
        rev_id, 1, "Beta", "1.411s", "1.999s", 1411, 1999, None, None,
    )
    .unwrap();
    let w3 = TimedWord::new(
        rev_id, 2, "Gamma", "2.001s", "2.507s", 2001, 2507, None, None,
    )
    .unwrap();

    let rev = make_revision(vec![w1, w2, w3]);
    let ass = write_ass(&track, Some(&rev));
    let line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
    let text = line.splitn(10, ',').nth(9).unwrap();
    let total_cs = extract_total_k_cs(text);

    let target_dur_cs = (((2507 - 1003) + 5) / 10).max(1);
    assert_eq!(
        total_cs, target_dur_cs,
        "Fractional ms rounding must reconcile: {total_cs} == {target_dur_cs}"
    );
}

#[test]
fn test_ass_stress_pseudo_random_simulation_100_runs() {
    let rev_id = TranscriptRevisionId::new();

    // Deterministic pseudo-random sequence (Linear Congruential Generator)
    let mut seed: u64 = 0xDEADBEEF;
    let mut next_rand = || -> u64 {
        seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        seed
    };

    for run in 0..100 {
        let cue_start = (next_rand() % 50_000 + 1000) as i64;
        let cue_dur_ms = (next_rand() % 8000 + 500) as i64; // 500ms .. 8500ms
        let cue_end = cue_start + cue_dur_ms;
        let target_dur_cs = (((cue_dur_ms) + 5) / 10).max(1);

        let num_words = (next_rand() % 6 + 1) as usize; // 1 .. 6 words
        let mut cur_time = cue_start + (next_rand() % 200) as i64; // lead in 0..200ms
        let mut words = Vec::new();
        let mut words_text = Vec::new();

        for i in 0..num_words {
            let word_dur = (next_rand() % 800 + 50) as i64; // 50..850ms
            let w_end = (cur_time + word_dur).min(cue_end);
            let w_start = cur_time.min(w_end.saturating_sub(10));
            let text = format!("Word{i}");
            let tw = TimedWord::new(
                rev_id,
                i as u32,
                &text,
                &format!("{w_start}"),
                &format!("{w_end}"),
                w_start,
                w_end,
                None,
                None,
            )
            .unwrap();
            words.push(tw);
            words_text.push(text);

            let gap = (next_rand() % 150) as i64;
            cur_time = w_end + gap;
            if cur_time >= cue_end {
                break;
            }
        }

        let cue = SubtitleCue::new(cue_start, cue_end, words_text.join(" ")).unwrap();
        let track = SubtitleTrack::new("Main".to_string(), TrackOrigin::Srt, vec![cue]).unwrap();
        let rev = make_revision(words);

        let ass = write_ass(&track, Some(&rev));
        let line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();
        let text = line.splitn(10, ',').nth(9).unwrap();
        let total_cs = extract_total_k_cs(text);

        assert_eq!(
            total_cs, target_dur_cs,
            "Run {run} failed: total_cs={total_cs}, target_dur_cs={target_dur_cs}, cue_dur_ms={cue_dur_ms}"
        );
    }
}

#[test]
fn test_ass_stress_translation_matrix() {
    let rev_id = TranscriptRevisionId::new();
    let w1 = TimedWord::new(
        rev_id, 0, "Good", "1.000s", "1.500s", 1000, 1500, None, None,
    )
    .unwrap();
    let w2 = TimedWord::new(
        rev_id, 1, "Morning", "1.600s", "2.000s", 1600, 2000, None, None,
    )
    .unwrap();
    let rev = make_revision(vec![w1, w2]);

    let test_cases = vec![
        // (track_label, cue_source_id, cue_text, should_preserve)
        ("Vietnamese", None, "Chào buổi sáng", true),
        ("Spanish", None, "Buenos días", true),
        ("German", None, "Guten Morgen", true),
        ("Japanese", None, "おはようございます", true),
        ("Korean", None, "좋은 아침입니다", true),
        ("Subtitles (FR)", None, "Bonjour le monde", true),
        // Track labeled "Main" but has cue.source_id set (linked translation track)
        ("Main", Some(CueId::new()), "Chào buổi sáng", true),
        // Track labeled "Default" but cue text is translation with no source word overlap
        ("Default", None, "Xin chào bạn", true),
    ];

    for (label, source_id, text, should_preserve) in test_cases {
        let cues = if let Some(sid) = source_id {
            let src_cue =
                SubtitleCue::with_id(sid, 1000, 2000, "Source text".to_string(), None).unwrap();
            let trans_cue =
                SubtitleCue::with_id(CueId::new(), 1000, 2000, text.to_string(), Some(sid))
                    .unwrap();
            vec![src_cue, trans_cue]
        } else {
            vec![SubtitleCue::new(1000, 2000, text.to_string()).unwrap()]
        };

        let track = SubtitleTrack::new(label.to_string(), TrackOrigin::Srt, cues).unwrap();
        let ass = write_ass(&track, Some(&rev));
        let _line = ass.lines().find(|l| l.starts_with("Dialogue:")).unwrap();

        if should_preserve {
            assert!(
                ass.contains(text),
                "Label '{label}' must preserve '{text}'. Full ASS:\n{ass}"
            );
            // Verify translated cue line does NOT contain \k
            let trans_line = ass
                .lines()
                .find(|l| l.contains(text))
                .expect("must find translated cue line");
            assert!(
                !trans_line.contains("{\\k"),
                "Translation track must NOT have karaoke tags. Got: '{trans_line}'"
            );
        }
    }
}
