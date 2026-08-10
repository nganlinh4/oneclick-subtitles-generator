use crate::{DownloadError, Result};
use serde::Serialize;
use std::fmt;
use std::path::{Path, PathBuf};

const MAX_STEM_CHARS: usize = 120;

/// A filename stem that cannot introduce path separators or platform-special
/// names. It is safe to display and serialize, but contains no directory.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SafeFileStem(String);

impl SafeFileStem {
    #[must_use]
    pub fn new(suggested: &str) -> Self {
        let mut value = String::with_capacity(suggested.len().min(MAX_STEM_CHARS));
        let mut separator_pending = false;
        let mut characters = 0;
        for character in suggested.chars() {
            if characters >= MAX_STEM_CHARS {
                break;
            }
            if character.is_whitespace() {
                separator_pending = !value.is_empty();
                continue;
            }
            if separator_pending {
                if characters + 1 >= MAX_STEM_CHARS {
                    break;
                }
                value.push(' ');
                characters += 1;
                separator_pending = false;
            }
            let allowed = character.is_alphanumeric()
                || matches!(character, '-' | '_' | '.' | '(' | ')' | '[' | ']');
            value.push(if allowed { character } else { '_' });
            characters += 1;
        }

        let trimmed = value.trim_matches([' ', '.', '_']).to_owned();
        let mut value = if trimmed.is_empty() {
            "download".to_owned()
        } else {
            trimmed
        };
        let base = value.split('.').next().unwrap_or_default();
        if is_windows_reserved(base) {
            value.insert(0, '_');
        }
        Self(value)
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn with_extension(&self, extension: &str) -> PathBuf {
        debug_assert!(extension.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        PathBuf::from(format!("{}.{}", self.0, extension))
    }
}

impl fmt::Debug for SafeFileStem {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("SafeFileStem")
            .field(&self.0)
            .finish()
    }
}

/// Native-only destination capability. The canonical directory is never
/// serialized or included in debug output.
#[derive(Clone)]
pub struct DownloadDestination {
    directory: PathBuf,
    stem: SafeFileStem,
}

impl DownloadDestination {
    /// Creates a destination in an existing absolute directory.
    pub fn from_native_directory(directory: &Path, suggested_name: &str) -> Result<Self> {
        let directory = canonical_directory(directory)?;
        Ok(Self {
            directory,
            stem: SafeFileStem::new(suggested_name),
        })
    }

    /// Creates a destination only if its canonical directory is contained by
    /// an approved canonical root.
    pub fn within_root(
        directory: &Path,
        approved_root: &Path,
        suggested_name: &str,
    ) -> Result<Self> {
        let root = canonical_directory(approved_root)?;
        let directory = canonical_directory(directory)?;
        if !directory.starts_with(&root) {
            return Err(DownloadError::InvalidDestination(
                "directory is outside the approved root",
            ));
        }
        Ok(Self {
            directory,
            stem: SafeFileStem::new(suggested_name),
        })
    }

    #[must_use]
    pub fn stem(&self) -> &SafeFileStem {
        &self.stem
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn output_path(&self, extension: &str) -> PathBuf {
        self.directory.join(self.stem.with_extension(extension))
    }

    pub(crate) fn subtitle_path(&self, language: &str) -> PathBuf {
        self.directory
            .join(format!("{}.{}.srt", self.stem.as_str(), language))
    }
}

impl fmt::Debug for DownloadDestination {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadDestination")
            .field("directory", &"<redacted>")
            .field("stem", &self.stem)
            .finish()
    }
}

/// Trusted `FFmpeg` installation selected by native code. Its canonical
/// executable is passed to yt-dlp; a `WebView` cannot construct this capability.
#[derive(Clone)]
pub struct FfmpegDirectory(PathBuf);

impl FfmpegDirectory {
    pub fn new(directory: &Path) -> Result<Self> {
        let directory = canonical_directory(directory)?;
        let executable = directory.join(if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        });
        let capability = Self::from_executable(&executable)?;
        if !capability.0.starts_with(&directory) {
            return Err(DownloadError::InvalidDestination(
                "FFmpeg executable is outside its approved directory",
            ));
        }
        Ok(capability)
    }

    /// Revalidates an exact `FFmpeg` executable previously resolved by another
    /// native subsystem. The path is never serializable or exposed in debug.
    pub fn from_executable(executable: &Path) -> Result<Self> {
        if !executable.is_absolute() {
            return Err(DownloadError::InvalidDestination(
                "FFmpeg executable must be absolute",
            ));
        }
        let executable = std::fs::canonicalize(executable)
            .map_err(|_| DownloadError::InvalidDestination("FFmpeg executable unavailable"))?;
        if !executable.is_file() {
            return Err(DownloadError::InvalidDestination(
                "FFmpeg executable is not a file",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::metadata(&executable)
                .map_err(|_| DownloadError::InvalidDestination("FFmpeg metadata unavailable"))?
                .permissions()
                .mode()
                & 0o111
                == 0
            {
                return Err(DownloadError::InvalidDestination(
                    "FFmpeg is not executable",
                ));
            }
        }
        Ok(Self(executable))
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Debug for FfmpegDirectory {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_tuple("FfmpegDirectory")
            .field(&"<redacted>")
            .finish()
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(DownloadError::InvalidDestination(
            "directory must be absolute",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| DownloadError::InvalidDestination("directory unavailable"))?;
    if !canonical.is_dir() {
        return Err(DownloadError::InvalidDestination("not a directory"));
    }
    Ok(canonical)
}

fn is_windows_reserved(value: &str) -> bool {
    let upper = value.trim_end_matches([' ', '.']).to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_hostile_and_reserved_names() {
        assert_eq!(SafeFileStem::new("../../evil|name\0").as_str(), "evil_name");
        assert_eq!(SafeFileStem::new("CON.txt").as_str(), "_CON.txt");
        assert_eq!(SafeFileStem::new("... ").as_str(), "download");
        assert_eq!(SafeFileStem::new("한국어 제목").as_str(), "한국어 제목");
    }

    #[test]
    fn destination_debug_redacts_directory() {
        let directory = tempfile::tempdir().unwrap();
        let destination =
            DownloadDestination::from_native_directory(directory.path(), "video").unwrap();
        let debug = format!("{destination:?}");
        assert!(!debug.contains(directory.path().to_string_lossy().as_ref()));
        assert!(debug.contains("video"));
    }

    #[test]
    fn approved_root_rejects_sibling() {
        let root = tempfile::tempdir().unwrap();
        let sibling = tempfile::tempdir().unwrap();
        assert!(DownloadDestination::within_root(sibling.path(), root.path(), "x").is_err());
    }

    #[test]
    fn exact_ffmpeg_capability_is_canonical_and_debug_redacted() {
        let executable = std::env::current_exe().expect("test executable");
        let ffmpeg = FfmpegDirectory::from_executable(&executable).expect("FFmpeg capability");
        assert_eq!(ffmpeg.path(), std::fs::canonicalize(&executable).unwrap());
        let debug = format!("{ffmpeg:?}");
        assert!(!debug.contains(executable.to_string_lossy().as_ref()));
        assert!(debug.contains("<redacted>"));
    }
}
