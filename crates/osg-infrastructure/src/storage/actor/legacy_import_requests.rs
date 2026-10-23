//! Legacy-import ledger requests.

use std::sync::mpsc::SyncSender;

use rusqlite::Connection;

use super::{Database, Request};
use crate::storage::error::DatabaseError;
use crate::storage::legacy;
use crate::storage::{
    ContentHash, LegacyImportCandidate, LegacyImportId, LegacyImportItemOutcome,
    LegacyImportItemState, LegacyImportSourceKind, LegacyImportSummary,
};

pub(super) enum LegacyImportRequest {
    PrepareLegacyImport {
        source_kind: LegacyImportSourceKind,
        fingerprint: ContentHash,
        candidates: Vec<LegacyImportCandidate>,
        reply: SyncSender<Result<LegacyImportSummary, DatabaseError>>,
    },
    LegacyImportItemState {
        source_id: LegacyImportId,
        candidate: LegacyImportCandidate,
        reply: SyncSender<Result<Option<LegacyImportItemState>, DatabaseError>>,
    },
    RecordLegacyImportItem {
        source_id: LegacyImportId,
        candidate: LegacyImportCandidate,
        outcome: LegacyImportItemOutcome,
        reply: SyncSender<Result<(), DatabaseError>>,
    },
    FinishLegacyImport {
        source_id: LegacyImportId,
        reply: SyncSender<Result<LegacyImportSummary, DatabaseError>>,
    },
    ListLegacyImports {
        reply: SyncSender<Result<Vec<LegacyImportSummary>, DatabaseError>>,
    },
}

impl std::fmt::Debug for LegacyImportRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::PrepareLegacyImport { .. } => "PrepareLegacyImport",
            Self::LegacyImportItemState { .. } => "LegacyImportItemState",
            Self::RecordLegacyImportItem { .. } => "RecordLegacyImportItem",
            Self::FinishLegacyImport { .. } => "FinishLegacyImport",
            Self::ListLegacyImports { .. } => "ListLegacyImports",
        })
    }
}

impl From<LegacyImportRequest> for Request {
    fn from(request: LegacyImportRequest) -> Self {
        Self::LegacyImport(request)
    }
}

impl LegacyImportRequest {
    pub(super) fn handle(self, connection: &mut Connection) {
        match self {
            Self::PrepareLegacyImport {
                source_kind,
                fingerprint,
                candidates,
                reply,
            } => {
                let _ = reply.send(legacy::prepare(
                    connection,
                    source_kind,
                    fingerprint,
                    &candidates,
                ));
            }
            Self::LegacyImportItemState {
                source_id,
                candidate,
                reply,
            } => {
                let _ = reply.send(legacy::item_state(connection, source_id, &candidate));
            }
            Self::RecordLegacyImportItem {
                source_id,
                candidate,
                outcome,
                reply,
            } => {
                let _ = reply.send(legacy::record_item(
                    connection, source_id, &candidate, &outcome,
                ));
            }
            Self::FinishLegacyImport { source_id, reply } => {
                let _ = reply.send(legacy::finish(connection, source_id));
            }
            Self::ListLegacyImports { reply } => {
                let _ = reply.send(legacy::list(connection));
            }
        }
    }
}

impl Database {
    pub fn prepare_legacy_import(
        &self,
        source_kind: LegacyImportSourceKind,
        fingerprint: ContentHash,
        candidates: &[LegacyImportCandidate],
    ) -> Result<LegacyImportSummary, DatabaseError> {
        self.request(|reply| LegacyImportRequest::PrepareLegacyImport {
            source_kind,
            fingerprint,
            candidates: candidates.to_vec(),
            reply,
        })
    }

    pub fn legacy_import_item_state(
        &self,
        source_id: LegacyImportId,
        candidate: &LegacyImportCandidate,
    ) -> Result<Option<LegacyImportItemState>, DatabaseError> {
        self.request(|reply| LegacyImportRequest::LegacyImportItemState {
            source_id,
            candidate: candidate.clone(),
            reply,
        })
    }

    pub fn record_legacy_import_item(
        &self,
        source_id: LegacyImportId,
        candidate: &LegacyImportCandidate,
        outcome: &LegacyImportItemOutcome,
    ) -> Result<(), DatabaseError> {
        self.request(|reply| LegacyImportRequest::RecordLegacyImportItem {
            source_id,
            candidate: candidate.clone(),
            outcome: outcome.clone(),
            reply,
        })
    }

    pub fn finish_legacy_import(
        &self,
        source_id: LegacyImportId,
    ) -> Result<LegacyImportSummary, DatabaseError> {
        self.request(|reply| LegacyImportRequest::FinishLegacyImport { source_id, reply })
    }

    pub fn list_legacy_imports(&self) -> Result<Vec<LegacyImportSummary>, DatabaseError> {
        self.request(|reply| LegacyImportRequest::ListLegacyImports { reply })
    }
}
