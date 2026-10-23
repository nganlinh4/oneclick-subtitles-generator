use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use super::live::{
    live_attempt_is_sparse, live_word_is_owned, prefer_more_complete_live_attempt,
    project_live_utterance,
};
use super::*;
use crate::transcription::planner::WindowRange;
use crate::transcription::projection::{ProjectedWordResult, WordProjectionStatus};
use crate::transcription::staging::StagedWindowResult;

fn pcm_wav(samples: &[u8]) -> Vec<u8> {
    let mut wav = Vec::with_capacity(44 + samples.len());
    let sample_bytes = u32::try_from(samples.len()).expect("test WAV length fits u32");
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36_u32 + sample_bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt \x10\0\0\0\x01\0\x01\0");
    wav.extend_from_slice(&16_000_u32.to_le_bytes());
    wav.extend_from_slice(&32_000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&sample_bytes.to_le_bytes());
    wav.extend_from_slice(samples);
    wav
}

#[test]
fn live_overlap_context_never_owns_duplicate_boundary_words() {
    let word = |start, end| ProjectedWordResult {
        status: WordProjectionStatus::Interpolated,
        text: "boundary".to_owned(),
        raw_start_ns: 0,
        raw_end_ns: 1,
        project_start_ms: start,
        project_end_ms: end,
        speaker_id: None,
        is_unaligned: true,
        alignment_status: "unaligned".to_owned(),
    };
    let left = WindowRange::new(0, 0, 57_000);
    let mut right = WindowRange::new(1, 57_000, 114_000);
    right.context_start_ms = 54_000;
    assert!(live_word_is_owned(&word(56_900, 57_100), &right));
    assert!(!live_word_is_owned(&word(56_000, 56_900), &right));
    assert!(!live_word_is_owned(&word(57_000, 57_100), &left));
}

#[test]
fn sparse_live_attempts_retry_and_keep_the_more_complete_result() {
    let window = WindowRange::new(3, 0, 60_000);
    let result = |count| StagedWindowResult {
        window_index: window.index,
        window,
        words: (0_usize..count)
            .map(|ordinal| ProjectedWordResult {
                status: WordProjectionStatus::Interpolated,
                text: format!("w{ordinal}"),
                raw_start_ns: u64::try_from(ordinal).unwrap(),
                raw_end_ns: u64::try_from(ordinal).unwrap() + 1,
                project_start_ms: i64::try_from(ordinal).unwrap(),
                project_end_ms: i64::try_from(ordinal).unwrap() + 1,
                speaker_id: None,
                is_unaligned: true,
                alignment_status: "unaligned".to_owned(),
            })
            .collect(),
    };
    assert!(live_attempt_is_sparse(&result(59)));
    assert!(!live_attempt_is_sparse(&result(60)));
    assert_eq!(
        prefer_more_complete_live_attempt(result(11), result(47))
            .words
            .len(),
        47
    );
    assert_eq!(
        prefer_more_complete_live_attempt(result(47), result(11))
            .words
            .len(),
        47
    );
}

#[test]
fn output_limit_retry_splits_pcm_wav_without_losing_samples() {
    let source = pcm_wav(&[0, 1, 2, 3, 4, 5, 6, 7]);
    let (left, right) = split_pcm_wav(&source).expect("split");
    assert_eq!(&left[44..], &[0, 1, 2, 3]);
    assert_eq!(&right[44..], &[4, 5, 6, 7]);
    assert_eq!(u32::from_le_bytes(left[4..8].try_into().unwrap()), 40);
    assert_eq!(u32::from_le_bytes(left[40..44].try_into().unwrap()), 4);
    assert_eq!(u32::from_le_bytes(right[4..8].try_into().unwrap()), 40);
    assert_eq!(u32::from_le_bytes(right[40..44].try_into().unwrap()), 4);
}

#[tokio::test]
async fn test_worker_pool_bounded_concurrency() {
    let pool = WorkerPool::new(2);
    let cancel = CancellationToken::new();

    // Should acquire permit 1 and 2
    let permit1 = pool.acquire_permit(&cancel).await.expect("permit 1");
    let permit2 = pool.acquire_permit(&cancel).await.expect("permit 2");

    // 3rd permit attempt must block
    let pool_clone = pool.clone();
    let cancel_clone = cancel.clone();
    let mut acquire_task =
        tokio::spawn(async move { pool_clone.acquire_permit(&cancel_clone).await });

    // Verify task is waiting (does not complete within 50ms)
    tokio::select! {
        _ = &mut acquire_task => panic!("3rd permit should not be acquired while 2 permits held"),
        () = tokio::time::sleep(Duration::from_millis(50)) => {}
    }

    // Drop permit 1
    drop(permit1);

    // Now acquire_task should immediately succeed
    let permit3 = acquire_task.await.expect("task join").expect("permit 3");
    drop(permit2);
    drop(permit3);
}

#[test]
fn live_utterance_is_split_into_monotonic_words_for_subtitle_grouping() {
    let words = project_live_utterance("one longer three", 1_000, 4_000, 60_000);
    assert_eq!(
        words
            .iter()
            .map(|word| word.text.as_str())
            .collect::<Vec<_>>(),
        ["one", "longer", "three"]
    );
    assert_eq!(words.first().unwrap().project_start_ms, 61_000);
    assert_eq!(words.last().unwrap().project_end_ms, 64_000);
    assert!(
        words
            .windows(2)
            .all(|pair| pair[0].project_end_ms <= pair[1].project_start_ms)
    );
    assert!(
        words
            .iter()
            .all(|word| word.status == WordProjectionStatus::Interpolated
                && word.alignment_status == "unaligned"
                && word.is_unaligned)
    );
}

#[tokio::test]
async fn test_worker_pool_cancellation_while_waiting() {
    let pool = WorkerPool::new(2);
    let cancel = CancellationToken::new();

    let _permit1 = pool.acquire_permit(&cancel).await.expect("permit 1");
    let _permit2 = pool.acquire_permit(&cancel).await.expect("permit 2");

    let wait_cancel = CancellationToken::new();
    let pool_clone = pool.clone();
    let cancel_for_task = wait_cancel.clone();

    let acquire_task =
        tokio::spawn(async move { pool_clone.acquire_permit(&cancel_for_task).await });

    // Cancel while waiting
    tokio::time::sleep(Duration::from_millis(20)).await;
    wait_cancel.cancel();

    let res = acquire_task.await.expect("task join");
    assert!(matches!(res, Err(WorkerError::Cancelled)));
}

#[tokio::test]
async fn test_worker_pool_pre_cancelled_deterministic() {
    let pool = WorkerPool::new(2);
    let cancel = CancellationToken::new();
    cancel.cancel();

    // 100 iterations: every single acquire_permit call on a pre-cancelled token
    // MUST deterministically return Err(WorkerError::Cancelled)
    for _ in 0..100 {
        let res = pool.acquire_permit(&cancel).await;
        assert!(
            matches!(res, Err(WorkerError::Cancelled)),
            "acquire_permit must return Err(Cancelled) when token is pre-cancelled"
        );
    }
}

#[tokio::test]
async fn test_abort_on_drop_aborts_spawned_task() {
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let task = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_mins(1)).await;
        let _ = tx.send(());
    });

    {
        let _guard = AbortOnDrop::new(task);
        // Guard goes out of scope here and aborts the task on drop
    }

    tokio::time::sleep(Duration::from_millis(20)).await;
    // Oneshot channel sender was dropped when task was aborted
    assert!(rx.await.is_err(), "task should have been aborted on drop");
}

#[tokio::test]
async fn test_adversarial_permit_acquisition_pre_cancelled_exhaustive() {
    let pool = WorkerPool::new(2);

    // 1. With 2 permits available (empty pool)
    let cancel_2 = CancellationToken::new();
    cancel_2.cancel();
    for _ in 0..1_000 {
        let res = pool.acquire_permit(&cancel_2).await;
        assert!(matches!(res, Err(WorkerError::Cancelled)));
        assert_eq!(pool.semaphore.available_permits(), 2);
    }

    // 2. With 1 permit available (1 held)
    let permit1 = pool.semaphore.clone().acquire_owned().await.unwrap();
    assert_eq!(pool.semaphore.available_permits(), 1);

    let cancel_1 = CancellationToken::new();
    cancel_1.cancel();
    for _ in 0..1_000 {
        let res = pool.acquire_permit(&cancel_1).await;
        assert!(matches!(res, Err(WorkerError::Cancelled)));
        assert_eq!(pool.semaphore.available_permits(), 1);
    }

    // 3. With 0 permits available (both held, saturated pool)
    let permit2 = pool.semaphore.clone().acquire_owned().await.unwrap();
    assert_eq!(pool.semaphore.available_permits(), 0);

    let cancel_0 = CancellationToken::new();
    cancel_0.cancel();
    for _ in 0..1_000 {
        let res = pool.acquire_permit(&cancel_0).await;
        assert!(matches!(res, Err(WorkerError::Cancelled)));
        assert_eq!(pool.semaphore.available_permits(), 0);
    }

    // Release both permits: verify count returns to exactly 2
    drop(permit1);
    drop(permit2);
    assert_eq!(pool.semaphore.available_permits(), 2);
}

#[tokio::test]
async fn test_adversarial_multithreaded_pre_cancelled_race() {
    let pool = Arc::new(WorkerPool::new(2));
    let mut handles = Vec::new();

    // 16 concurrent tasks doing 500 acquires each on pre-cancelled tokens = 8,000 requests
    for _ in 0..16 {
        let p = Arc::clone(&pool);
        handles.push(tokio::spawn(async move {
            let cancel = CancellationToken::new();
            cancel.cancel();
            for _ in 0..500 {
                let res = p.acquire_permit(&cancel).await;
                assert!(matches!(res, Err(WorkerError::Cancelled)));
            }
        }));
    }

    for h in handles {
        h.await.unwrap();
    }

    // Exact permit invariant assertion: exactly 2 permits remain available, 0 leaked
    assert_eq!(pool.semaphore.available_permits(), 2);

    // Verify normal acquisition still works perfectly
    let c = CancellationToken::new();
    let p1 = pool.acquire_permit(&c).await.expect("p1");
    let p2 = pool.acquire_permit(&c).await.expect("p2");
    assert_eq!(pool.semaphore.available_permits(), 0);
    drop(p1);
    drop(p2);
    assert_eq!(pool.semaphore.available_permits(), 2);
}

#[tokio::test]
async fn test_adversarial_permit_acquisition_concurrent_cancellation_race() {
    let pool = Arc::new(WorkerPool::new(2));
    let cancel = CancellationToken::new();
    let mut handles = Vec::new();

    // Spawn 50 tasks attempting to acquire permits
    for _ in 0..50 {
        let p = Arc::clone(&pool);
        let c = cancel.clone();
        handles.push(tokio::spawn(async move {
            match p.acquire_permit(&c).await {
                Ok(permit) => {
                    // Hold permit briefly then release
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    drop(permit);
                    Ok(())
                }
                Err(WorkerError::Cancelled) => Err(()),
                Err(e) => panic!("Unexpected error: {e:?}"),
            }
        }));
    }

    // Concurrently trigger cancellation after a tiny delay
    tokio::time::sleep(Duration::from_millis(3)).await;
    cancel.cancel();

    for h in handles {
        let _ = h.await.unwrap();
    }

    // After all tasks settle, exactly 2 permits must be available (0 leaked)
    assert_eq!(pool.semaphore.available_permits(), 2);
}
