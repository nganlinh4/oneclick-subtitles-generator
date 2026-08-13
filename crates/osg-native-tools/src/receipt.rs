#[cfg(test)]
use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::io::{Read as _, Write as _};
use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::catalog::{ExecutableRole, ToolDelivery};
use crate::path_security::{
    collect_regular_files, require_regular_file, resolve_owned, validate_relative_path,
};
use crate::{CancellationToken, NativeToolError, Result};

pub(crate) const RECEIPT_NAME: &str = "receipt.json";
const MAX_RECEIPT_BYTES: u64 = 128 * 1024;

#[cfg(test)]
thread_local! {
    static HASHED_BYTES: Cell<u64> = const { Cell::new(0) };
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct InstallIdentity {
    delivery_fingerprint: [u8; 32],
    files: Vec<FileIdentity>,
}

#[derive(Clone, Eq, PartialEq)]
struct FileIdentity {
    size_bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_seconds: i64,
    #[cfg(unix)]
    changed_nanoseconds: i64,
    #[cfg(unix)]
    mode: u32,
    #[cfg(windows)]
    volume_serial_number: u64,
    #[cfg(windows)]
    file_index: u64,
    #[cfg(windows)]
    creation_time: Option<u64>,
    #[cfg(windows)]
    last_write_time: Option<u64>,
    #[cfg(windows)]
    file_attributes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolReceipt {
    schema_version: u32,
    tool: String,
    platform: String,
    version: String,
    source_revision: String,
    artifact_sha256: String,
    files: Vec<ReceiptFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptFile {
    path: String,
    size_bytes: u64,
    sha256: String,
    executable: bool,
    role: Option<ExecutableRole>,
}

pub(crate) fn write(root: &Path, delivery: &ToolDelivery) -> Result<()> {
    let encoded = serde_json::to_vec(&ToolReceipt::from_delivery(delivery))
        .map_err(|_| NativeToolError::InvalidInstall)?;
    if encoded.is_empty() || encoded.len() as u64 > MAX_RECEIPT_BYTES {
        return Err(NativeToolError::InvalidInstall);
    }
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(root.join(RECEIPT_NAME))
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    output
        .write_all(&encoded)
        .map_err(|_| NativeToolError::StoreUnavailable)?;
    output
        .sync_all()
        .map_err(|_| NativeToolError::StoreUnavailable)
}

pub(crate) fn validate_integrity(
    root: &Path,
    delivery: &ToolDelivery,
    cancellation: &CancellationToken,
) -> Result<InstallIdentity> {
    let receipt = read(root)?;
    if receipt != ToolReceipt::from_delivery(delivery) {
        return Err(NativeToolError::InvalidInstall);
    }
    let identity_before = capture_identity(root, delivery)?;
    for file in expected_files(delivery) {
        cancellation.check()?;
        let path = resolve_owned(root, &file.path)?;
        let metadata = require_regular_file(&path)?;
        if metadata.len() != file.size_bytes
            || (file.executable && !is_executable(&path))
            || hash_file(&path, cancellation)? != file.sha256
        {
            return Err(NativeToolError::InvalidInstall);
        }
    }
    if collect_regular_files(root)? != allowed_tree(delivery) {
        return Err(NativeToolError::InvalidInstall);
    }
    let identity_after = capture_identity(root, delivery)?;
    if identity_before != identity_after {
        return Err(NativeToolError::InvalidInstall);
    }
    Ok(identity_after)
}

pub(crate) fn identity_matches(
    root: &Path,
    delivery: &ToolDelivery,
    expected: &InstallIdentity,
) -> bool {
    capture_identity(root, delivery).is_ok_and(|actual| &actual == expected)
}

pub(crate) fn ownership_matches(root: &Path, delivery: &ToolDelivery) -> bool {
    read(root).is_ok_and(|receipt| receipt == ToolReceipt::from_delivery(delivery))
}

fn capture_identity(root: &Path, delivery: &ToolDelivery) -> Result<InstallIdentity> {
    let expected_receipt = ToolReceipt::from_delivery(delivery);
    if read(root)? != expected_receipt || collect_regular_files(root)? != allowed_tree(delivery) {
        return Err(NativeToolError::InvalidInstall);
    }
    let encoded = serde_json::to_vec(delivery).map_err(|_| NativeToolError::InvalidCatalog)?;
    let delivery_fingerprint = Sha256::digest(encoded).into();
    let mut files = Vec::with_capacity(delivery.files.len() + delivery.notices.len() + 1);
    for expected in expected_files(delivery) {
        let path = resolve_owned(root, &expected.path)?;
        let metadata = require_regular_file(&path)?;
        if metadata.len() != expected.size_bytes || (expected.executable && !is_executable(&path)) {
            return Err(NativeToolError::InvalidInstall);
        }
        files.push(file_identity(&path, &metadata)?);
    }
    let receipt_path = resolve_owned(root, RECEIPT_NAME)?;
    let receipt_metadata = require_regular_file(&receipt_path)?;
    files.push(file_identity(&receipt_path, &receipt_metadata)?);
    Ok(InstallIdentity {
        delivery_fingerprint,
        files,
    })
}

#[cfg_attr(not(windows), allow(clippy::unnecessary_wraps))]
fn file_identity(path: &Path, metadata: &fs::Metadata) -> Result<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;

        let _ = path;
        Ok(FileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
            mode: metadata.mode(),
        })
    }
    #[cfg(windows)]
    {
        let file = fs::File::open(path).map_err(|_| NativeToolError::InvalidInstall)?;
        let information =
            winapi_util::file::information(&file).map_err(|_| NativeToolError::InvalidInstall)?;
        if information.file_size() != metadata.len() {
            return Err(NativeToolError::InvalidInstall);
        }
        Ok(FileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
            volume_serial_number: information.volume_serial_number(),
            file_index: information.file_index(),
            creation_time: information.creation_time(),
            last_write_time: information.last_write_time(),
            file_attributes: information.file_attributes(),
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(FileIdentity {
            size_bytes: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

pub(crate) fn hash_file(path: &Path, cancellation: &CancellationToken) -> Result<String> {
    require_regular_file(path).map_err(|_| NativeToolError::Integrity)?;
    let mut input = fs::File::open(path).map_err(|_| NativeToolError::Integrity)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 256 * 1024].into_boxed_slice();
    loop {
        cancellation.check()?;
        let read = input
            .read(&mut buffer)
            .map_err(|_| NativeToolError::Integrity)?;
        if read == 0 {
            break;
        }
        #[cfg(test)]
        HASHED_BYTES.with(|total| total.set(total.get().saturating_add(read as u64)));
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
pub(crate) fn reset_hashed_bytes() {
    HASHED_BYTES.with(|total| total.set(0));
}

#[cfg(test)]
pub(crate) fn hashed_bytes() -> u64 {
    HASHED_BYTES.with(Cell::get)
}

pub(crate) fn allowed_tree(delivery: &ToolDelivery) -> HashSet<String> {
    expected_files(delivery)
        .into_iter()
        .map(|file| file.path)
        .chain([RECEIPT_NAME.to_string()])
        .collect()
}

fn read(root: &Path) -> Result<ToolReceipt> {
    let path = resolve_owned(root, RECEIPT_NAME)?;
    let metadata = require_regular_file(&path)?;
    if metadata.len() == 0 || metadata.len() > MAX_RECEIPT_BYTES {
        return Err(NativeToolError::InvalidInstall);
    }
    let mut encoded = Vec::with_capacity(
        usize::try_from(metadata.len()).map_err(|_| NativeToolError::InvalidInstall)?,
    );
    fs::File::open(path)
        .map_err(|_| NativeToolError::InvalidInstall)?
        .take(MAX_RECEIPT_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|_| NativeToolError::InvalidInstall)?;
    if encoded.len() as u64 != metadata.len() {
        return Err(NativeToolError::InvalidInstall);
    }
    let receipt: ToolReceipt =
        serde_json::from_slice(&encoded).map_err(|_| NativeToolError::InvalidInstall)?;
    receipt.validate()?;
    Ok(receipt)
}

fn expected_files(delivery: &ToolDelivery) -> Vec<ReceiptFile> {
    delivery
        .files
        .iter()
        .map(|file| ReceiptFile {
            path: file.install_path.clone(),
            size_bytes: file.size_bytes,
            sha256: file.sha256.clone(),
            executable: file.role.is_some(),
            role: file.role,
        })
        .chain(delivery.notices.iter().map(|notice| ReceiptFile {
            path: notice.install_path.clone(),
            size_bytes: notice.size_bytes,
            sha256: notice.sha256.clone(),
            executable: false,
            role: None,
        }))
        .collect()
}

impl ToolReceipt {
    fn from_delivery(delivery: &ToolDelivery) -> Self {
        Self {
            schema_version: 1,
            tool: delivery.tool.as_str().to_string(),
            platform: delivery.platform.clone(),
            version: delivery.version.clone(),
            source_revision: delivery.source_revision.clone(),
            artifact_sha256: delivery.sha256.clone(),
            files: expected_files(delivery),
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != 1 || self.files.is_empty() {
            return Err(NativeToolError::InvalidInstall);
        }
        let mut paths = HashSet::new();
        for file in &self.files {
            validate_relative_path(&file.path).map_err(|_| NativeToolError::InvalidInstall)?;
            if file.size_bytes == 0
                || file.sha256.len() != 64
                || !file
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || !paths.insert(file.path.as_str())
            {
                return Err(NativeToolError::InvalidInstall);
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}
