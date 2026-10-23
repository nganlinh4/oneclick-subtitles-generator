//! Per-tool operation exclusivity and verified executable leases.

use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{ManagerInner, NativeToolManager};
use crate::catalog::{ExecutableRole, NativeToolId, ToolDelivery};
use crate::path_security::resolve_owned;
use crate::receipt;
use crate::{CancellationToken, NativeToolError, Result};

impl NativeToolManager {
    pub fn resolve(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        self.resolve_selected(tool, cancellation, |manager| {
            manager
                .current_delivery(tool)
                .ok_or(NativeToolError::DeliveryUnavailable)
        })
    }

    /// Resolves one exact manager-owned version without consulting the
    /// currently selected delivery. This is intended for trusted rollback
    /// paths that must not activate a newer delivery rejected by a consumer.
    pub fn resolve_version(
        &self,
        tool: NativeToolId,
        version: &str,
        cancellation: &CancellationToken,
    ) -> Result<ToolLease> {
        self.resolve_selected(tool, cancellation, |manager| {
            manager
                .owned_deliveries(tool)?
                .into_iter()
                .find(|delivery| delivery.version == version)
                .ok_or(NativeToolError::DeliveryUnavailable)
        })
    }

    fn resolve_selected(
        &self,
        tool: NativeToolId,
        cancellation: &CancellationToken,
        select: impl FnOnce(&Self) -> Result<ToolDelivery>,
    ) -> Result<ToolLease> {
        let delivery = {
            let mut activity = self
                .0
                .activity
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            if activity.operations.contains(&tool) {
                return Err(NativeToolError::OperationInProgress(tool));
            }
            // Select the delivery while holding the same boundary used to
            // begin installs/removals. The lease therefore always protects
            // the requested delivery at its atomic acquisition point.
            let delivery = select(self)?;
            *activity.leases.entry(tool).or_default() += 1;
            delivery
        };
        let mut lease = ToolLease {
            inner: Arc::clone(&self.0),
            tool,
            version: delivery.version.clone(),
            executables: HashMap::new(),
            active: true,
        };
        let root = self.version_path(&delivery);
        let identity = receipt::validate_integrity(&root, &delivery, cancellation)?;
        self.remember_verified(&delivery, identity)?;
        let canonical_root =
            fs::canonicalize(&root).map_err(|_| NativeToolError::InvalidInstall)?;
        for file in &delivery.files {
            let Some(role) = file.role else {
                continue;
            };
            let candidate = resolve_owned(&root, &file.install_path)?;
            let canonical =
                fs::canonicalize(candidate).map_err(|_| NativeToolError::InvalidInstall)?;
            if !canonical.starts_with(&canonical_root) {
                return Err(NativeToolError::InvalidInstall);
            }
            lease.executables.insert(role, canonical);
        }
        Ok(lease)
    }

    pub(super) fn begin_operation(&self, tool: NativeToolId) -> Result<OperationGuard> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if activity.operations.contains(&tool) {
            return Err(NativeToolError::OperationInProgress(tool));
        }
        if activity.leases.get(&tool).copied().unwrap_or(0) > 0 {
            return Err(NativeToolError::RuntimeBusy);
        }
        activity.operations.insert(tool);
        drop(activity);
        Ok(OperationGuard {
            inner: Arc::clone(&self.0),
            tool,
        })
    }

    pub(super) fn begin_install_operation(&self, tool: NativeToolId) -> Result<OperationGuard> {
        let mut activity = self
            .0
            .activity
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        if activity.operations.contains(&tool) {
            return Err(NativeToolError::OperationInProgress(tool));
        }
        if tool != NativeToolId::YtDlp
            && activity.leases.get(&tool).copied().unwrap_or_default() > 0
        {
            return Err(NativeToolError::RuntimeBusy);
        }
        activity.operations.insert(tool);
        drop(activity);
        Ok(OperationGuard {
            inner: Arc::clone(&self.0),
            tool,
        })
    }

    pub(super) fn has_active_leases(&self, tool: NativeToolId) -> Result<bool> {
        self.0
            .activity
            .lock()
            .map(|activity| activity.leases.get(&tool).copied().unwrap_or_default() > 0)
            .map_err(|_| NativeToolError::StoreUnavailable)
    }
}

pub(super) struct OperationGuard {
    inner: Arc<ManagerInner>,
    tool: NativeToolId,
}

impl Drop for OperationGuard {
    fn drop(&mut self) {
        if let Ok(mut activity) = self.inner.activity.lock() {
            activity.operations.remove(&self.tool);
        }
    }
}

/// A verified in-process executable capability. Debug and serialization never
/// expose its filesystem paths.
pub struct ToolLease {
    inner: Arc<ManagerInner>,
    tool: NativeToolId,
    version: String,
    executables: HashMap<ExecutableRole, PathBuf>,
    active: bool,
}

impl ToolLease {
    #[must_use]
    pub const fn tool(&self) -> NativeToolId {
        self.tool
    }

    #[must_use]
    pub fn version(&self) -> &str {
        &self.version
    }

    #[must_use]
    pub fn executable(&self, role: ExecutableRole) -> Option<&Path> {
        self.executables.get(&role).map(PathBuf::as_path)
    }
}

impl fmt::Debug for ToolLease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ToolLease")
            .field("tool", &self.tool)
            .field("version", &self.version)
            .field("executables", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl Drop for ToolLease {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        if let Ok(mut activity) = self.inner.activity.lock()
            && let Some(count) = activity.leases.get_mut(&self.tool)
        {
            *count = count.saturating_sub(1);
            if *count == 0 {
                activity.leases.remove(&self.tool);
            }
        }
        self.active = false;
    }
}
