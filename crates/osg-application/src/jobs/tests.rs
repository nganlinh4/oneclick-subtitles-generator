//! Job registry tests: durable-first cancellation, sequencing, lazy lookup, and resident bounds.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;

use osg_domain::{JobKind, JobProgress, JobSnapshot, JobState, JobUpdate};
use thiserror::Error;

use super::{JobRegistry, JobRegistryError, JobStore, JobWrite, RESIDENT_TERMINAL_JOB_LIMIT};

#[derive(Debug, Default)]
struct MemoryStore {
    jobs: Mutex<HashMap<osg_domain::JobId, JobSnapshot>>,
    fail_writes: AtomicBool,
    get_calls: AtomicUsize,
    hide_jobs_from_restore: AtomicBool,
}

#[derive(Debug, Clone, Copy, Error)]
#[error("injected persistence failure")]
struct MemoryError;

impl JobStore for MemoryStore {
    type Error = MemoryError;

    fn create(&self, snapshot: &JobSnapshot) -> Result<(), Self::Error> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err(MemoryError);
        }
        self.jobs
            .lock()
            .expect("store lock")
            .insert(snapshot.id(), snapshot.clone());
        Ok(())
    }

    fn get(&self, id: osg_domain::JobId) -> Result<Option<JobSnapshot>, Self::Error> {
        self.get_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.jobs.lock().expect("store lock").get(&id).cloned())
    }

    fn list(&self) -> Result<Vec<JobSnapshot>, Self::Error> {
        if self.hide_jobs_from_restore.load(Ordering::SeqCst) {
            return Ok(Vec::new());
        }
        Ok(self
            .jobs
            .lock()
            .expect("store lock")
            .values()
            .cloned()
            .collect())
    }

    fn compare_and_swap(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
    ) -> Result<JobWrite, Self::Error> {
        if self.fail_writes.load(Ordering::SeqCst) {
            return Err(MemoryError);
        }
        let mut jobs = self.jobs.lock().expect("store lock");
        let current = jobs.get(&snapshot.id()).expect("registered job");
        if current.sequence() != expected_sequence {
            return Ok(JobWrite::Conflict(current.clone()));
        }
        jobs.insert(snapshot.id(), snapshot.clone());
        Ok(JobWrite::Updated)
    }
}

#[test]
fn cancellation_becomes_visible_only_after_the_durable_write() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(Arc::clone(&store), []).expect("registry");
    let job = registry.register(JobKind::RenderVideo).expect("job");
    let id = job.snapshot().id();
    registry.apply(id, JobUpdate::Start).expect("running");

    store.fail_writes.store(true, Ordering::SeqCst);
    assert!(matches!(
        registry.apply(id, JobUpdate::RequestCancellation),
        Err(JobRegistryError::Store(_))
    ));
    assert!(!job.cancellation().is_cancelled());
    assert_eq!(
        registry.get(id).expect("job").snapshot().state(),
        JobState::Running
    );

    store.fail_writes.store(false, Ordering::SeqCst);
    let cancelled = registry
        .apply(id, JobUpdate::RequestCancellation)
        .expect("cancellation persisted");
    assert_eq!(cancelled.snapshot().state(), JobState::Cancelling);
    assert!(job.cancellation().is_cancelled());
}

#[test]
fn sequence_guard_linearizes_cancellation_against_completion() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(store, []).expect("registry");
    let registered = registry.register(JobKind::GenerateImage).expect("job");
    let id = registered.snapshot().id();
    let running = registry.apply(id, JobUpdate::Start).expect("running");
    let completion_sequence = running.snapshot().sequence();

    let cancelling = registry
        .apply(id, JobUpdate::RequestCancellation)
        .expect("cancellation wins");
    assert_eq!(cancelling.snapshot().state(), JobState::Cancelling);
    assert!(matches!(
        registry.apply_if_sequence(id, completion_sequence, JobUpdate::Succeed),
        Err(JobRegistryError::Conflict {
            expected_sequence,
            actual_sequence,
        }) if expected_sequence == completion_sequence
            && actual_sequence == cancelling.snapshot().sequence()
    ));
    assert_eq!(
        registry.get(id).expect("unchanged job").snapshot().state(),
        JobState::Cancelling
    );

    let second = registry.register(JobKind::GenerateImage).expect("job");
    let second_id = second.snapshot().id();
    let second_running = registry
        .apply(second_id, JobUpdate::Start)
        .expect("running");
    let succeeded = registry
        .apply_if_sequence(
            second_id,
            second_running.snapshot().sequence(),
            JobUpdate::Succeed,
        )
        .expect("completion wins");
    assert_eq!(succeeded.snapshot().state(), JobState::Succeeded);
    assert!(
        registry
            .apply(second_id, JobUpdate::RequestCancellation)
            .is_err()
    );
}

#[test]
fn external_updates_are_loaded_and_reported_as_conflicts() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(Arc::clone(&store), []).expect("registry");
    let job = registry.register(JobKind::Transcribe).expect("job");
    let id = job.snapshot().id();
    registry.apply(id, JobUpdate::Start).expect("running");

    let mut external = registry.get(id).expect("job").snapshot().clone();
    external
        .report_progress(JobProgress::from_basis_points(5_000).expect("progress"))
        .expect("external progress");
    store
        .jobs
        .lock()
        .expect("store lock")
        .insert(id, external.clone());

    assert!(matches!(
        registry.apply(
            id,
            JobUpdate::ReportProgress(JobProgress::from_basis_points(1_000).expect("progress"))
        ),
        Err(JobRegistryError::Conflict {
            expected_sequence: 1,
            actual_sequence: 2
        })
    ));
    assert_eq!(registry.get(id).expect("job").snapshot(), &external);
}

#[test]
fn restored_cancellation_tokens_and_duplicate_detection_are_deterministic() {
    let store = Arc::new(MemoryStore::default());
    let mut cancelling = JobSnapshot::new(JobKind::DownloadMedia);
    cancelling.start().expect("starts");
    cancelling.request_cancellation().expect("cancels");

    let registry =
        JobRegistry::new(Arc::clone(&store), [cancelling.clone()]).expect("restored registry");
    assert!(
        registry
            .get(cancelling.id())
            .expect("job")
            .cancellation()
            .is_cancelled()
    );

    assert!(matches!(
        JobRegistry::new(store, [cancelling.clone(), cancelling]),
        Err(JobRegistryError::Duplicate(_))
    ));
}

#[test]
fn requeue_rotates_the_attempt_cancellation_token() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(store, []).expect("registry");
    let initial = registry.register(JobKind::Transcribe).expect("job");
    let id = initial.snapshot().id();
    registry.apply(id, JobUpdate::Start).expect("running");
    let cancelling = registry
        .apply(id, JobUpdate::RequestCancellation)
        .expect("cancelling");
    let old_attempt = cancelling.cancellation().clone();
    registry
        .apply(id, JobUpdate::Interrupt)
        .expect("interrupted");

    let requeued = registry.apply(id, JobUpdate::Requeue).expect("requeued");

    assert!(old_attempt.is_cancelled());
    assert!(!requeued.cancellation().is_cancelled());
    assert_eq!(requeued.snapshot().state(), JobState::Queued);
}

#[test]
fn omitted_terminal_jobs_are_loaded_lazily_by_opaque_identifier() {
    let store = Arc::new(MemoryStore::default());
    let mut terminal = JobSnapshot::new(JobKind::RenderVideo);
    terminal.start().expect("starts");
    terminal.succeed().expect("succeeds");
    store
        .jobs
        .lock()
        .expect("store lock")
        .insert(terminal.id(), terminal.clone());
    store.hide_jobs_from_restore.store(true, Ordering::SeqCst);

    let registry = JobRegistry::restore(Arc::clone(&store)).expect("bounded restore");
    assert!(registry.list().expect("initial working set").is_empty());

    assert_eq!(
        registry.get(terminal.id()).expect("lazy lookup").snapshot(),
        &terminal
    );
    assert_eq!(registry.list().expect("resident lazy job").len(), 1);
}

#[test]
fn concurrent_lazy_lookups_admit_one_consistent_resident_job() {
    let store = Arc::new(MemoryStore::default());
    let mut terminal = JobSnapshot::new(JobKind::RenderVideo);
    terminal.start().expect("starts");
    terminal.succeed().expect("succeeds");
    store
        .jobs
        .lock()
        .expect("store lock")
        .insert(terminal.id(), terminal.clone());
    store.hide_jobs_from_restore.store(true, Ordering::SeqCst);
    let registry = Arc::new(JobRegistry::restore(Arc::clone(&store)).expect("bounded restore"));
    let barrier = Arc::new(Barrier::new(3));
    let lookups = (0..2)
        .map(|_| {
            let registry = Arc::clone(&registry);
            let barrier = Arc::clone(&barrier);
            let id = terminal.id();
            thread::spawn(move || {
                barrier.wait();
                registry.get(id).expect("concurrent lazy lookup")
            })
        })
        .collect::<Vec<_>>();

    barrier.wait();
    let mut tickets = lookups
        .into_iter()
        .map(|lookup| lookup.join().expect("lookup thread"));
    let left = tickets.next().expect("first lookup");
    let right = tickets.next().expect("second lookup");

    assert_eq!(left.snapshot(), right.snapshot());
    assert_eq!(left.cancellation(), right.cancellation());
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 1);
    assert_eq!(registry.list().expect("one resident job").len(), 1);
}

#[test]
fn long_running_registry_bounds_terminal_memory_without_deleting_durable_jobs() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(Arc::clone(&store), []).expect("registry");
    let mut oldest = None;
    for index in 0..(RESIDENT_TERMINAL_JOB_LIMIT + 17) {
        let registered = registry
            .register(JobKind::RenderVideo)
            .expect("register job");
        let id = registered.snapshot().id();
        if index == 0 {
            oldest = Some(id);
        }
        registry.apply(id, JobUpdate::Start).expect("start job");
        registry.apply(id, JobUpdate::Succeed).expect("finish job");
    }
    let oldest = oldest.expect("oldest terminal job");

    let resident = registry.list().expect("bounded resident jobs");
    assert_eq!(resident.len(), RESIDENT_TERMINAL_JOB_LIMIT);
    assert!(
        !resident
            .iter()
            .any(|ticket| ticket.snapshot().id() == oldest)
    );
    assert_eq!(
        store.jobs.lock().expect("store lock").len(),
        RESIDENT_TERMINAL_JOB_LIMIT + 17
    );

    assert_eq!(
        registry
            .get(oldest)
            .expect("lazy durable lookup")
            .snapshot()
            .id(),
        oldest
    );
    assert_eq!(store.get_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        registry
            .list()
            .expect("still bounded after lazy lookup")
            .len(),
        RESIDENT_TERMINAL_JOB_LIMIT
    );
}

#[test]
fn compaction_never_evicts_a_terminal_job_held_by_concurrent_work() {
    let store = Arc::new(MemoryStore::default());
    let registry = JobRegistry::new(store, []).expect("registry");
    let mut ids = Vec::new();
    for _ in 0..RESIDENT_TERMINAL_JOB_LIMIT {
        let registered = registry
            .register(JobKind::RenderVideo)
            .expect("register job");
        let id = registered.snapshot().id();
        registry.apply(id, JobUpdate::Start).expect("start job");
        registry.apply(id, JobUpdate::Succeed).expect("finish job");
        ids.push(id);
    }
    let held_id = ids[0];
    let next_oldest = ids[1];
    let held = registry.lookup(held_id).expect("hold managed job");

    let extra = registry
        .register(JobKind::RenderVideo)
        .expect("register extra job");
    let extra_id = extra.snapshot().id();
    registry
        .apply(extra_id, JobUpdate::Start)
        .expect("start extra job");
    registry
        .apply(extra_id, JobUpdate::Succeed)
        .expect("finish extra job");
    let while_held = registry.list().expect("compact around held job");
    assert_eq!(while_held.len(), RESIDENT_TERMINAL_JOB_LIMIT);
    assert!(
        while_held
            .iter()
            .any(|ticket| ticket.snapshot().id() == held_id)
    );
    assert!(
        !while_held
            .iter()
            .any(|ticket| ticket.snapshot().id() == next_oldest)
    );
    drop(held);

    let later = registry
        .register(JobKind::RenderVideo)
        .expect("register later job");
    let later_id = later.snapshot().id();
    registry
        .apply(later_id, JobUpdate::Start)
        .expect("start later job");
    registry
        .apply(later_id, JobUpdate::Succeed)
        .expect("finish later job");
    let after_release = registry.list().expect("compact released job");
    assert_eq!(after_release.len(), RESIDENT_TERMINAL_JOB_LIMIT);
    assert!(
        !after_release
            .iter()
            .any(|ticket| ticket.snapshot().id() == held_id)
    );
}
