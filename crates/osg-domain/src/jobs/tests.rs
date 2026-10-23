//! Job lifecycle tests: progress bounds, the transition table, sequencing, and persistence.

use super::{
    JOB_PROGRESS_COMPLETE, JobError, JobKind, JobMutation, JobProgress, JobProgressError,
    JobSnapshot, JobState, JobUpdate,
};

fn progress(basis_points: u16) -> JobProgress {
    JobProgress::from_basis_points(basis_points).expect("bounded progress")
}

#[test]
fn progress_rejects_every_boundary_failure() {
    assert_eq!(
        JobProgress::from_basis_points(JOB_PROGRESS_COMPLETE + 1),
        Err(JobProgressError::OutOfRange {
            basis_points: JOB_PROGRESS_COMPLETE + 1
        })
    );
    assert_eq!(
        JobProgress::from_units(0, 0),
        Err(JobProgressError::ZeroTotal)
    );
    assert_eq!(
        JobProgress::from_units(11, 10),
        Err(JobProgressError::CompletedExceedsTotal {
            completed: 11,
            total: 10
        })
    );
    assert!(serde_json::from_str::<JobProgress>(r#"{"basisPoints":10001}"#).is_err());
}

#[test]
fn unit_progress_is_bounded_without_integer_overflow() {
    let cases = [
        (0, 1, 0),
        (1, 3, 3_333),
        (1, 2, 5_000),
        (3, 3, 10_000),
        (u64::MAX - 1, u64::MAX, 9_999),
        (u64::MAX, u64::MAX, 10_000),
    ];

    for (completed, total, expected) in cases {
        assert_eq!(
            JobProgress::from_units(completed, total)
                .expect("valid unit ratio")
                .basis_points(),
            expected
        );
    }
}

#[test]
fn legal_lifecycle_is_monotonic_and_completes_progress() {
    let mut job = JobSnapshot::new(JobKind::Transcribe);
    assert_eq!(job.sequence(), 0);
    assert_eq!(job.start(), Ok(JobMutation::Changed));
    assert_eq!(job.sequence(), 1);
    assert_eq!(
        job.report_progress(progress(4_200)),
        Ok(JobMutation::Changed)
    );
    assert_eq!(job.sequence(), 2);
    assert_eq!(job.succeed(), Ok(JobMutation::Changed));
    assert_eq!(job.sequence(), 3);
    assert_eq!(job.state(), JobState::Succeeded);
    assert_eq!(job.progress(), JobProgress::COMPLETE);
}

#[test]
fn transition_table_accepts_only_documented_edges() {
    let states = [
        JobState::Queued,
        JobState::Running,
        JobState::Cancelling,
        JobState::Succeeded,
        JobState::Failed,
        JobState::Cancelled,
        JobState::Interrupted,
    ];
    let updates = [
        JobUpdate::Start,
        JobUpdate::Succeed,
        JobUpdate::Fail,
        JobUpdate::RequestCancellation,
        JobUpdate::ConfirmCancelled,
        JobUpdate::Interrupt,
        JobUpdate::Requeue,
    ];

    for state in states {
        for update in updates {
            let sequence = match state {
                JobState::Queued => 0,
                JobState::Succeeded => 2,
                JobState::Running
                | JobState::Cancelling
                | JobState::Failed
                | JobState::Cancelled
                | JobState::Interrupted => 1,
            };
            let snapshot_progress = if state == JobState::Succeeded {
                JobProgress::COMPLETE
            } else {
                JobProgress::ZERO
            };
            let mut job = JobSnapshot::restore(
                crate::JobId::new(),
                JobKind::ProbeMedia,
                state,
                snapshot_progress,
                sequence,
            )
            .expect("valid fixture");

            let expected_success = matches!(
                (state, update),
                (
                    JobState::Queued,
                    JobUpdate::Start | JobUpdate::Fail | JobUpdate::RequestCancellation
                ) | (
                    JobState::Running,
                    JobUpdate::Succeed
                        | JobUpdate::Fail
                        | JobUpdate::RequestCancellation
                        | JobUpdate::Interrupt
                ) | (
                    JobState::Cancelling,
                    JobUpdate::Succeed
                        | JobUpdate::Fail
                        | JobUpdate::RequestCancellation
                        | JobUpdate::ConfirmCancelled
                        | JobUpdate::Interrupt
                ) | (
                    JobState::Cancelled,
                    JobUpdate::RequestCancellation | JobUpdate::ConfirmCancelled
                ) | (
                    JobState::Interrupted,
                    JobUpdate::Interrupt | JobUpdate::Requeue
                )
            );
            assert_eq!(
                job.apply(update).is_ok(),
                expected_success,
                "{state:?} + {update:?}"
            );
        }
    }
}

#[test]
fn progress_is_running_only_monotonic_and_retry_idempotent() {
    let mut job = JobSnapshot::new(JobKind::GenerateWaveform);
    assert!(matches!(
        job.report_progress(progress(1)),
        Err(JobError::InvalidTransition { .. })
    ));

    job.start().expect("job starts");
    job.report_progress(progress(5_000))
        .expect("progress advances");
    let sequence = job.sequence();
    assert_eq!(
        job.report_progress(progress(5_000)),
        Ok(JobMutation::Unchanged)
    );
    assert_eq!(job.sequence(), sequence);
    assert!(matches!(
        job.report_progress(progress(4_999)),
        Err(JobError::ProgressRegression { .. })
    ));
    assert_eq!(job.progress(), progress(5_000));
    assert_eq!(job.sequence(), sequence);
}

#[test]
fn cancellation_is_acknowledged_and_idempotent_without_overwriting_a_result() {
    let mut queued = JobSnapshot::new(JobKind::DownloadMedia);
    assert_eq!(queued.request_cancellation(), Ok(JobMutation::Changed));
    assert_eq!(queued.state(), JobState::Cancelled);
    assert_eq!(queued.request_cancellation(), Ok(JobMutation::Unchanged));

    let mut running = JobSnapshot::new(JobKind::DownloadMedia);
    running.start().expect("job starts");
    assert_eq!(running.request_cancellation(), Ok(JobMutation::Changed));
    assert_eq!(running.state(), JobState::Cancelling);
    let cancelling_sequence = running.sequence();
    assert_eq!(running.request_cancellation(), Ok(JobMutation::Unchanged));
    assert_eq!(running.sequence(), cancelling_sequence);
    assert_eq!(running.confirm_cancelled(), Ok(JobMutation::Changed));
    assert_eq!(running.state(), JobState::Cancelled);
    assert_eq!(running.confirm_cancelled(), Ok(JobMutation::Unchanged));

    for terminal_update in [JobUpdate::Succeed, JobUpdate::Fail] {
        let mut job = JobSnapshot::new(JobKind::RenderVideo);
        job.start().expect("job starts");
        job.apply(terminal_update).expect("job terminates");
        let snapshot = job.clone();
        assert!(matches!(
            job.request_cancellation(),
            Err(JobError::TerminalState { .. })
        ));
        assert_eq!(job, snapshot);
    }
}

#[test]
fn committed_success_can_win_a_cancellation_race() {
    let mut job = JobSnapshot::new(JobKind::RenderVideo);
    job.start().expect("job starts");
    job.request_cancellation().expect("cancellation requested");

    job.succeed().expect("artifact commit already won");

    assert_eq!(job.state(), JobState::Succeeded);
    assert_eq!(job.progress(), JobProgress::COMPLETE);
    assert!(matches!(
        job.confirm_cancelled(),
        Err(JobError::TerminalState { .. })
    ));
}

#[test]
fn interrupted_jobs_can_be_requeued_with_fresh_progress() {
    let mut job = JobSnapshot::new(JobKind::Transcribe);
    job.start().expect("job starts");
    job.report_progress(progress(4_200)).expect("job advances");
    job.interrupt().expect("restart interrupts job");
    let interrupted_sequence = job.sequence();

    job.requeue().expect("resumable job is queued");

    assert_eq!(job.state(), JobState::Queued);
    assert_eq!(job.progress(), JobProgress::ZERO);
    assert_eq!(job.sequence(), interrupted_sequence + 1);
    job.start().expect("requeued job starts");
}

#[test]
fn optimistic_sequence_rejects_stale_writers_without_mutation() {
    let mut job = JobSnapshot::new(JobKind::Translate);
    job.start().expect("job starts");
    let snapshot = job.clone();

    assert_eq!(
        job.apply_if_sequence(0, JobUpdate::ReportProgress(progress(10))),
        Err(JobError::StaleSequence {
            expected: 0,
            actual: 1
        })
    );
    assert_eq!(job, snapshot);
}

#[test]
fn sequence_overflow_is_atomic() {
    let mut job = JobSnapshot::restore(
        crate::JobId::new(),
        JobKind::InstallEngine,
        JobState::Running,
        progress(20),
        u64::MAX,
    )
    .expect("restorable fixture");
    let snapshot = job.clone();

    assert_eq!(
        job.report_progress(progress(21)),
        Err(JobError::SequenceExhausted)
    );
    assert_eq!(job, snapshot);
}

#[test]
fn persisted_snapshots_are_validated_and_round_trip() {
    let mut job = JobSnapshot::new(JobKind::AlignNarration);
    job.start().expect("job starts");
    job.report_progress(progress(7_500))
        .expect("progress advances");
    let encoded = serde_json::to_string(&job).expect("serializable snapshot");
    let decoded: JobSnapshot = serde_json::from_str(&encoded).expect("valid snapshot");
    assert_eq!(decoded, job);

    let invalid_cases = [
        (JobState::Queued, 1, 0),
        (JobState::Running, 0, 0),
        (JobState::Cancelling, 0, 0),
        (JobState::Succeeded, 10_000, 1),
        (JobState::Succeeded, 9_999, 2),
        (JobState::Failed, 0, 0),
        (JobState::Cancelled, 0, 0),
        (JobState::Interrupted, 0, 0),
    ];
    for (state, basis_points, sequence) in invalid_cases {
        assert!(
            JobSnapshot::restore(
                crate::JobId::new(),
                JobKind::ImportMedia,
                state,
                progress(basis_points),
                sequence
            )
            .is_err(),
            "accepted {state:?}, {basis_points}, {sequence}"
        );
    }
}
