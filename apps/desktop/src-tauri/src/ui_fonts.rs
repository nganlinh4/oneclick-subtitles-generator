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
use osg_engine_packages::{CancellationToken, InstalledUiFontRuntime, UiFontPackageManager};

const MAX_STYLESHEET_BYTES: usize = 4 * 1024;
const BOOTSTRAP_WAIT: Duration = Duration::from_secs(8);
const FONT_SUBSETS: [(&str, &str, usize); 3] = [
    ("vietnamese", "__OSG_FONT_VIETNAMESE__", 57_620),
    ("latin-ext", "__OSG_FONT_LATIN_EXT__", 131_208),
    ("latin", "__OSG_FONT_LATIN__", 270_324),
];

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

impl UiFontRuntime {
    pub(crate) fn prepare(root: &Path, bundle: Option<PathBuf>) -> io::Result<Self> {
        let root = root.to_path_buf();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("osg-ui-font-bootstrap".to_owned())
            .spawn(move || {
                let _ = sender.send(Self::prepare_blocking(&root, bundle.clone()).ok());
            })?;
        match receiver.recv_timeout(BOOTSTRAP_WAIT) {
            Ok(Some(runtime)) => Ok(runtime),
            Ok(None) => Err(io::Error::other(
                "the managed UI font could not be prepared",
            )),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the managed UI font will finish installing in the background",
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::other(
                "the managed UI font bootstrap stopped unexpectedly",
            )),
        }
    }

    fn prepare_blocking(
        root: &Path,
        bundle: Option<PathBuf>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        // Bytes shipped with the application are preferred over the network, so a clean offline
        // install resolves the default subtitle font instead of timing out with it unavailable.
        let manager =
            UiFontPackageManager::with_bundled_sources(root, Arc::new(|| Ok(())), bundle)?;
        let status = manager.status();
        let cancellation = CancellationToken::default();
        if !status.installed || status.update_available {
            manager.install(&cancellation, &|_| {})?;
        }
        let package = manager.resolve(&cancellation)?;
        let css = compose_css(&package)?;
        Ok(Self {
            _package: package,
            css,
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

    use super::{FONT_SUBSETS, UiFontRuntime, read_bounded};

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
        let runtime = UiFontRuntime::prepare(directory.path(), Some(shipped_bundle()))
            .expect("the managed font must install from the bytes the application ships");
        assert_eq!(runtime.css().matches("data:font/woff2;base64,").count(), 3);
        assert!(!runtime.css().contains("__OSG_FONT_"));
        assert!(!runtime.css().contains("file://"));
        assert!(runtime.css().len() > 500_000);
        assert!(runtime.css().len() < 700_000);
    }
}
