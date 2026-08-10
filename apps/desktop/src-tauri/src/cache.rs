use osg_infrastructure::storage::{
    CacheCategory, CacheCategoryInfo, CacheClearOutcome, CacheInfo, DatabaseError,
};
use serde::Serialize;
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::state::DesktopState;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheCategoryResponse {
    category: String,
    count: u64,
    size_bytes: u64,
}

impl From<CacheCategoryInfo> for CacheCategoryResponse {
    fn from(value: CacheCategoryInfo) -> Self {
        Self {
            category: value.category,
            count: value.count,
            size_bytes: value.size_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheInfoResponse {
    categories: Vec<CacheCategoryResponse>,
    total_count: u64,
    total_size_bytes: u64,
}

impl From<CacheInfo> for CacheInfoResponse {
    fn from(value: CacheInfo) -> Self {
        Self {
            categories: value
                .categories
                .into_iter()
                .map(CacheCategoryResponse::from)
                .collect(),
            total_count: value.total_count,
            total_size_bytes: value.total_size_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CacheClearResponse {
    category: Option<String>,
    removed_count: u64,
    removed_size_bytes: u64,
    retained_shared_count: u64,
    leased_count: u64,
    cleanup_failed_count: u64,
    before: CacheInfoResponse,
    after: CacheInfoResponse,
}

impl CacheClearResponse {
    fn from_outcome(outcome: CacheClearOutcome) -> Self {
        let CacheClearOutcome {
            before,
            clear,
            after,
        } = outcome;
        Self {
            category: clear.category,
            removed_count: clear.removed_count,
            removed_size_bytes: clear.removed_size_bytes,
            retained_shared_count: clear.retained_shared_count,
            leased_count: clear.leased_count,
            cleanup_failed_count: clear.cleanup_failed_count,
            before: before.into(),
            after: after.into(),
        }
    }
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn cache_info(state: State<'_, DesktopState>) -> CommandResult<CacheInfoResponse> {
    let database = state.database.clone();
    run_cache_task("cache information", move || {
        database.cache_info().map(CacheInfoResponse::from)
    })
    .await
}

#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn cache_clear(
    state: State<'_, DesktopState>,
    category: Option<String>,
) -> CommandResult<CacheClearResponse> {
    let category = category
        .map(CacheCategory::new)
        .transpose()
        .map_err(CommandError::from)?;
    let database = state.database.clone();
    run_cache_task("cache clear", move || {
        database
            .clear_cache_with_info(category.as_ref())
            .map(CacheClearResponse::from_outcome)
    })
    .await
}

/// Reconciles artifact storage and prunes expired, unleased cache rows before returning the
/// remaining path-free cache snapshot.
#[tauri::command]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State as an owned command extractor"
)]
pub(crate) async fn cache_prune_expired(
    state: State<'_, DesktopState>,
) -> CommandResult<CacheInfoResponse> {
    let database = state.database.clone();
    run_cache_task("cache expiry pruning", move || {
        database.cache_info().map(CacheInfoResponse::from)
    })
    .await
}

async fn run_cache_task<T>(
    operation: &'static str,
    task: impl FnOnce() -> Result<T, DatabaseError> + Send + 'static,
) -> CommandResult<T>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| CommandError::internal(format!("the {operation} task stopped unexpectedly")))?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use osg_infrastructure::storage::{
        CacheCategoryInfo, CacheClearOutcome, CacheClearResult, CacheInfo,
    };

    use super::{CacheClearResponse, CacheInfoResponse};

    fn info() -> CacheInfo {
        CacheInfo {
            categories: vec![CacheCategoryInfo {
                category: "waveform".to_owned(),
                count: 2,
                size_bytes: 4_096,
            }],
            total_count: 2,
            total_size_bytes: 4_096,
        }
    }

    #[test]
    fn cache_responses_copy_only_path_free_aggregate_fields() {
        let response = CacheInfoResponse::from(info());
        let json = serde_json::to_string(&response).expect("serialize cache response");

        assert_eq!(response.categories[0].category, "waveform");
        assert!(!json.to_ascii_lowercase().contains("path"));
        assert!(!json.contains("files"));
    }

    #[test]
    fn clear_response_keeps_before_after_and_sanitized_counters() {
        let response = CacheClearResponse::from_outcome(CacheClearOutcome {
            before: info(),
            clear: CacheClearResult {
                category: Some("waveform".to_owned()),
                removed_count: 2,
                removed_size_bytes: 4_096,
                retained_shared_count: 0,
                leased_count: 0,
                cleanup_failed_count: 0,
            },
            after: CacheInfo {
                categories: Vec::new(),
                total_count: 0,
                total_size_bytes: 0,
            },
        });
        let json = serde_json::to_string(&response).expect("serialize clear response");

        assert_eq!(response.before.total_count, 2);
        assert_eq!(response.after.total_count, 0);
        assert!(!json.to_ascii_lowercase().contains("path"));
    }
}
