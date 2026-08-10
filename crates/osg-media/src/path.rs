use crate::{MediaError, Result};
use std::ffi::OsStr;
use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Clone)]
pub struct MediaInput(PathBuf);

impl MediaInput {
    /// Creates a native-only input capability for an existing regular file.
    pub fn from_native_selection(path: impl AsRef<Path>) -> Result<Self> {
        let metadata = std::fs::metadata(path.as_ref()).map_err(|_| MediaError::InvalidPath {
            role: "input",
            reason: "file is unavailable",
        })?;
        if !metadata.is_file() {
            return Err(MediaError::InvalidPath {
                role: "input",
                reason: "not a regular file",
            });
        }
        let canonical =
            std::fs::canonicalize(path.as_ref()).map_err(|_| MediaError::InvalidPath {
                role: "input",
                reason: "canonicalization failed",
            })?;
        Ok(Self(canonical))
    }

    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }
}

impl fmt::Debug for MediaInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MediaInput(<redacted>)")
    }
}

#[derive(Clone)]
pub struct MediaOutput(PathBuf);

impl MediaOutput {
    /// Creates an output capability selected by trusted native code.
    ///
    /// The parent directory must already exist. The output itself may not be a
    /// directory; finalization is no-clobber even if it appears after planning.
    pub fn from_native_target(path: impl AsRef<Path>) -> Result<Self> {
        validate_output(path.as_ref(), None)
    }

    /// Creates an output capability constrained to a cache/workspace root.
    pub fn within_root(path: impl AsRef<Path>, root: impl AsRef<Path>) -> Result<Self> {
        validate_output(path.as_ref(), Some(root.as_ref()))
    }

    pub(crate) fn as_path(&self) -> &Path {
        &self.0
    }

    pub(crate) fn extension(&self) -> Option<&OsStr> {
        self.0.extension()
    }
}

impl fmt::Debug for MediaOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MediaOutput(<redacted>)")
    }
}

fn validate_output(path: &Path, allowed_root: Option<&Path>) -> Result<MediaOutput> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(MediaError::InvalidPath {
            role: "output",
            reason: "an absolute file path is required",
        });
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(MediaError::InvalidPath {
            role: "output",
            reason: "parent traversal is not allowed",
        });
    }
    if path.is_dir() {
        return Err(MediaError::InvalidPath {
            role: "output",
            reason: "target is a directory",
        });
    }

    let parent = path.parent().ok_or(MediaError::InvalidPath {
        role: "output",
        reason: "parent directory is missing",
    })?;
    let parent = std::fs::canonicalize(parent).map_err(|_| MediaError::InvalidPath {
        role: "output",
        reason: "parent directory is unavailable",
    })?;

    if let Some(root) = allowed_root {
        let root = std::fs::canonicalize(root).map_err(|_| MediaError::InvalidPath {
            role: "output",
            reason: "approved root is unavailable",
        })?;
        if !parent.starts_with(root) {
            return Err(MediaError::InvalidPath {
                role: "output",
                reason: "target is outside the approved root",
            });
        }
    }

    Ok(MediaOutput(
        parent.join(path.file_name().expect("checked above")),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_output_never_contains_paths() {
        let directory = tempfile::tempdir().unwrap();
        let input_path = directory.path().join("private-source.mp4");
        std::fs::write(&input_path, b"media").unwrap();
        let input = MediaInput::from_native_selection(&input_path).unwrap();
        let output =
            MediaOutput::within_root(directory.path().join("out.mp4"), directory.path()).unwrap();

        assert_eq!(format!("{input:?}"), "MediaInput(<redacted>)");
        assert_eq!(format!("{output:?}"), "MediaOutput(<redacted>)");
    }

    #[test]
    fn constrained_output_cannot_escape_approved_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let result = MediaOutput::within_root(outside.path().join("out.mp4"), root.path());
        assert!(matches!(result, Err(MediaError::InvalidPath { .. })));
    }
}
