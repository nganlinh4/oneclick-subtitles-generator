//! Durable transcript writes the run loop needs, behind a seam that tests can fake.

use std::sync::Arc;

use osg_domain::TranscriptRevisionId;
use osg_infrastructure::storage::{
    Database, DatabaseError, TranscriptRevisionState, TranscriptTurnRecord, TranscriptWordRecord,
};

use crate::background;
use crate::error::CommandResult;

pub(crate) trait RevisionStore: Send + Sync + 'static {
    fn promote_window(
        &self,
        revision_id: TranscriptRevisionId,
        turns: &[TranscriptTurnRecord],
        words: &[TranscriptWordRecord],
    ) -> Result<(), DatabaseError>;

    fn set_state(
        &self,
        revision_id: TranscriptRevisionId,
        state: TranscriptRevisionState,
    ) -> Result<(), DatabaseError>;
}

impl RevisionStore for Database {
    fn promote_window(
        &self,
        revision_id: TranscriptRevisionId,
        turns: &[TranscriptTurnRecord],
        words: &[TranscriptWordRecord],
    ) -> Result<(), DatabaseError> {
        self.transcript_promote_window(revision_id, turns, words)
    }

    fn set_state(
        &self,
        revision_id: TranscriptRevisionId,
        state: TranscriptRevisionState,
    ) -> Result<(), DatabaseError> {
        self.transcript_update_revision_state(revision_id, state)
    }
}

/// Commits one window's turns and words off the async runtime.
pub(super) async fn promote(
    store: &Arc<dyn RevisionStore>,
    revision_id: TranscriptRevisionId,
    turns: Vec<TranscriptTurnRecord>,
    words: Vec<TranscriptWordRecord>,
) -> CommandResult<()> {
    let store = Arc::clone(store);
    background::run_blocking("transcript promotion", move || {
        store.promote_window(revision_id, &turns, &words)
    })
    .await
}

/// Records a terminal revision state. The job outcome is already decided, so a failed write only
/// leaves the revision `in_progress`, which a later relaunch still treats as loadable.
pub(super) async fn set_state_best_effort(
    store: &Arc<dyn RevisionStore>,
    revision_id: TranscriptRevisionId,
    state: TranscriptRevisionState,
) {
    let store = Arc::clone(store);
    let _ = background::run_blocking("transcript revision state", move || {
        store.set_state(revision_id, state)
    })
    .await;
}
