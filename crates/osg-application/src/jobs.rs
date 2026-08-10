use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, RwLock};

use osg_domain::{JobError, JobId, JobKind, JobMutation, JobSnapshot, JobUpdate};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

/// Maximum terminal snapshots retained in a registry's resident working set. Durable rows remain
/// in the store and are loaded on demand by opaque identifier.
pub const RESIDENT_TERMINAL_JOB_LIMIT: usize = 256;

/// Result of an optimistic job snapshot write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobWrite {
    Updated,
    Conflict(JobSnapshot),
}

/// Durable job storage. Implementations must compare and update atomically.
pub trait JobStore: Send + Sync + 'static {
    type Error: Error + Send + Sync + 'static;

    fn create(&self, snapshot: &JobSnapshot) -> Result<(), Self::Error>;

    fn get(&self, id: JobId) -> Result<Option<JobSnapshot>, Self::Error>;

    /// Returns the bounded startup working set for the registry.
    ///
    /// Implementations must include every non-terminal job. Older terminal jobs may be omitted
    /// because `get` is the canonical lazy-loading path for an opaque job identifier.
    fn list(&self) -> Result<Vec<JobSnapshot>, Self::Error>;

    fn compare_and_swap(
        &self,
        expected_sequence: u64,
        snapshot: &JobSnapshot,
    ) -> Result<JobWrite, Self::Error>;
}

/// Runtime access to one durably registered job.
///
/// The cancellation token is process-local and never persisted. The snapshot
/// remains the canonical client-facing state.
#[derive(Debug, Clone)]
pub struct JobTicket {
    snapshot: JobSnapshot,
    cancellation: CancellationToken,
}

impl JobTicket {
    #[must_use]
    pub const fn snapshot(&self) -> &JobSnapshot {
        &self.snapshot
    }

    #[must_use]
    pub const fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }
}

#[derive(Debug)]
struct ManagedJob {
    state: Mutex<ManagedJobState>,
}

#[derive(Debug)]
struct ManagedJobState {
    snapshot: JobSnapshot,
    cancellation: CancellationToken,
}

/// In-process coordinator for durable, cancellable background jobs.
///
/// Resident-job map locks are held only while looking up or admitting jobs. Registration and lazy
/// hydration share a narrow admission gate so the same durable ID cannot race into two managed
/// states. Each admitted job has its own mutation lock, so a slow update cannot block unrelated
/// resident jobs.
#[derive(Debug)]
pub struct JobRegistry<S> {
    store: Arc<S>,
    admission: Mutex<()>,
    jobs: RwLock<HashMap<JobId, Arc<ManagedJob>>>,
}

impl<S> JobRegistry<S>
where
    S: JobStore,
{
    pub fn restore(store: Arc<S>) -> Result<Self, JobRegistryError<S::Error>> {
        let restored = store.list().map_err(JobRegistryError::Store)?;
        Self::new(store, restored)
    }

    pub fn new(
        store: Arc<S>,
        restored: impl IntoIterator<Item = JobSnapshot>,
    ) -> Result<Self, JobRegistryError<S::Error>> {
        let mut jobs = HashMap::new();
        for snapshot in restored {
            let id = snapshot.id();
            if jobs.contains_key(&id) {
                return Err(JobRegistryError::Duplicate(id));
            }
            jobs.insert(id, Arc::new(managed_state(snapshot)));
        }
        compact_terminal_map(&mut jobs, RESIDENT_TERMINAL_JOB_LIMIT)
            .map_err(|()| JobRegistryError::Unavailable)?;
        Ok(Self {
            store,
            admission: Mutex::new(()),
            jobs: RwLock::new(jobs),
        })
    }

    pub fn register(&self, kind: JobKind) -> Result<JobTicket, JobRegistryError<S::Error>> {
        let _admission = self
            .admission
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let snapshot = JobSnapshot::new(kind);
        self.store
            .create(&snapshot)
            .map_err(JobRegistryError::Store)?;
        let managed = Arc::new(managed_state(snapshot.clone()));
        let mut jobs = self
            .jobs
            .write()
            .map_err(|_| JobRegistryError::Unavailable)?;
        if jobs.insert(snapshot.id(), Arc::clone(&managed)).is_some() {
            return Err(JobRegistryError::Duplicate(snapshot.id()));
        }
        let state = managed
            .state
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        Ok(ticket(&state.snapshot, &state.cancellation))
    }

    pub fn get(&self, id: JobId) -> Result<JobTicket, JobRegistryError<S::Error>> {
        let managed = self.lookup(id)?;
        let (result, terminal) = {
            let state = managed
                .state
                .lock()
                .map_err(|_| JobRegistryError::Unavailable)?;
            (
                ticket(&state.snapshot, &state.cancellation),
                state.snapshot.state().is_terminal(),
            )
        };
        drop(managed);
        if terminal {
            self.compact_terminal_residents()?;
        }
        Ok(result)
    }

    pub fn list(&self) -> Result<Vec<JobTicket>, JobRegistryError<S::Error>> {
        self.compact_terminal_residents()?;
        let jobs = self
            .jobs
            .read()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let mut tickets = Vec::with_capacity(jobs.len());
        for managed in jobs.values() {
            let state = managed
                .state
                .lock()
                .map_err(|_| JobRegistryError::Unavailable)?;
            tickets.push(ticket(&state.snapshot, &state.cancellation));
        }
        tickets.sort_unstable_by_key(|ticket| ticket.snapshot.id());
        Ok(tickets)
    }

    pub fn apply(
        &self,
        id: JobId,
        update: JobUpdate,
    ) -> Result<JobTicket, JobRegistryError<S::Error>> {
        let managed = self.lookup(id)?;
        let result = self.apply_to_managed(id, update, &managed);
        let terminal = managed
            .state
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?
            .snapshot
            .state()
            .is_terminal();
        drop(managed);
        if terminal {
            self.compact_terminal_residents()?;
        }
        result
    }

    fn apply_to_managed(
        &self,
        id: JobId,
        update: JobUpdate,
        managed: &ManagedJob,
    ) -> Result<JobTicket, JobRegistryError<S::Error>> {
        let mut state = managed
            .state
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let expected_sequence = state.snapshot.sequence();
        let mut candidate = state.snapshot.clone();
        let mutation = candidate.apply(update).map_err(JobRegistryError::Domain)?;

        if mutation == JobMutation::Changed {
            match self
                .store
                .compare_and_swap(expected_sequence, &candidate)
                .map_err(JobRegistryError::Store)?
            {
                JobWrite::Updated => state.snapshot = candidate,
                JobWrite::Conflict(actual) => {
                    if actual.id() != id || actual.kind() != state.snapshot.kind() {
                        return Err(JobRegistryError::InvalidConflict(id));
                    }
                    state.snapshot = actual;
                    sync_cancellation(&mut state);
                    return Err(JobRegistryError::Conflict {
                        expected_sequence,
                        actual_sequence: state.snapshot.sequence(),
                    });
                }
            }
        }

        sync_cancellation(&mut state);
        Ok(ticket(&state.snapshot, &state.cancellation))
    }

    fn compact_terminal_residents(&self) -> Result<usize, JobRegistryError<S::Error>> {
        let _admission = self
            .admission
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let mut jobs = self
            .jobs
            .write()
            .map_err(|_| JobRegistryError::Unavailable)?;
        compact_terminal_map(&mut jobs, RESIDENT_TERMINAL_JOB_LIMIT)
            .map_err(|()| JobRegistryError::Unavailable)
    }

    fn lookup(&self, id: JobId) -> Result<Arc<ManagedJob>, JobRegistryError<S::Error>> {
        if let Some(managed) = self
            .jobs
            .read()
            .map_err(|_| JobRegistryError::Unavailable)?
            .get(&id)
            .cloned()
        {
            return Ok(managed);
        }

        let _admission = self
            .admission
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        if let Some(managed) = self
            .jobs
            .read()
            .map_err(|_| JobRegistryError::Unavailable)?
            .get(&id)
            .cloned()
        {
            return Ok(managed);
        }

        let snapshot = self
            .store
            .get(id)
            .map_err(JobRegistryError::Store)?
            .ok_or(JobRegistryError::NotFound(id))?;
        if snapshot.id() != id {
            return Err(JobRegistryError::InvalidLookup(id));
        }
        let candidate = Arc::new(managed_state(snapshot));
        let mut jobs = self
            .jobs
            .write()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let admitted = Arc::clone(jobs.entry(id).or_insert(candidate));
        compact_terminal_map(&mut jobs, RESIDENT_TERMINAL_JOB_LIMIT)
            .map_err(|()| JobRegistryError::Unavailable)?;
        Ok(admitted)
    }
}

fn compact_terminal_map(
    jobs: &mut HashMap<JobId, Arc<ManagedJob>>,
    limit: usize,
) -> Result<usize, ()> {
    let mut terminal_ids = Vec::new();
    for (id, managed) in jobs.iter() {
        let state = managed.state.lock().map_err(|_| ())?;
        if state.snapshot.state().is_terminal() {
            terminal_ids.push(*id);
        }
    }
    terminal_ids.sort_unstable();
    let target = terminal_ids.len().saturating_sub(limit);
    let mut removed = 0;
    for id in terminal_ids {
        if removed == target {
            break;
        }
        let removable = jobs
            .get(&id)
            .is_some_and(|managed| Arc::strong_count(managed) == 1);
        if removable {
            jobs.remove(&id);
            removed += 1;
        }
    }
    Ok(removed)
}

fn ticket(snapshot: &JobSnapshot, cancellation: &CancellationToken) -> JobTicket {
    JobTicket {
        snapshot: snapshot.clone(),
        cancellation: cancellation.clone(),
    }
}

fn managed_state(snapshot: JobSnapshot) -> ManagedJob {
    let mut state = ManagedJobState {
        snapshot,
        cancellation: CancellationToken::new(),
    };
    sync_cancellation(&mut state);
    ManagedJob {
        state: Mutex::new(state),
    }
}

fn sync_cancellation(state: &mut ManagedJobState) {
    if matches!(
        state.snapshot.state(),
        osg_domain::JobState::Cancelling | osg_domain::JobState::Cancelled
    ) {
        state.cancellation.cancel();
    } else if state.snapshot.state() == osg_domain::JobState::Queued
        && state.cancellation.is_cancelled()
    {
        state.cancellation = CancellationToken::new();
    }
}

#[derive(Debug, Error)]
pub enum JobRegistryError<E>
where
    E: Error + Send + Sync + 'static,
{
    #[error("job {0} is not registered")]
    NotFound(JobId),
    #[error("job {0} was registered more than once")]
    Duplicate(JobId),
    #[error("job registry is unavailable")]
    Unavailable,
    #[error("job {0} returned an invalid conflict snapshot")]
    InvalidConflict(JobId),
    #[error("job {0} returned an invalid lookup snapshot")]
    InvalidLookup(JobId),
    #[error(
        "job changed concurrently: expected sequence {expected_sequence}, actual sequence {actual_sequence}"
    )]
    Conflict {
        expected_sequence: u64,
        actual_sequence: u64,
    },
    #[error(transparent)]
    Domain(JobError),
    #[error("job persistence failed: {0}")]
    Store(E),
}

#[cfg(test)]
mod tests {
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
}
