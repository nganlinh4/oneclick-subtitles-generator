//! Head-of-line sequencing and out-of-order window promotion.

use super::*;

#[test]
fn test_staging_head_of_line_sequencing() {
    let staging = StagingBuffer::new();

    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: "hello".to_owned(),
            raw_start_ns: 0,
            raw_end_ns: 500_000_000,
            project_start_ms: 0,
            project_end_ms: 500,
            speaker_id: Some("w0:1".to_owned()),
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        }],
    };

    let win1 = StagedWindowResult {
        window_index: 1,
        window: WindowRange::new(1, 60_000, 120_000),
        words: vec![ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: "world".to_owned(),
            raw_start_ns: 0,
            raw_end_ns: 500_000_000,
            project_start_ms: 60_000,
            project_end_ms: 60_500,
            speaker_id: Some("w1:1".to_owned()),
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        }],
    };

    // Window 1 arrives first (out-of-order)
    staging.insert(win1);
    assert!(staging.pop_promotable().is_none());

    // Window 0 arrives
    staging.insert(win0);

    // Window 0 popped first
    let popped0 = staging.pop_promotable().unwrap();
    assert_eq!(popped0.window_index, 0);

    // Window 1 popped next
    let popped1 = staging.pop_promotable().unwrap();
    assert_eq!(popped1.window_index, 1);

    assert!(staging.pop_promotable().is_none());
}

#[test]
fn test_monotonic_ordinals_across_windows() {
    let staging = StagingBuffer::new();
    let rev_id = TranscriptRevisionId::new();

    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![
            ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: "word1".to_owned(),
                raw_start_ns: 0,
                raw_end_ns: 500_000_000,
                project_start_ms: 0,
                project_end_ms: 500,
                speaker_id: None,
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            },
            ProjectedWordResult {
                status: WordProjectionStatus::Accepted,
                text: "word2".to_owned(),
                raw_start_ns: 500_000_000,
                raw_end_ns: 1_000_000_000,
                project_start_ms: 500,
                project_end_ms: 1000,
                speaker_id: None,
                is_unaligned: false,
                alignment_status: "aligned".to_owned(),
            },
        ],
    };

    let win1 = StagedWindowResult {
        window_index: 1,
        window: WindowRange::new(1, 60_000, 120_000),
        words: vec![ProjectedWordResult {
            status: WordProjectionStatus::Accepted,
            text: "word3".to_owned(),
            raw_start_ns: 0,
            raw_end_ns: 500_000_000,
            project_start_ms: 60_000,
            project_end_ms: 60_500,
            speaker_id: None,
            is_unaligned: false,
            alignment_status: "aligned".to_owned(),
        }],
    };

    let data0 = staging.prepare_promotion(rev_id, win0);
    assert_eq!(data0.word_records[0].ordinal, 1);
    assert_eq!(data0.word_records[1].ordinal, 2);

    let data1 = staging.prepare_promotion(rev_id, win1);
    assert_eq!(data1.word_records[0].ordinal, 3);
}

#[test]
fn test_stress_out_of_order_window_completions_3_1_0_2() {
    let staging = StagingBuffer::new();
    let rev_id = TranscriptRevisionId::new();

    let make_word = |text: &str, start_ms: i64, end_ms: i64| ProjectedWordResult {
        status: WordProjectionStatus::Accepted,
        text: text.to_owned(),
        raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
        raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
        project_start_ms: start_ms,
        project_end_ms: end_ms,
        speaker_id: Some("speaker_0".to_owned()),
        is_unaligned: false,
        alignment_status: "aligned".to_owned(),
    };

    // Window 0: 3 words
    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![
            make_word("the", 0, 500),
            make_word("quick", 500, 1000),
            make_word("brown", 1000, 1500),
        ],
    };

    // Window 1: 2 words
    let win1 = StagedWindowResult {
        window_index: 1,
        window: WindowRange::new(1, 60_000, 120_000),
        words: vec![
            make_word("fox", 60_000, 60_500),
            make_word("jumps", 60_500, 61_000),
        ],
    };

    // Window 2: 4 words
    let win2 = StagedWindowResult {
        window_index: 2,
        window: WindowRange::new(2, 120_000, 180_000),
        words: vec![
            make_word("over", 120_000, 120_500),
            make_word("the", 120_500, 121_000),
            make_word("lazy", 121_000, 121_500),
            make_word("dog", 121_500, 122_000),
        ],
    };

    // Window 3: 1 word
    let win3 = StagedWindowResult {
        window_index: 3,
        window: WindowRange::new(3, 180_000, 240_000),
        words: vec![make_word("again", 180_000, 180_500)],
    };

    // Arrival sequence: 3, 1, 0, 2
    staging.insert(win3);
    assert!(staging.pop_promotable().is_none());

    staging.insert(win1);
    assert!(staging.pop_promotable().is_none());

    staging.insert(win0);
    // Window 0 should be popped first
    let popped0 = staging.pop_promotable().expect("window 0 ready");
    assert_eq!(popped0.window_index, 0);
    let data0 = staging.prepare_promotion(rev_id, popped0);
    assert_eq!(data0.word_records.len(), 3);
    assert_eq!(data0.word_records[0].ordinal, 1);
    assert_eq!(data0.word_records[1].ordinal, 2);
    assert_eq!(data0.word_records[2].ordinal, 3);

    // Window 1 should be popped next
    let popped1 = staging.pop_promotable().expect("window 1 ready");
    assert_eq!(popped1.window_index, 1);
    let data1 = staging.prepare_promotion(rev_id, popped1);
    assert_eq!(data1.word_records.len(), 2);
    assert_eq!(data1.word_records[0].ordinal, 4);
    assert_eq!(data1.word_records[1].ordinal, 5);

    // Window 2 hasn't arrived yet, so pop_promotable must return None even though window 3 is in buffer
    assert!(staging.pop_promotable().is_none());

    // Now Window 2 arrives
    staging.insert(win2);

    // Window 2 popped
    let popped2 = staging.pop_promotable().expect("window 2 ready");
    assert_eq!(popped2.window_index, 2);
    let data2 = staging.prepare_promotion(rev_id, popped2);
    assert_eq!(data2.word_records.len(), 4);
    assert_eq!(data2.word_records[0].ordinal, 6);
    assert_eq!(data2.word_records[1].ordinal, 7);
    assert_eq!(data2.word_records[2].ordinal, 8);
    assert_eq!(data2.word_records[3].ordinal, 9);

    // Window 3 popped
    let popped3 = staging.pop_promotable().expect("window 3 ready");
    assert_eq!(popped3.window_index, 3);
    let data3 = staging.prepare_promotion(rev_id, popped3);
    assert_eq!(data3.word_records.len(), 1);
    assert_eq!(data3.word_records[0].ordinal, 10);

    // Buffer is completely drained
    assert!(staging.pop_promotable().is_none());

    // Collect all ordinals and verify strictly contiguous 1..10
    let mut all_ordinals: Vec<u32> = Vec::new();
    for data in [&data0, &data1, &data2, &data3] {
        for record in &data.word_records {
            all_ordinals.push(record.ordinal);
        }
    }
    assert_eq!(all_ordinals, vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
}

#[test]
fn test_stress_empty_windows_interleaved_out_of_order() {
    let staging = StagingBuffer::new();
    let rev_id = TranscriptRevisionId::new();

    let make_word = |text: &str, start_ms: i64, end_ms: i64| ProjectedWordResult {
        status: WordProjectionStatus::Accepted,
        text: text.to_owned(),
        raw_start_ns: (start_ms * 1_000_000).cast_unsigned(),
        raw_end_ns: (end_ms * 1_000_000).cast_unsigned(),
        project_start_ms: start_ms,
        project_end_ms: end_ms,
        speaker_id: None,
        is_unaligned: false,
        alignment_status: "aligned".to_owned(),
    };

    // Window 0: 2 words
    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![make_word("w0_a", 0, 500), make_word("w0_b", 500, 1000)],
    };

    // Window 1: EMPTY (0 words)
    let win1 = StagedWindowResult {
        window_index: 1,
        window: WindowRange::new(1, 60_000, 120_000),
        words: vec![],
    };

    // Window 2: 3 words
    let win2 = StagedWindowResult {
        window_index: 2,
        window: WindowRange::new(2, 120_000, 180_000),
        words: vec![
            make_word("w2_a", 120_000, 120_500),
            make_word("w2_b", 120_500, 121_000),
            make_word("w2_c", 121_000, 121_500),
        ],
    };

    // Window 3: EMPTY (0 words)
    let win3 = StagedWindowResult {
        window_index: 3,
        window: WindowRange::new(3, 180_000, 240_000),
        words: vec![],
    };

    // Window 4: 1 word
    let win4 = StagedWindowResult {
        window_index: 4,
        window: WindowRange::new(4, 240_000, 300_000),
        words: vec![make_word("w4_a", 240_000, 240_500)],
    };

    // Arrival order: 3, 1, 4, 0, 2
    staging.insert(win3);
    staging.insert(win1);
    staging.insert(win4);
    assert!(staging.pop_promotable().is_none());

    staging.insert(win0);
    let p0 = staging.pop_promotable().unwrap();
    assert_eq!(p0.window_index, 0);
    let d0 = staging.prepare_promotion(rev_id, p0);
    assert_eq!(d0.word_records.len(), 2);
    assert_eq!(d0.word_records[0].ordinal, 1);
    assert_eq!(d0.word_records[1].ordinal, 2);

    // Window 1 was already inserted, so it pops immediately
    let p1 = staging.pop_promotable().unwrap();
    assert_eq!(p1.window_index, 1);
    let d1 = staging.prepare_promotion(rev_id, p1);
    assert!(d1.word_records.is_empty());

    // Window 2 not yet inserted, pop returns None
    assert!(staging.pop_promotable().is_none());

    staging.insert(win2);
    let p2 = staging.pop_promotable().unwrap();
    assert_eq!(p2.window_index, 2);
    let d2 = staging.prepare_promotion(rev_id, p2);
    assert_eq!(d2.word_records.len(), 3);
    assert_eq!(d2.word_records[0].ordinal, 3);
    assert_eq!(d2.word_records[1].ordinal, 4);
    assert_eq!(d2.word_records[2].ordinal, 5);

    // Window 3 pops immediately (empty)
    let p3 = staging.pop_promotable().unwrap();
    assert_eq!(p3.window_index, 3);
    let d3 = staging.prepare_promotion(rev_id, p3);
    assert!(d3.word_records.is_empty());

    // Window 4 pops immediately
    let p4 = staging.pop_promotable().unwrap();
    assert_eq!(p4.window_index, 4);
    let d4 = staging.prepare_promotion(rev_id, p4);
    assert_eq!(d4.word_records.len(), 1);
    assert_eq!(d4.word_records[0].ordinal, 6);

    let mut ordinals = Vec::new();
    for d in [&d0, &d1, &d2, &d3, &d4] {
        for r in &d.word_records {
            ordinals.push(r.ordinal);
        }
    }
    // Strictly contiguous 1..6 despite empty windows
    assert_eq!(ordinals, vec![1, 2, 3, 4, 5, 6]);
}
