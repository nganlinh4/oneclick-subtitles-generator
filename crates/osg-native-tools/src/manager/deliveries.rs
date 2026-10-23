//! Delivery selection (built-in catalog plus dynamic yt-dlp records), the bounded verified-install
//! identity cache, and startup reconciliation of retained dynamic yt-dlp versions.

use std::fs;
use std::path::{Path, PathBuf};

use super::removal::TrashCleanupReport;
use super::{MAX_VERIFIED_INSTALLS, NativeToolManager, RETAINED_DYNAMIC_YTDLP_RELEASES};
use crate::catalog::{NativeToolId, ToolDelivery};
use crate::receipt;
use crate::{CancellationToken, NativeToolError, Result};

impl NativeToolManager {
    pub(super) fn current_delivery(&self, tool: NativeToolId) -> Option<ToolDelivery> {
        if tool == NativeToolId::YtDlp
            && let Ok(dynamic) = self.0.dynamic_ytdlp.lock()
            && let Some(delivery) = dynamic.first()
        {
            return Some(delivery.clone());
        }
        self.0.catalog.current(tool).cloned()
    }

    pub(super) fn owned_deliveries(&self, tool: NativeToolId) -> Result<Vec<ToolDelivery>> {
        let mut deliveries = self.0.catalog.releases(tool).to_vec();
        if tool == NativeToolId::YtDlp {
            let dynamic = self
                .0
                .dynamic_ytdlp
                .lock()
                .map_err(|_| NativeToolError::StoreUnavailable)?;
            for candidate in dynamic.iter() {
                if let Some(existing) = deliveries
                    .iter()
                    .find(|delivery| delivery.version == candidate.version)
                {
                    if existing != candidate {
                        return Err(NativeToolError::InvalidInstall);
                    }
                } else {
                    deliveries.push(candidate.clone());
                }
            }
        }
        deliveries.sort_by(|left, right| right.version.cmp(&left.version));
        Ok(deliveries)
    }

    pub(super) fn status_integrity_is_valid(&self, target: &Path, delivery: &ToolDelivery) -> bool {
        let key = (delivery.tool, delivery.version.clone());
        let cached = self
            .0
            .verified_installs
            .lock()
            .ok()
            .and_then(|verified| verified.get(&key).cloned());
        if cached
            .as_ref()
            .is_some_and(|identity| receipt::identity_matches(target, delivery, identity))
        {
            return true;
        }
        if let Ok(identity) =
            receipt::validate_integrity(target, delivery, &CancellationToken::default())
        {
            self.remember_verified(delivery, identity).is_ok()
        } else {
            self.forget_verified(delivery);
            false
        }
    }

    pub(super) fn remember_verified(
        &self,
        delivery: &ToolDelivery,
        identity: receipt::InstallIdentity,
    ) -> Result<()> {
        let mut verified = self
            .0
            .verified_installs
            .lock()
            .map_err(|_| NativeToolError::StoreUnavailable)?;
        let key = (delivery.tool, delivery.version.clone());
        if !verified.contains_key(&key) && verified.len() >= MAX_VERIFIED_INSTALLS {
            verified.clear();
        }
        verified.insert(key, identity);
        Ok(())
    }

    pub(super) fn forget_verified(&self, delivery: &ToolDelivery) {
        if let Ok(mut verified) = self.0.verified_installs.lock() {
            verified.remove(&(delivery.tool, delivery.version.clone()));
        }
    }

    pub(super) fn forget_verified_tool(&self, tool: NativeToolId) {
        if let Ok(mut verified) = self.0.verified_installs.lock() {
            verified.retain(|(candidate, _), _| *candidate != tool);
        }
    }

    pub(super) fn version_path(&self, delivery: &ToolDelivery) -> PathBuf {
        self.0
            .root
            .join("tools")
            .join(delivery.tool.as_str())
            .join("versions")
            .join(&delivery.version)
    }

    pub(super) fn reconcile_dynamic_ytdlp_versions(&self, trash_cleanup: &TrashCleanupReport) {
        let loaded = {
            let Ok(dynamic) = self.0.dynamic_ytdlp.lock() else {
                return;
            };
            dynamic.clone()
        };
        let mut retained = Vec::new();
        let mut retained_valid = 0_usize;
        for delivery in loaded {
            let target = self.version_path(&delivery);
            match fs::symlink_metadata(&target) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.forget_verified(&delivery);
                    if trash_cleanup.can_forget(&delivery) {
                        let _ = crate::update::remove_persisted(&self.0.root, &delivery);
                    }
                }
                Ok(metadata) if metadata.is_dir() => {
                    match receipt::validate_integrity(
                        &target,
                        &delivery,
                        &CancellationToken::default(),
                    ) {
                        Ok(identity) if retained_valid < RETAINED_DYNAMIC_YTDLP_RELEASES => {
                            let _ = self.remember_verified(&delivery, identity);
                            retained_valid += 1;
                            retained.push(delivery);
                        }
                        Ok(_) => match self.move_verified_to_trash(&target, &delivery) {
                            Ok(trash) => {
                                if self.cleanup_owned_trash_delivery(&trash, &delivery).is_ok()
                                    && trash_cleanup.can_forget(&delivery)
                                {
                                    let _ =
                                        crate::update::remove_persisted(&self.0.root, &delivery);
                                }
                            }
                            Err(_) => retained.push(delivery),
                        },
                        Err(_) => {
                            self.forget_verified(&delivery);
                            if self.quarantine_invalid_install(&target).is_ok() {
                                if trash_cleanup.can_forget(&delivery) {
                                    let _ =
                                        crate::update::remove_persisted(&self.0.root, &delivery);
                                }
                            } else {
                                retained.push(delivery);
                            }
                        }
                    }
                }
                Ok(_) | Err(_) => retained.push(delivery),
            }
        }
        retained.sort_by(|left, right| right.version.cmp(&left.version));
        if let Ok(mut dynamic) = self.0.dynamic_ytdlp.lock() {
            *dynamic = retained;
        }
    }
}
