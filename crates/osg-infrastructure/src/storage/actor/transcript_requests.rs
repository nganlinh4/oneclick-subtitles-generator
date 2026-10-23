//! Word-native transcript requests: revisions, window promotion, cue mappings, and range queries.

use std::sync::mpsc::SyncSender;

use osg_domain::{ProjectId, TranscriptRevisionId};
use rusqlite::Connection;

use super::{Database, Request};
use crate::storage::error::DatabaseError;
use crate::storage::transcripts;
use crate::storage::transcripts::{
    CueWordMappingRecord, TranscriptRevisionRecord, TranscriptTurnRecord, TranscriptWordRecord,
};

pub(super) enum TranscriptRequest {
    InsertRevision {
        revision: TranscriptRevisionRecord,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    GetRevision {
        id: TranscriptRevisionId,
        reply: SyncSender<Result<Option<TranscriptRevisionRecord>, DatabaseError>>,
    },
    ListRevisions {
        project_id: ProjectId,
        reply: SyncSender<Result<Vec<TranscriptRevisionRecord>, DatabaseError>>,
    },
    UpdateRevisionState {
        revision_id: TranscriptRevisionId,
        state: String,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    PromoteWindow {
        revision_id: TranscriptRevisionId,
        turns: Vec<TranscriptTurnRecord>,
        words: Vec<TranscriptWordRecord>,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    SaveCueMappings {
        mappings: Vec<CueWordMappingRecord>,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    LoadCueMappings {
        project_id: ProjectId,
        reply: SyncSender<Result<Vec<CueWordMappingRecord>, DatabaseError>>,
    },
    QueryActiveWord {
        revision_id: TranscriptRevisionId,
        time_ms: i64,
        reply: SyncSender<Result<Option<TranscriptWordRecord>, DatabaseError>>,
    },
    QueryWordsInRange {
        revision_id: TranscriptRevisionId,
        start_ms: i64,
        end_ms: i64,
        reply: SyncSender<Result<Vec<TranscriptWordRecord>, DatabaseError>>,
    },
    QueryTurnsInRange {
        revision_id: TranscriptRevisionId,
        start_ms: i64,
        end_ms: i64,
        reply: SyncSender<Result<Vec<TranscriptTurnRecord>, DatabaseError>>,
    },
}

impl std::fmt::Debug for TranscriptRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InsertRevision { .. } => "TranscriptInsertRevision",
            Self::GetRevision { .. } => "TranscriptGetRevision",
            Self::ListRevisions { .. } => "TranscriptListRevisions",
            Self::UpdateRevisionState { .. } => "TranscriptUpdateRevisionState",
            Self::PromoteWindow { .. } => "TranscriptPromoteWindow",
            Self::SaveCueMappings { .. } => "TranscriptSaveCueMappings",
            Self::LoadCueMappings { .. } => "TranscriptLoadCueMappings",
            Self::QueryActiveWord { .. } => "TranscriptQueryActiveWord",
            Self::QueryWordsInRange { .. } => "TranscriptQueryWordsInRange",
            Self::QueryTurnsInRange { .. } => "TranscriptQueryTurnsInRange",
        })
    }
}

impl From<TranscriptRequest> for Request {
    fn from(request: TranscriptRequest) -> Self {
        Self::Transcripts(request)
    }
}

impl TranscriptRequest {
    #[allow(clippy::too_many_lines)]
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::InsertRevision { revision, reply } => {
                let res = (|| -> Result<(), DatabaseError> {
                    let tx = connection
                        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                    transcripts::insert_transcript_revision(&tx, &revision)?;
                    tx.commit()?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            Self::GetRevision { id, reply } => {
                let _ = reply.send(transcripts::get_transcript_revision(connection, id));
            }
            Self::ListRevisions { project_id, reply } => {
                let _ = reply.send(transcripts::list_transcript_revisions_for_project(
                    connection, project_id,
                ));
            }
            Self::UpdateRevisionState {
                revision_id,
                state,
                reply,
            } => {
                let _ = reply.send(transcripts::update_transcript_revision_state(
                    connection,
                    revision_id,
                    &state,
                ));
            }
            Self::PromoteWindow {
                revision_id,
                turns,
                words,
                reply,
            } => {
                let res = (|| -> Result<(), DatabaseError> {
                    let tx = connection
                        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                    transcripts::promote_window_results(&tx, revision_id, &turns, &words)?;
                    tx.commit()?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            Self::SaveCueMappings { mappings, reply } => {
                let res = (|| -> Result<(), DatabaseError> {
                    let tx = connection
                        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                    transcripts::save_cue_word_mappings(&tx, &mappings)?;
                    tx.commit()?;
                    Ok(())
                })();
                let _ = reply.send(res);
            }
            Self::LoadCueMappings { project_id, reply } => {
                let _ = reply.send(transcripts::load_cue_word_mappings_for_project(
                    connection, project_id,
                ));
            }
            Self::QueryActiveWord {
                revision_id,
                time_ms,
                reply,
            } => {
                let _ = reply.send(transcripts::query_active_word(
                    connection,
                    revision_id,
                    time_ms,
                ));
            }
            Self::QueryWordsInRange {
                revision_id,
                start_ms,
                end_ms,
                reply,
            } => {
                let _ = reply.send(transcripts::query_words_in_range(
                    connection,
                    revision_id,
                    start_ms,
                    end_ms,
                ));
            }
            Self::QueryTurnsInRange {
                revision_id,
                start_ms,
                end_ms,
                reply,
            } => {
                let _ = reply.send(transcripts::query_turns_in_range(
                    connection,
                    revision_id,
                    start_ms,
                    end_ms,
                ));
            }
        }
    }
}

impl Database {
    pub fn transcript_insert_revision(
        &self,
        revision: &TranscriptRevisionRecord,
    ) -> Result<(), DatabaseError> {
        self.request(|reply| TranscriptRequest::InsertRevision {
            revision: revision.clone(),
            reply,
        })
    }

    pub fn transcript_get_revision(
        &self,
        id: TranscriptRevisionId,
    ) -> Result<Option<TranscriptRevisionRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::GetRevision { id, reply })
    }

    pub fn transcript_list_revisions(
        &self,
        project_id: ProjectId,
    ) -> Result<Vec<TranscriptRevisionRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::ListRevisions { project_id, reply })
    }

    pub fn transcript_update_revision_state(
        &self,
        revision_id: TranscriptRevisionId,
        state: &str,
    ) -> Result<(), DatabaseError> {
        let state = state.to_owned();
        self.request(|reply| TranscriptRequest::UpdateRevisionState {
            revision_id,
            state,
            reply,
        })
    }

    pub fn transcript_promote_window(
        &self,
        revision_id: TranscriptRevisionId,
        turns: &[TranscriptTurnRecord],
        words: &[TranscriptWordRecord],
    ) -> Result<(), DatabaseError> {
        self.request(|reply| TranscriptRequest::PromoteWindow {
            revision_id,
            turns: turns.to_vec(),
            words: words.to_vec(),
            reply,
        })
    }

    pub fn transcript_save_cue_mappings(
        &self,
        mappings: &[CueWordMappingRecord],
    ) -> Result<(), DatabaseError> {
        self.request(|reply| TranscriptRequest::SaveCueMappings {
            mappings: mappings.to_vec(),
            reply,
        })
    }

    pub fn transcript_load_cue_mappings(
        &self,
        project_id: ProjectId,
    ) -> Result<Vec<CueWordMappingRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::LoadCueMappings { project_id, reply })
    }

    pub fn transcript_query_active_word(
        &self,
        revision_id: TranscriptRevisionId,
        time_ms: i64,
    ) -> Result<Option<TranscriptWordRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::QueryActiveWord {
            revision_id,
            time_ms,
            reply,
        })
    }

    pub fn transcript_query_words_in_range(
        &self,
        revision_id: TranscriptRevisionId,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<TranscriptWordRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::QueryWordsInRange {
            revision_id,
            start_ms,
            end_ms,
            reply,
        })
    }

    pub fn transcript_query_turns_in_range(
        &self,
        revision_id: TranscriptRevisionId,
        start_ms: i64,
        end_ms: i64,
    ) -> Result<Vec<TranscriptTurnRecord>, DatabaseError> {
        self.request(|reply| TranscriptRequest::QueryTurnsInRange {
            revision_id,
            start_ms,
            end_ms,
            reply,
        })
    }
}
