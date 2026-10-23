//! Digest-addressed offline delivery from bytes shipped with the application.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use super::{ArchiveFetcher, FetchRequest};
use crate::catalog::DeliveryAsset;
use crate::receipt::hash_file;
use crate::{OperationPhase, OperationProgress, PackageError, Result};
/// Serves a delivery asset from bytes shipped inside the application, before any network use.
///
/// WHY THIS EXISTS. The managed UI font is the default subtitle font, and it was delivered purely
/// on demand: first launch downloaded three `.woff2` subsets, the stylesheet, the OFL text and the
/// family notice. Measured on a fresh profile, that did not finish inside the eight seconds startup
/// waits for, so the application declared the font unavailable, the default font resolved to
/// nothing, and the editor's preview stayed dormant for the whole session. Offline, it could never
/// have worked at all. A default that needs the network is not a default.
///
/// WHAT IT DOES NOT CHANGE. The catalog, its pinned sizes and its SHA-256s are untouched, and the
/// bytes served here are verified against exactly the same digest as a downloaded copy — by the
/// same `verify_asset` call, plus once here so a damaged bundle degrades to a download instead of
/// failing the install. Files are addressed by their digest, so a bundled file that is not the file
/// the catalog pins simply does not match and is not used. This adds an offline source; it does not
/// add a way to install something unreviewed.
pub(crate) struct BundledArchiveFetcher {
    directory: PathBuf,
    inner: Arc<dyn ArchiveFetcher>,
}

impl std::fmt::Debug for BundledArchiveFetcher {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BundledArchiveFetcher")
            .field("directory", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl BundledArchiveFetcher {
    pub(crate) fn new(directory: PathBuf, inner: Arc<dyn ArchiveFetcher>) -> Self {
        Self { directory, inner }
    }

    /// The bundled path for an asset, or `None` when nothing usable is shipped for it.
    ///
    /// Content-addressed rather than named after the asset: two catalog entries may share bytes,
    /// and a filename says nothing about what a file contains.
    fn candidate(&self, asset: &DeliveryAsset) -> Option<PathBuf> {
        // A digest is the filename, so anything that is not one cannot select a file. The catalog
        // loader already rejects a malformed digest; this keeps that guarantee local.
        if asset.sha256.len() != 64 || !asset.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let path = self.directory.join(&asset.sha256);
        let metadata = fs::metadata(&path).ok()?;
        (metadata.is_file() && metadata.len() == asset.size_bytes).then_some(path)
    }
}

impl ArchiveFetcher for BundledArchiveFetcher {
    fn fetch(
        &self,
        asset: &DeliveryAsset,
        declared_url: &str,
        request: FetchRequest<'_>,
    ) -> Result<Option<String>> {
        // A resumed transfer is a partial network download being continued. There is nothing to
        // resume for a local file, and appending to one would corrupt it, so it goes to the network.
        if request.resume_from > 0 {
            return self.inner.fetch(asset, declared_url, request);
        }
        let Some(source) = self.candidate(asset) else {
            return self.inner.fetch(asset, declared_url, request);
        };
        request.cancellation.check()?;

        match hash_file(&source, request.cancellation) {
            Ok(digest) if digest == asset.sha256 => {}
            Err(PackageError::Cancelled) => return Err(PackageError::Cancelled),
            // Present but not what the catalog pins: treat the bundle as absent rather than as a
            // failure, so a damaged payload costs a download instead of the whole feature.
            _ => return self.inner.fetch(asset, declared_url, request),
        }

        fs::copy(&source, request.target).map_err(|_| PackageError::StoreUnavailable)?;
        request.progress.on_progress(OperationProgress::new(
            OperationPhase::Downloading,
            asset.size_bytes,
            asset.size_bytes,
        ));
        // No entity tag: there is no upstream response to revalidate against.
        Ok(None)
    }
}
