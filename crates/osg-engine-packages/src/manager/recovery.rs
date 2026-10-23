//! Startup recovery of interrupted downloads, staging, quarantine, and trash.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use uuid::Uuid;

use crate::catalog::{PackageCatalog, valid_asset_name};
use crate::path_security::{
    cleanup_known_tree, ensure_direct_child, is_link_or_reparse, scrub_generated_python_cache,
};
use crate::receipt;
use crate::{CancellationToken, PackageError, Result};

use super::files::sync_directory;
use super::key::ManagedPackageKey;
pub(super) fn recover_interrupted_mutations<K>(
    root: &Path,
    catalog: &PackageCatalog<K>,
) -> Result<()>
where
    K: ManagedPackageKey,
{
    recover_staging(root, catalog)?;
    recover_quarantine(root)?;
    recover_downloads(root, catalog)?;
    recover_installed_python_cache(root, catalog);
    recover_trash(root, catalog)
}

pub(super) fn recover_downloads<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    let downloads = ensure_direct_child(root, ".downloads")?;
    let mut allowed = HashSet::new();
    for delivery in catalog
        .releases
        .values()
        .filter_map(|releases| releases.first())
    {
        if let Some(manifest) = &delivery.manifest {
            allowed.insert(crate::download::cache_key(
                &manifest.sha256,
                &manifest.asset,
            ));
            for source in &delivery.sources {
                allowed.insert(crate::download::cache_key(
                    &source.asset.sha256,
                    &source.asset.asset,
                ));
            }
        } else {
            allowed.insert(crate::download::cache_key(
                &delivery.sha256,
                &delivery.asset,
            ));
        }
    }
    let mut obsolete = Vec::new();
    for entry in fs::read_dir(&downloads).map_err(|_| PackageError::StoreUnavailable)? {
        let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or(PackageError::StoreUnavailable)?;
        if !metadata.is_file() || is_link_or_reparse(&metadata) {
            return Err(PackageError::StoreUnavailable);
        }
        let cache_key = name
            .strip_suffix(".partial")
            .or_else(|| name.strip_suffix(".resume.json"))
            .ok_or(PackageError::StoreUnavailable)?;
        let (digest, asset) = cache_key
            .split_once('-')
            .ok_or(PackageError::StoreUnavailable)?;
        if digest.len() != 16
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !valid_asset_name(asset)
        {
            return Err(PackageError::StoreUnavailable);
        }
        if !allowed.contains(cache_key) {
            obsolete.push(entry.path());
        }
    }
    for path in obsolete {
        fs::remove_file(path).map_err(|_| PackageError::StoreUnavailable)?;
    }
    sync_directory(&downloads)
}

pub(super) fn recover_installed_python_cache<K>(root: &Path, catalog: &PackageCatalog<K>)
where
    K: ManagedPackageKey,
{
    for (component, releases) in &catalog.releases {
        for delivery in releases {
            let installed = root
                .join(component.as_str())
                .join("versions")
                .join(&delivery.version);
            if !installed.exists() {
                continue;
            }
            let Ok(allowed) = receipt::allowed_tree_at(&installed, delivery) else {
                continue;
            };
            // A corrupt or user-modified package remains preserved and will report `Corrupt`.
            // Only the complete, narrowly recognized legacy cache set is ever removed here.
            let _ =
                scrub_generated_python_cache(&installed, &allowed, &delivery.python_relative_path);
        }
    }
}

pub(super) fn recover_staging<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    let _ = catalog;
    let staging = ensure_direct_child(root, ".staging")?;
    if fs::read_dir(&staging)
        .map_err(|_| PackageError::StoreUnavailable)?
        .next()
        .is_some()
    {
        // Historical prefix-shaped trees have no durable per-operation authority. Even a perfect
        // catalog-shaped lookalike may be foreign, so preserve it and fail closed. New operations
        // are removed by RuntimeStagingAuthority before this compatibility check runs.
        return Err(PackageError::StoreUnavailable);
    }
    sync_directory(&staging)
}

pub(super) fn recover_quarantine(root: &Path) -> Result<()> {
    let quarantine = ensure_direct_child(root, ".quarantine")?;
    if fs::read_dir(&quarantine)
        .map_err(|_| PackageError::StoreUnavailable)?
        .next()
        .is_some()
    {
        // Old UUID-named quarantine trees predate authenticated ownership. Preserve them rather
        // than treating a filename as permission to recursively delete data.
        return Err(PackageError::StoreUnavailable);
    }
    sync_directory(&quarantine)
}

pub(super) fn recover_trash<K>(root: &Path, catalog: &PackageCatalog<K>) -> Result<()>
where
    K: ManagedPackageKey,
{
    let trash = ensure_direct_child(root, ".trash")?;
    let cancellation = CancellationToken::default();
    for entry in fs::read_dir(&trash).map_err(|_| PackageError::StoreUnavailable)? {
        let entry = entry.map_err(|_| PackageError::StoreUnavailable)?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| PackageError::StoreUnavailable)?;
        let name = entry
            .file_name()
            .to_str()
            .map(str::to_owned)
            .ok_or(PackageError::StoreUnavailable)?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            return Err(PackageError::StoreUnavailable);
        }
        let delivery = catalog
            .releases
            .iter()
            .flat_map(|(id, releases)| releases.iter().map(move |delivery| (id, delivery)))
            .find_map(|(id, delivery)| {
                (valid_mutation_name(&name, *id, false)
                    && name.starts_with(&format!("{}-{}-", id.as_str(), delivery.version)))
                .then_some(delivery)
            })
            .ok_or(PackageError::StoreUnavailable)?;
        let allowed = receipt::allowed_tree_at(&entry.path(), delivery)?;
        scrub_generated_python_cache(&entry.path(), &allowed, &delivery.python_relative_path)?;
        receipt::validate_integrity(&entry.path(), delivery, &cancellation)?;
        cleanup_known_tree(&entry.path(), &allowed)?;
    }
    sync_directory(&trash)
}

pub(super) fn valid_mutation_name<K>(name: &str, id: K, allow_adopt: bool) -> bool
where
    K: ManagedPackageKey,
{
    let direct_prefix = format!("{}-", id.as_str());
    let adopt_prefix = format!("adopt-{}-", id.as_str());
    let remainder = if let Some(value) = name.strip_prefix(&direct_prefix) {
        value
    } else if allow_adopt {
        let Some(value) = name.strip_prefix(&adopt_prefix) else {
            return false;
        };
        value
    } else {
        return false;
    };
    if !remainder.is_ascii() || remainder.len() <= 37 {
        return false;
    }
    let uuid_start = remainder.len() - 36;
    if remainder.as_bytes().get(uuid_start.wrapping_sub(1)) != Some(&b'-') {
        return false;
    }
    let version = &remainder[..uuid_start - 1];
    let uuid = &remainder[uuid_start..];
    !version.is_empty()
        && crate::catalog::validate_identifier(version).is_ok()
        && Uuid::parse_str(uuid).is_ok_and(|value| value.get_version_num() == 7)
}
