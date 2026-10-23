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
        let result = self.apply_to_managed_with(
            id,
            None,
            update,
            &managed,
            |store, expected_sequence, candidate| {
                store.compare_and_swap(expected_sequence, candidate)
            },
        );
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

    /// Applies an update only while the durable job is still at the sequence the caller observed.
    ///
    /// The sequence check and update share the same per-job mutation lock as [`Self::apply`], so a
    /// cancellation and a result acknowledgement have one deterministic winner.
    pub fn apply_if_sequence(
        &self,
        id: JobId,
        expected_sequence: u64,
        update: JobUpdate,
    ) -> Result<JobTicket, JobRegistryError<S::Error>> {
        let managed = self.lookup(id)?;
        let result = self.apply_to_managed_with(
            id,
            Some(expected_sequence),
            update,
            &managed,
            |store, expected_sequence, candidate| {
                store.compare_and_swap(expected_sequence, candidate)
            },
        );
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

    /// Applies an update while allowing the store to commit additional state in the same durable
    /// transaction as the job snapshot.
    ///
    /// The callback runs under the same per-job mutation lock as [`Self::apply`]. It must preserve
    /// [`JobStore::compare_and_swap`] semantics: compare `expected_sequence`, commit `candidate`
    /// atomically with its additional state, and return the authoritative conflict snapshot when
    /// the comparison loses. This keeps result/outbox publication inside the job's one legal
    /// terminal transition without exposing the registry's resident snapshot or store separately.
    pub fn apply_with_store<F>(
        &self,
        id: JobId,
        update: JobUpdate,
        persist: F,
    ) -> Result<JobTicket, JobRegistryError<S::Error>>
    where
        F: FnOnce(&S, u64, &JobSnapshot) -> Result<JobWrite, S::Error>,
    {
        let managed = self.lookup(id)?;
        let result = self.apply_to_managed_with(id, None, update, &managed, persist);
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

    fn apply_to_managed_with<F>(
        &self,
        id: JobId,
        caller_expected_sequence: Option<u64>,
        update: JobUpdate,
        managed: &ManagedJob,
        persist: F,
    ) -> Result<JobTicket, JobRegistryError<S::Error>>
    where
        F: FnOnce(&S, u64, &JobSnapshot) -> Result<JobWrite, S::Error>,
    {
        let mut state = managed
            .state
            .lock()
            .map_err(|_| JobRegistryError::Unavailable)?;
        let expected_sequence = state.snapshot.sequence();
        if let Some(caller_expected_sequence) = caller_expected_sequence
            && caller_expected_sequence != expected_sequence
        {
            return Err(JobRegistryError::Conflict {
                expected_sequence: caller_expected_sequence,
                actual_sequence: expected_sequence,
            });
        }
        let mut candidate = state.snapshot.clone();
        let mutation = candidate.apply(update).map_err(JobRegistryError::Domain)?;

        if mutation == JobMutation::Changed {
            match persist(&self.store, expected_sequence, &candidate)
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
mod tests;
