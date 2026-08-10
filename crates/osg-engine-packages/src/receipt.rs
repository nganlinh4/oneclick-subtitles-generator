use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::catalog::{DeliveryFile, FileRole, MAX_FILES, PackageDelivery};
use crate::path_security::{
    collect_regular_files, require_regular_file, resolve_owned, validate_manifest_path,
};
use crate::{CancellationToken, PackageError, Result};

pub(crate) const RECEIPT_NAME: &str = "receipt.json";
const MAX_RECEIPT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageReceipt {
    schema_version: u32,
    component: String,
    platform: String,
    version: String,
    archive_sha256: String,
    python_relative_path: String,
    model_relative_path: Option<String>,
    aligner_relative_path: Option<String>,
    files: Vec<ReceiptFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptFile {
    path: String,
    size_bytes: u64,
    sha256: String,
    executable: bool,
    role: FileRole,
}

pub(crate) fn write(root: &Path, delivery: &PackageDelivery) -> Result<()> {
    let receipt = PackageReceipt::from_delivery(delivery);
    let encoded = serde_json::to_vec(&receipt).map_err(|_| PackageError::InvalidInstall)?;
    if encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(PackageError::InvalidInstall);
    }
    let path = root.join(RECEIPT_NAME);
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .write_all(&encoded)
        .map_err(|_| PackageError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| PackageError::StoreUnavailable)
}

pub(crate) fn validate_structure(root: &Path, delivery: &PackageDelivery) -> Result<()> {
    let receipt = read(root)?;
    if receipt != PackageReceipt::from_delivery(delivery) {
        return Err(PackageError::InvalidInstall);
    }
    for expected in &delivery.files {
        let path = resolve_owned(root, &expected.path)?;
        let metadata = require_regular_file(&path)?;
        if metadata.len() != expected.size_bytes || (expected.executable && !is_executable(&path)) {
            return Err(PackageError::InvalidInstall);
        }
    }
    validate_exact_tree(root, delivery)
}

pub(crate) fn validate_integrity(
    root: &Path,
    delivery: &PackageDelivery,
    cancellation: &CancellationToken,
) -> Result<()> {
    validate_structure(root, delivery)?;
    for expected in &delivery.files {
        cancellation.check()?;
        let path = resolve_owned(root, &expected.path)?;
        if !file_matches(&path, expected, cancellation)? {
            return Err(PackageError::InvalidInstall);
        }
    }
    Ok(())
}

pub(crate) fn file_matches(
    path: &Path,
    expected: &DeliveryFile,
    cancellation: &CancellationToken,
) -> Result<bool> {
    let metadata = require_regular_file(path)?;
    if metadata.len() != expected.size_bytes {
        return Ok(false);
    }
    let actual = hash_file(path, cancellation)?;
    Ok(actual == expected.sha256)
}

pub(crate) fn hash_file(path: &Path, cancellation: &CancellationToken) -> Result<String> {
    require_regular_file(path)?;
    let mut input = fs::File::open(path).map_err(|_| PackageError::InvalidInstall)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| PackageError::InvalidInstall)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

pub(crate) fn allowed_tree(delivery: &PackageDelivery) -> std::collections::HashSet<String> {
    delivery
        .files
        .iter()
        .map(|file| file.path.clone())
        .chain([RECEIPT_NAME.to_string()])
        .collect()
}

fn read(root: &Path) -> Result<PackageReceipt> {
    let path = resolve_owned(root, RECEIPT_NAME)?;
    let metadata = require_regular_file(&path)?;
    if metadata.len() == 0 || metadata.len() > MAX_RECEIPT_BYTES {
        return Err(PackageError::InvalidInstall);
    }
    let input = fs::File::open(path).map_err(|_| PackageError::InvalidInstall)?;
    let capacity = usize::try_from(metadata.len()).map_err(|_| PackageError::InvalidInstall)?;
    let mut encoded = Vec::with_capacity(capacity);
    input
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|_| PackageError::InvalidInstall)?;
    if encoded.len() as u64 != metadata.len() {
        return Err(PackageError::InvalidInstall);
    }
    let receipt: PackageReceipt =
        serde_json::from_slice(&encoded).map_err(|_| PackageError::InvalidInstall)?;
    receipt.validate()?;
    Ok(receipt)
}

fn validate_exact_tree(root: &Path, delivery: &PackageDelivery) -> Result<()> {
    let actual = collect_regular_files(root)?;
    let expected = allowed_tree(delivery);
    if actual != expected {
        return Err(PackageError::InvalidInstall);
    }
    Ok(())
}

impl PackageReceipt {
    fn from_delivery(delivery: &PackageDelivery) -> Self {
        Self {
            schema_version: 1,
            component: delivery.component.clone(),
            platform: delivery.platform.clone(),
            version: delivery.version.clone(),
            archive_sha256: delivery.sha256.clone(),
            python_relative_path: delivery.python_relative_path.clone(),
            model_relative_path: delivery.model_relative_path.clone(),
            aligner_relative_path: delivery.aligner_relative_path.clone(),
            files: delivery.files.iter().map(ReceiptFile::from).collect(),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.files.is_empty() || self.files.len() > MAX_FILES {
            return Err(PackageError::InvalidInstall);
        }
        validate_manifest_path(&self.python_relative_path)
            .map_err(|_| PackageError::InvalidInstall)?;
        if let Some(path) = &self.model_relative_path {
            crate::path_security::validate_directory_path(path)
                .map_err(|_| PackageError::InvalidInstall)?;
        }
        if let Some(path) = &self.aligner_relative_path {
            crate::path_security::validate_directory_path(path)
                .map_err(|_| PackageError::InvalidInstall)?;
        }
        let mut paths = std::collections::HashSet::new();
        for file in &self.files {
            validate_manifest_path(&file.path).map_err(|_| PackageError::InvalidInstall)?;
            if file.size_bytes == 0
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !paths.insert(&file.path)
            {
                return Err(PackageError::InvalidInstall);
            }
        }
        Ok(())
    }
}

impl From<&DeliveryFile> for ReceiptFile {
    fn from(file: &DeliveryFile) -> Self {
        Self {
            path: file.path.clone(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            executable: file.executable,
            role: file.role,
        }
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
    })
}
