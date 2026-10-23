//! Failed-window skipping, including adversarial orderings and threads.

use super::*;

#[test]
fn test_skip_failed_window_out_of_order_promotes_subsequent() {
    let staging = StagingBuffer::new();

    // Window 0 is actively processing (next_promote_index is 0).
    assert_eq!(staging.next_promote_index(), 0);

    // Window 1 fails out-of-order in parallel worker:
    let skipped = staging.skip_failed_window(1);
    assert!(
        skipped,
        "skip_failed_window(1) must return true and register failure"
    );
    assert!(staging.is_window_failed(1));

    // next_promote_index remains 0 because Window 0 hasn't completed or failed yet
    assert_eq!(staging.next_promote_index(), 0);

    // Window 0 arrives
    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![],
    };
    staging.insert(win0);

    // Window 2 arrives (completed sister window)
    let win2 = StagedWindowResult {
        window_index: 2,
        window: WindowRange::new(2, 120_000, 180_000),
        words: vec![],
    };
    staging.insert(win2);

    // Window 0 is popped
    let popped0 = staging.pop_promotable().expect("window 0 popped");
    assert_eq!(popped0.window_index, 0);

    // Now pop_promotable() is called:
    // Staging buffer encounters failed window 1, automatically advances
    // next_promote_index past 1, and immediately returns window 2!
    let popped2 = staging
        .pop_promotable()
        .expect("window 2 popped past failed window 1");
    assert_eq!(popped2.window_index, 2);

    // Staging buffer is now drained
    assert!(staging.pop_promotable().is_none());
    assert_eq!(staging.next_promote_index(), 3);
}

#[test]
fn test_skip_failed_window_multiple_out_of_order_contiguous_ordinals() {
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

    let win0 = StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![make_word("first", 0, 500)],
    };
    let win2 = StagedWindowResult {
        window_index: 2,
        window: WindowRange::new(2, 120_000, 180_000),
        words: vec![make_word("second", 120_000, 120_500)],
    };
    let win4 = StagedWindowResult {
        window_index: 4,
        window: WindowRange::new(4, 240_000, 300_000),
        words: vec![make_word("third", 240_000, 240_500)],
    };

    // Out-of-order failures: window 3 fails first, then window 1 fails
    assert!(staging.skip_failed_window(3));
    assert!(staging.skip_failed_window(1));

    // Completions arrive in scrambled order: 4, 0, 2
    staging.insert(win4);
    staging.insert(win0);
    staging.insert(win2);

    // Popping order must strictly be 0, 2, 4
    let p0 = staging.pop_promotable().expect("window 0 ready");
    assert_eq!(p0.window_index, 0);
    let d0 = staging.prepare_promotion(rev_id, p0);
    assert_eq!(d0.word_records[0].ordinal, 1);

    let p2 = staging
        .pop_promotable()
        .expect("window 2 ready past failed 1");
    assert_eq!(p2.window_index, 2);
    let d2 = staging.prepare_promotion(rev_id, p2);
    assert_eq!(d2.word_records[0].ordinal, 2);

    let p4 = staging
        .pop_promotable()
        .expect("window 4 ready past failed 3");
    assert_eq!(p4.window_index, 4);
    let d4 = staging.prepare_promotion(rev_id, p4);
    assert_eq!(d4.word_records[0].ordinal, 3);

    assert!(staging.pop_promotable().is_none());
    assert_eq!(staging.next_promote_index(), 5);
    assert_eq!(staging.failed_indices_count(), 2);
}

#[test]
fn test_skip_failed_window_head_of_line_failure() {
    let staging = StagingBuffer::new();

    let win1 = StagedWindowResult {
        window_index: 1,
        window: WindowRange::new(1, 60_000, 120_000),
        words: vec![],
    };

    // Window 0 permanently fails
    assert!(staging.skip_failed_window(0));

    // Window 1 arrives
    staging.insert(win1);

    // pop_promotable advances past 0 and returns Window 1
    let popped = staging
        .pop_promotable()
        .expect("window 1 ready past failed window 0");
    assert_eq!(popped.window_index, 1);
    assert_eq!(staging.next_promote_index(), 2);
    assert!(staging.pop_promotable().is_none());
}

#[test]
#[allow(
    clippy::too_many_lines,
    reason = "the 24-order adversarial fixture keeps each independently failing window visible"
)]
fn test_adversarial_all_24_permutations_windows_1_and_3_fail_0_and_2_succeed() {
    let rev_id = TranscriptRevisionId::new();

    let create_win0 = || StagedWindowResult {
        window_index: 0,
        window: WindowRange::new(0, 0, 60_000),
        words: vec![
            make_test_word("w0_a", 0, 500),
            make_test_word("w0_b", 500, 1000),
            make_test_word("w0_c", 1000, 1500),
        ],
    };
    let create_win2 = || StagedWindowResult {
        window_index: 2,
        window: WindowRange::new(2, 120_000, 180_000),
        words: vec![
            make_test_word("w2_a", 120_000, 120_500),
            make_test_word("w2_b", 120_500, 121_000),
        ],
    };

    let permutations = generate_permutations(&[0, 1, 2, 3]);
    assert_eq!(permutations.len(), 24);

    // Test Phase A: Batch drain after all events are processed in each permutation
    for perm in &permutations {
        let staging = StagingBuffer::new();
        for &event in perm {
            match event {
                0 => staging.insert(create_win0()),
                1 => {
                    staging.skip_failed_window(1);
                }
                2 => staging.insert(create_win2()),
                3 => {
                    staging.skip_failed_window(3);
                }
                _ => unreachable!(),
            }
        }

        let mut popped = Vec::new();
        while let Some(w) = staging.pop_promotable() {
            popped.push(w);
        }

        assert_eq!(
            popped.len(),
            2,
            "Permutation {perm:?} must yield exactly 2 windows"
        );
        assert_eq!(
            popped[0].window_index, 0,
            "Window 0 must be first in {perm:?}"
        );
        assert_eq!(
            popped[1].window_index, 2,
            "Window 2 must be second in {perm:?}"
        );

        let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
        let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

        assert_eq!(d0.word_records.len(), 3);
        assert_eq!(
            d0.word_records
                .iter()
                .map(|w| w.ordinal)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );

        assert_eq!(d2.word_records.len(), 2);
        assert_eq!(
            d2.word_records
                .iter()
                .map(|w| w.ordinal)
                .collect::<Vec<_>>(),
            vec![4, 5]
        );

        let all_ordinals: Vec<u32> = d0
            .word_records
            .iter()
            .chain(d2.word_records.iter())
            .map(|w| w.ordinal)
            .collect();
        assert_eq!(
            all_ordinals,
            vec![1, 2, 3, 4, 5],
            "Ordinals must be contiguous 1..5 in {perm:?}"
        );

        assert_eq!(staging.next_promote_index(), 4);
        assert_eq!(staging.failed_indices_count(), 2);
        assert!(staging.is_window_failed(1));
        assert!(staging.is_window_failed(3));
    }

    // Test Phase B: Interleaved drain between events in each permutation
    for perm in &permutations {
        let staging = StagingBuffer::new();
        let mut popped = Vec::new();

        for &event in perm {
            match event {
                0 => staging.insert(create_win0()),
                1 => {
                    staging.skip_failed_window(1);
                }
                2 => staging.insert(create_win2()),
                3 => {
                    staging.skip_failed_window(3);
                }
                _ => unreachable!(),
            }
            while let Some(w) = staging.pop_promotable() {
                popped.push(w);
            }
        }

        assert_eq!(
            popped.len(),
            2,
            "Interleaved {perm:?} must yield exactly 2 windows"
        );
        assert_eq!(popped[0].window_index, 0);
        assert_eq!(popped[1].window_index, 2);

        let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
        let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

        let all_ordinals: Vec<u32> = d0
            .word_records
            .iter()
            .chain(d2.word_records.iter())
            .map(|w| w.ordinal)
            .collect();
        assert_eq!(all_ordinals, vec![1, 2, 3, 4, 5]);
        assert_eq!(staging.next_promote_index(), 4);
    }
}

#[test]
fn test_adversarial_multithreaded_out_of_order_windows_1_and_3_fail_0_and_2_succeed() {
    use std::sync::Arc;
    let rev_id = TranscriptRevisionId::new();

    for _ in 0..200 {
        let staging = Arc::new(StagingBuffer::new());

        let s0 = Arc::clone(&staging);
        let h0 = std::thread::spawn(move || {
            let win0 = StagedWindowResult {
                window_index: 0,
                window: WindowRange::new(0, 0, 60_000),
                words: vec![make_test_word("a", 0, 500), make_test_word("b", 500, 1000)],
            };
            s0.insert(win0);
        });

        let s1 = Arc::clone(&staging);
        let h1 = std::thread::spawn(move || {
            s1.skip_failed_window(1);
        });

        let s2 = Arc::clone(&staging);
        let h2 = std::thread::spawn(move || {
            let win2 = StagedWindowResult {
                window_index: 2,
                window: WindowRange::new(2, 120_000, 180_000),
                words: vec![
                    make_test_word("c", 120_000, 120_500),
                    make_test_word("d", 120_500, 121_000),
                    make_test_word("e", 121_000, 121_500),
                ],
            };
            s2.insert(win2);
        });

        let s3 = Arc::clone(&staging);
        let h3 = std::thread::spawn(move || {
            s3.skip_failed_window(3);
        });

        h0.join().unwrap();
        h1.join().unwrap();
        h2.join().unwrap();
        h3.join().unwrap();

        let mut popped = Vec::new();
        while let Some(w) = staging.pop_promotable() {
            popped.push(w);
        }

        assert_eq!(popped.len(), 2);
        assert_eq!(popped[0].window_index, 0);
        assert_eq!(popped[1].window_index, 2);

        let d0 = staging.prepare_promotion(rev_id, popped.remove(0));
        let d2 = staging.prepare_promotion(rev_id, popped.remove(0));

        let ordinals: Vec<u32> = d0
            .word_records
            .iter()
            .chain(d2.word_records.iter())
            .map(|w| w.ordinal)
            .collect();
        assert_eq!(ordinals, vec![1, 2, 3, 4, 5]);
        assert_eq!(staging.next_promote_index(), 4);
    }
}
