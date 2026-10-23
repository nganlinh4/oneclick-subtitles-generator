//! Removal of every owned version and bounded, idempotent reclamation of owned trash.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::atomic::Ordering as AtomicOrdering;

use uuid::Uuid;

use super::{MAX_TRASH_GC_ENTRIES, ManagerInner, NativeToolManager, RemovalOutcome};
use crate::catalog::{NativeToolId, ToolDelivery};
use crate::path_security::{
    ensure_direct_child, remove_empty_directory, remove_owned_tree_subset, require_directory,
};
use crate::receipt;
use crate::{
    CancellationToken, NativeToolError, OperationPhase, OperationProgress, ProgressSink, Result,
};

#[derive(Debug, Default)]
pub(super) struct TrashCleanupReport {
    scan_complete: bool,
    unresolved: HashSet<(NativeToolId, String)>,
}

impl TrashCleanupReport {
    pub(super) fn can_forget(&self, delivery: &ToolDelivery) -> bool {
        self.scan_complete
            && !self
                .unresolved
                .contains(&(delivery.tool, delivery.version.clone()))
    }
}

#[cfg(test)]
fn should_fail_removal_rename(inner: &ManagerInner, completed: u64) -> bool {
    usize::try_from(completed).is_ok_and(|forced_number| {
        inner
            .fail_removal_rename_number
            .compare_exchange(
                forced_number,
                0,
                AtomicOrdering::AcqRel,
                AtomicOrdering::Acquire,
            )
            .is_ok()
    })
}

#[cfg(not(test))]
const fn should_fail_removal_rename(_: &ManagerInner, _: u64) -> bool {
    false
}

impl NativeToolManager {
    pub fn remove(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        progress: &dyn ProgressSink,
    ) -> Result<RemovalOutcome> {
        #[cfg(test)]
        self.wait_at_remove_before_guard_hook();
        let _operation = self.begin_operation(tool)?;
        let current = self
            .current_delivery(tool)
            .ok_or(NativeToolError::DeliveryUnavailable)?;
        cancellation.check()?;
        let deliveries = self.owned_deliveries(tool)?;
        let mut installed = Vec::new();
        for delivery in deliveries {
            cancellation.check()?;
            let target = self.version_path(&delivery);
            match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Ok(metadata) if metadata.is_dir() => {}
                Ok(_) => return Ok(RemovalOutcome::PreservedModified),
                Err(_) => return Err(NativeToolError::StoreUnavailable),
            }
            if let Err(error) = receipt::validate_integrity(&target, &delivery, cancellation) {
                return match error {
                    NativeToolError::Cancelled => Err(error),
                    _ => Ok(RemovalOutcome::PreservedModified),
                };
            }
            installed.push((delivery, target));
        }
        if installed.is_empty() {
            self.forget_verified_tool(tool);
            let trash_cleanup = self.cleanup_owned_trash();
            let remove_persisted = self.dynamic_provenance_is_reclaimed(tool, &trash_cleanup);
            self.remove_dynamic_state(tool, remove_persisted);
            self.prune_empty_tool_directories(tool);
            return Ok(RemovalOutcome::Missing);
        }

        self.0.coordinator.quiesce(tool)?;
        cancellation.check()?;
        let trash_parent = self.0.root.join(".trash");
        require_directory(&trash_parent)?;
        // Move the selected delivery last. Any earlier rename failure therefore
        // leaves the active runtime available for the desktop rollback path.
        installed.sort_by_key(|(delivery, _)| delivery.version == current.version);
        let total = u64::try_from(installed.len()).map_err(|_| NativeToolError::InvalidInstall)?;
        progress.on_progress(OperationProgress::new(OperationPhase::Removing, 0, total));
        cancellation.check()?;
        let mut committed = Vec::with_capacity(installed.len());
        for (completed, (delivery, target)) in (1_u64..).zip(installed) {
            #[cfg(test)]
            self.0
                .removal_rename_attempts
                .lock()
                .expect("removal attempt recorder must remain available")
                .push(delivery.version.clone());
            let trash = trash_parent.join(format!(
                "{}-{}-{}",
                tool.as_str(),
                delivery.version,
                Uuid::now_v7()
            ));
            let forced_failure = should_fail_removal_rename(&self.0, completed);
            if forced_failure || fs::rename(&target, &trash).is_err() {
                for (_, original, staged) in committed.iter().rev() {
                    let _ = fs::rename(staged, original);
                }
                return Err(NativeToolError::StoreUnavailable);
            }
            self.forget_verified(&delivery);
            committed.push((delivery, target, trash));
        }

        // The validated renames above are the logical commit. Everything after
        // this point is idempotent, best-effort reclamation; a locked file must
        // not turn a completed uninstall into a false failure.
        progress.on_progress(OperationProgress::new(
            OperationPhase::Removing,
            total,
            total,
        ));
        let mut cleanup_complete = true;
        for (delivery, _, trash) in &committed {
            if self.cleanup_owned_trash_delivery(trash, delivery).is_err() {
                cleanup_complete = false;
            }
        }
        let remove_persisted = cleanup_complete && {
            let trash_cleanup = self.cleanup_owned_trash();
            self.dynamic_provenance_is_reclaimed(tool, &trash_cleanup)
        };
        self.remove_dynamic_state(tool, remove_persisted);
        self.prune_empty_tool_directories(tool);
        Ok(RemovalOutcome::Removed)
    }

    #[cfg(test)]
    fn wait_at_remove_before_guard_hook(&self) {
        let hook = self
            .0
            .remove_before_guard_hook
            .lock()
            .expect("remove interleaving hook must remain available")
            .take();
        if let Some(hook) = hook {
            hook.entered.wait();
            hook.resume.wait();
        }
    }

    fn remove_dynamic_state(&self, tool: NativeToolId, remove_persisted: bool) {
        if tool != NativeToolId::YtDlp {
            return;
        }
        let removed = self
            .0
            .dynamic_ytdlp
            .lock()
            .map(|mut dynamic| std::mem::take(&mut *dynamic))
            .unwrap_or_default();
        if remove_persisted {
            for delivery in removed {
                let _ = crate::update::remove_persisted(&self.0.root, &delivery);
            }
        }
    }

    fn dynamic_provenance_is_reclaimed(
        &self,
        tool: NativeToolId,
        trash_cleanup: &TrashCleanupReport,
    ) -> bool {
        if tool != NativeToolId::YtDlp {
            return true;
        }
        self.0.dynamic_ytdlp.lock().is_ok_and(|dynamic| {
            dynamic
                .iter()
                .all(|delivery| trash_cleanup.can_forget(delivery))
        })
    }

    /// Retires `tools/{tool}/versions` and `tools/{tool}`, which
    /// `ensure_versions_root` lazily creates the first time this tool is
    /// installed, once every owned version underneath has been reclaimed.
    /// Without this, an install immediately followed by a full removal
    /// leaves an empty directory behind that did not exist before the tool
    /// was ever installed, so the store never actually returns to its
    /// pre-install shape. Best-effort and safe to call whenever removal
    /// finds nothing (or nothing more) installed: `remove_empty_directory`
    /// is a no-op unless the directory is present, empty, and a plain
    /// directory, so an unowned or still-populated tree is left untouched.
    ///
    /// `tools/yt-dlp` is exempt: `update::dynamic_records_root` recreates
    /// `tools/yt-dlp/deliveries` on every manager startup regardless of
    /// whether yt-dlp is installed, so that directory (and its `tools/yt-dlp`
    /// parent) is part of the store's fixed baseline shape, not install
    /// residue.
    fn prune_empty_tool_directories(&self, tool: NativeToolId) {
        let tool_root = self.0.root.join("tools").join(tool.as_str());
        let _ = remove_empty_directory(&tool_root.join("versions"));
        if tool != NativeToolId::YtDlp {
            let _ = remove_empty_directory(&tool_root);
        }
    }

    pub(super) fn move_verified_to_trash(
        &self,
        target: &Path,
        delivery: &ToolDelivery,
    ) -> Result<PathBuf> {
        let trash_root = ensure_direct_child(&self.0.root, ".trash")?;
        let trash = trash_root.join(format!(
            "{}-{}-{}",
            delivery.tool.as_str(),
            delivery.version,
            Uuid::now_v7()
        ));
        fs::rename(target, &trash).map_err(|_| NativeToolError::StoreUnavailable)?;
        self.forget_verified(delivery);
        Ok(trash)
    }

    pub(super) fn cleanup_owned_trash_delivery(
        &self,
        trash: &Path,
        delivery: &ToolDelivery,
    ) -> Result<()> {
        let trash_root = self.0.root.join(".trash");
        if trash.parent() != Some(trash_root.as_path()) {
            return Err(NativeToolError::InvalidInstall);
        }
        #[cfg(test)]
        if self
            .0
            .force_cleanup_failure
            .swap(false, AtomicOrdering::AcqRel)
        {
            return Err(NativeToolError::StoreUnavailable);
        }
        let files = crate::path_security::collect_regular_files(trash)?;
        if !files.is_empty() && !receipt::ownership_matches(trash, delivery) {
            return Err(NativeToolError::InvalidInstall);
        }
        remove_owned_tree_subset(
            trash,
            &receipt::allowed_tree(delivery),
            receipt::RECEIPT_NAME,
        )
    }

    pub(super) fn cleanup_owned_trash(&self) -> TrashCleanupReport {
        let mut report = TrashCleanupReport {
            scan_complete: true,
            unresolved: HashSet::new(),
        };
        let mut deliveries = Vec::new();
        for tool in NativeToolId::ALL {
            let Ok(mut owned) = self.owned_deliveries(tool) else {
                report.scan_complete = false;
                return report;
            };
            deliveries.append(&mut owned);
        }
        let trash_root = self.0.root.join(".trash");
        let Ok(mut entries) = fs::read_dir(&trash_root) else {
            report.scan_complete = false;
            return report;
        };
        for _ in 0..MAX_TRASH_GC_ENTRIES {
            let Some(entry) = entries.next() else {
                return report;
            };
            let Ok(entry) = entry else {
                report.scan_complete = false;
                continue;
            };
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let mut matching = deliveries.iter().filter(|delivery| {
                let prefix = format!("{}-{}-", delivery.tool.as_str(), delivery.version);
                name.strip_prefix(&prefix).is_some_and(|suffix| {
                    Uuid::parse_str(suffix)
                        .is_ok_and(|identifier| identifier.get_version_num() == 7)
                })
            });
            let Some(delivery) = matching.next() else {
                continue;
            };
            if matching.next().is_some() {
                report.scan_complete = false;
                continue;
            }
            if self
                .cleanup_owned_trash_delivery(&entry.path(), delivery)
                .is_err()
            {
                report
                    .unresolved
                    .insert((delivery.tool, delivery.version.clone()));
            }
        }

        // Reading one additional entry is enough to prove the bounded scan
        // was capped. Do not retire any dynamic provenance while an owned
        // trash entry may still exist beyond the boundary.
        if entries.next().is_some() {
            report.scan_complete = false;
        }
        report
    }
}
