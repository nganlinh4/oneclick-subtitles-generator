use std::fmt;
use std::fs;
use std::io;
use std::path::Path;
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
    pub(crate) fn prepare(root: &Path) -> io::Result<Self> {
        let root = root.to_path_buf();
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("osg-ui-font-bootstrap".to_owned())
            .spawn(move || {
                let _ = sender.send(Self::prepare_blocking(&root).ok());
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

    fn prepare_blocking(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let manager = UiFontPackageManager::new(root, Arc::new(|| Ok(())))?;
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

    #[test]
    #[ignore = "downloads and verifies the reviewed Google Sans Flex package"]
    fn live_bootstrap_installs_and_composes_path_free_css() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let runtime = UiFontRuntime::prepare(directory.path()).expect("managed font runtime");
        assert_eq!(runtime.css().matches("data:font/woff2;base64,").count(), 3);
        assert!(!runtime.css().contains("__OSG_FONT_"));
        assert!(!runtime.css().contains("file://"));
        assert!(runtime.css().len() > 500_000);
        assert!(runtime.css().len() < 700_000);
    }
}
