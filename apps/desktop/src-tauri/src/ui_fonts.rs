use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use osg_engine_packages::{
    CancellationToken, InstalledUiFontRuntime, PackageError, UiFontPackageManager,
};

use crate::font_readiness::{FontReadiness, FontRefusal};

const MAX_STYLESHEET_BYTES: usize = 4 * 1024;
const BOOTSTRAP_WAIT: Duration = Duration::from_secs(8);
const FONT_SUBSETS: [(&str, &str, usize); 3] = [
    ("vietnamese", "__OSG_FONT_VIETNAMESE__", 57_620),
    ("latin-ext", "__OSG_FONT_LATIN_EXT__", 131_208),
    ("latin", "__OSG_FONT_LATIN__", 270_324),
];

/// Translate a delivery failure into the closed reason the interface may show.
///
/// The delivery error itself never crosses this boundary: its text can name a path or a URL, and
/// this value is rendered in the editor and captured in evidence.
fn refusal_of(error: &PackageError) -> FontRefusal {
    match error {
        PackageError::Cancelled => FontRefusal::Cancelled,
        PackageError::ArchiveIntegrity
        | PackageError::IncompleteDownload
        | PackageError::UnsafeArchive
        | PackageError::InvalidInstall => FontRefusal::IntegrityFailed,
        PackageError::StoreUnavailable
        | PackageError::StorageLimit
        | PackageError::InsufficientSpace
        | PackageError::RuntimeBusy => FontRefusal::StoreUnavailable,
        PackageError::DeliveryUnavailable | PackageError::InvalidCatalog => {
            FontRefusal::VersionMismatch
        }
        _ => FontRefusal::NoUsableSource,
    }
}

fn publish(readiness: &Arc<FontReadiness>, outcome: &Result<PreparedUiFont, FontRefusal>) {
    match outcome {
        Ok(prepared) => {
            readiness.mark_ready(prepared.version.clone());
        }
        Err(reason) => {
            readiness.mark_refused(*reason);
        }
    }
}

fn publish_refusal(readiness: &Arc<FontReadiness>, reason: FontRefusal) -> FontRefusal {
    readiness.mark_refused(reason);
    reason
}

/// Holds the verified package lease for as long as the desktop `WebView` may use its CSS.
pub(crate) struct UiFontRuntime {
    _package: InstalledUiFontRuntime,
    css: String,
}

impl fmt::Debug for UiFontRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UiFontRuntime")
            .field("package", &"<verified>")
            .field("css", &"<redacted>")
            .finish()
    }
}

/// What preparation produced, once it finishes.
///
/// The stylesheet travels with the outcome because a late success must still reach the `WebView`:
/// publishing readiness alone would say the font is usable while nothing had installed its faces.
pub(crate) struct PreparedUiFont {
    pub runtime: UiFontRuntime,
    pub version: String,
}

impl UiFontRuntime {
    /// Begin preparing the managed font, waiting only briefly for a fast result.
    ///
    /// Returns the runtime when preparation finished inside `BOOTSTRAP_WAIT`, so the usual case
    /// injects the stylesheet with the first document. Otherwise preparation KEEPS RUNNING and
    /// `on_late` is called with the result when it lands.
    ///
    /// The wait used to be the whole story: exceeding it declared the font permanently unavailable
    /// for the session even though the very same background installation went on to succeed
    /// seconds later. Waiting briefly is a startup-latency decision; it is not a verdict.
    pub(crate) fn prepare(
        root: &Path,
        bundle: Option<PathBuf>,
        readiness: &Arc<FontReadiness>,
        on_late: impl FnOnce(Result<PreparedUiFont, FontRefusal>) + Send + 'static,
    ) -> Result<PreparedUiFont, FontRefusal> {
        let root = root.to_path_buf();
        let (sender, receiver) = mpsc::sync_channel(1);
        // Kept only so the thread can be told the authority still exists; publication is the
        // late handler's job. See the note at the send below.
        let readiness_for_thread = Arc::clone(readiness);
        let spawned = thread::Builder::new()
            .name("osg-ui-font-bootstrap".to_owned())
            .spawn(move || {
                let outcome = Self::prepare_blocking(&root, bundle);
                // The receiver is gone once the caller stopped waiting, and that is the case this
                // exists for: hand the result to the late path instead of dropping it.
                //
                // The late handler publishes readiness itself, and must do so only after the
                // stylesheet has reached the `WebView`. Announcing `Ready` first would tell the
                // editor a font is usable while none of its faces had been installed.
                if let Err(mpsc::TrySendError::Disconnected(outcome)) = sender.try_send(outcome) {
                    drop(readiness_for_thread);
                    on_late(outcome);
                }
            });
        if spawned.is_err() {
            return Err(publish_refusal(readiness, FontRefusal::StoreUnavailable));
        }

        match receiver.recv_timeout(BOOTSTRAP_WAIT) {
            Ok(outcome) => {
                publish(readiness, &outcome);
                outcome
            }
            // Still working. Deliberately not a refusal a caller can mistake for absence: the state
            // stays `Repairing` until the background attempt actually reports.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                readiness.mark_repairing();
                Err(FontRefusal::TimedOut)
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(publish_refusal(readiness, FontRefusal::NoUsableSource))
            }
        }
    }

    /// Try again, without blocking the caller.
    ///
    /// `prepare` waits briefly because startup has to decide whether the first document can carry
    /// the stylesheet. A retry has no such deadline: the window already exists, so the work runs in
    /// the background and reports through `on_done` exactly as a late first attempt does.
    pub(crate) fn repair(
        root: &Path,
        bundle: Option<PathBuf>,
        readiness: &Arc<FontReadiness>,
        on_done: impl FnOnce(Result<PreparedUiFont, FontRefusal>) + Send + 'static,
    ) -> io::Result<()> {
        let root = root.to_path_buf();
        readiness.mark_repairing();
        thread::Builder::new()
            .name("osg-ui-font-repair".to_owned())
            .spawn(move || on_done(Self::prepare_blocking(&root, bundle)))?;
        Ok(())
    }

    fn prepare_blocking(
        root: &Path,
        bundle: Option<PathBuf>,
    ) -> Result<PreparedUiFont, FontRefusal> {
        // Bytes shipped with the application are preferred over the network, so a clean offline
        // install resolves the default subtitle font instead of timing out with it unavailable.
        let manager = UiFontPackageManager::with_bundled_sources(root, Arc::new(|| Ok(())), bundle)
            .map_err(|error| refusal_of(&error))?;
        let status = manager.status();
        let cancellation = CancellationToken::default();
        if !status.installed || status.update_available {
            manager
                .install(&cancellation, &|_| {})
                .map_err(|error| refusal_of(&error))?;
        }
        // `resolve` is what proves the installation is complete and verified on disk, so nothing
        // before this line may be reported as ready.
        let package = manager
            .resolve(&cancellation)
            .map_err(|error| refusal_of(&error))?;
        let version = package.version().to_owned();
        let css = compose_css(&package).map_err(|_| FontRefusal::IntegrityFailed)?;
        Ok(PreparedUiFont {
            runtime: Self {
                _package: package,
                css,
            },
            version,
        })
    }

    pub(crate) fn css(&self) -> &str {
        &self.css
    }
}

fn compose_css(package: &InstalledUiFontRuntime) -> io::Result<String> {
    let stylesheet = read_bounded(package.stylesheet(), MAX_STYLESHEET_BYTES)?;
    let mut css = String::from_utf8(stylesheet)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid managed font CSS"))?;

    for (subset, token, expected_bytes) in FONT_SUBSETS {
        if css.matches(token).count() != 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid managed font CSS token",
            ));
        }
        let font = read_exact(
            &package.font_file(subset).map_err(io::Error::other)?,
            expected_bytes,
        )?;
        let data_url = format!("data:font/woff2;base64,{}", BASE64.encode(font));
        css = css.replacen(token, &data_url, 1);
    }

    if css.contains("__OSG_FONT_") || css.contains("file://") || css.contains("\\\\") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed font CSS retained a private location",
        ));
    }
    Ok(css)
}

fn read_bounded(path: &Path, maximum: usize) -> io::Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > maximum as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed font asset exceeded its bound",
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.len() > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed font asset exceeded its bound",
        ));
    }
    Ok(bytes)
}

fn read_exact(path: &Path, expected: usize) -> io::Result<Vec<u8>> {
    let bytes = read_bounded(path, expected)?;
    if bytes.len() != expected {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "managed font asset had an invalid length",
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use std::sync::Arc;

    use super::{FONT_SUBSETS, UiFontRuntime, read_bounded};
    use crate::font_readiness::{FontReadiness, FontState};

    #[test]
    fn managed_font_contract_has_unique_bounded_subsets() {
        let names = FONT_SUBSETS.map(|(name, _, _)| name);
        assert_eq!(names, ["vietnamese", "latin-ext", "latin"]);
        for (index, (_, token, size)) in FONT_SUBSETS.iter().enumerate() {
            assert!(token.starts_with("__OSG_FONT_"));
            assert!(*size > 0);
            assert!(
                !FONT_SUBSETS[index + 1..]
                    .iter()
                    .any(|(_, other, _)| other == token)
            );
        }
    }

    #[test]
    fn bounded_reader_rejects_oversized_assets_before_reading_them() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("font.css");
        std::fs::write(&path, vec![b'x'; 17]).expect("write fixture");
        let error = read_bounded(&path, 16).expect_err("oversized asset must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }

    /// The directory of digest-named font files shipped inside the application.
    fn shipped_bundle() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/ui-fonts")
    }

    /// Every byte the catalog pins is actually in the payload.
    ///
    /// This is the test that makes "works offline" a fact rather than a hope. The installation test
    /// below would still pass on a machine with a network connection if a file were missing from
    /// the bundle — it would quietly download the absent one — so completeness is asserted against
    /// the catalog directly, by digest, with no network available to cover a gap.
    #[test]
    fn the_shipped_bundle_covers_every_pinned_delivery_source() {
        let delivery = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../crates/osg-engine-packages/delivery/ui-fonts.delivery.json");
        let catalog: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&delivery).expect("delivery catalog"))
                .expect("catalog parses");
        let bundle = shipped_bundle();

        let mut checked = 0;
        for (platform, entry) in catalog["platforms"].as_object().expect("platform table") {
            for release in entry["releases"].as_array().expect("releases") {
                let sources = release["sources"]
                    .as_array()
                    .expect("sources")
                    .iter()
                    .chain(std::iter::once(&release["manifest"]));
                for source in sources {
                    let digest = source["sha256"].as_str().expect("pinned digest");
                    let size = source["sizeBytes"].as_u64().expect("pinned size");
                    let path = bundle.join(digest);
                    let metadata = std::fs::metadata(&path).unwrap_or_else(|_| {
                        panic!(
                            "{platform} pins {} but the application ships no file for {digest}",
                            source["asset"].as_str().unwrap_or("?")
                        )
                    });
                    assert_eq!(metadata.len(), size, "{digest} is the wrong length");
                    checked += 1;
                }
            }
        }
        assert!(checked >= 7, "expected the catalog to pin real sources");
    }

    /// The bundled bytes really do compose into the stylesheet the `WebView` receives.
    ///
    /// This used to be `#[ignore]`d because it downloaded the package, which meant it never ran and
    /// never protected anything — the font install could break and every gate stayed green. It runs
    /// by default now: the bytes are in the payload, so it needs no network and takes no time.
    #[test]
    fn the_shipped_bundle_installs_and_composes_path_free_css() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let readiness = Arc::new(FontReadiness::new("Google Sans"));
        let prepared =
            UiFontRuntime::prepare(directory.path(), Some(shipped_bundle()), &readiness, |_| {})
                .expect("the managed font must install from the bytes the application ships");
        let css = prepared.runtime.css();
        assert_eq!(css.matches("data:font/woff2;base64,").count(), 3);
        assert!(!css.contains("__OSG_FONT_"));
        assert!(!css.contains("file://"));
        assert!(css.len() > 500_000);
        assert!(css.len() < 700_000);
        assert!(
            !prepared.version.is_empty(),
            "readiness must be able to name the version"
        );
    }

    /// Readiness reaches `Ready` only after the bytes are actually installed and verified.
    #[test]
    fn a_successful_preparation_publishes_ready_with_its_version() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let readiness = Arc::new(FontReadiness::new("Google Sans"));
        assert_eq!(readiness.snapshot().state, FontState::Resolving);

        let prepared =
            UiFontRuntime::prepare(directory.path(), Some(shipped_bundle()), &readiness, |_| {})
                .expect("preparation succeeds from the shipped bytes");
        let snapshot = readiness.snapshot();
        assert_eq!(snapshot.state, FontState::Ready);
        assert_eq!(snapshot.version, Some(prepared.version));
        assert!(
            snapshot.epoch > 0,
            "the initial state must have been superseded"
        );
    }

    /// A preparation that cannot succeed publishes a typed, actionable refusal.
    ///
    /// The store root is a FILE rather than a directory, so the package store cannot be created.
    /// An earlier version of this test used an empty bundle directory and asserted failure, which
    /// passed only on a machine with no network: with one, the delivery fallback simply downloaded
    /// the font and the test failed for being right about the product and wrong about the world.
    #[test]
    fn an_impossible_preparation_publishes_a_typed_refusal() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let blocked = directory.path().join("not-a-directory");
        std::fs::write(&blocked, b"this is a file").expect("write the blocking file");
        let readiness = Arc::new(FontReadiness::new("Google Sans"));

        let outcome = UiFontRuntime::prepare(&blocked, Some(shipped_bundle()), &readiness, |_| {});
        assert!(outcome.is_err(), "an unusable store cannot produce a font");

        let snapshot = readiness.snapshot();
        assert_ne!(snapshot.state, FontState::Ready);
        assert_eq!(snapshot.state, FontState::Refused);
        assert!(snapshot.reason.is_some(), "a refusal must say why");
        // The point of the whole exercise: a refusal is a state the interface can act on, not a
        // silent permanent `false`.
        assert!(snapshot.epoch > 0);
    }
}
