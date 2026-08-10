use crate::{AudioFormat, Result, SpeechError};
use std::fmt;
use std::path::{Path, PathBuf};

const MAX_AUDIO_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_OUTPUT_STEM_CHARS: usize = 100;

/// Canonical native audio-file capability. It cannot be serialized and its
/// path is redacted from debug output.
#[derive(Clone)]
pub struct AudioAsset {
    path: PathBuf,
    format: AudioFormat,
    bytes: u64,
}

impl AudioAsset {
    pub fn from_native_file(path: &Path) -> Result<Self> {
        Self::resolve(path, None, None)
    }

    /// Reopens an extensionless, host-managed artifact using format metadata
    /// that was previously validated and persisted by the native application.
    pub fn from_trusted_native_file(path: &Path, format: AudioFormat) -> Result<Self> {
        Self::resolve(path, None, Some(format))
    }

    pub fn within_root(path: &Path, approved_root: &Path) -> Result<Self> {
        let root = canonical_directory(approved_root)?;
        Self::resolve(path, Some(&root), None)
    }

    fn resolve(
        path: &Path,
        approved_root: Option<&Path>,
        trusted_format: Option<AudioFormat>,
    ) -> Result<Self> {
        if !path.is_absolute() {
            return Err(SpeechError::InvalidAsset("path must be absolute"));
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| SpeechError::InvalidAsset("file unavailable"))?;
        if approved_root.is_some_and(|root| !canonical.starts_with(root)) {
            return Err(SpeechError::InvalidAsset(
                "file is outside the approved root",
            ));
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|_| SpeechError::InvalidAsset("metadata unavailable"))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUDIO_BYTES {
            return Err(SpeechError::InvalidAsset(
                "audio must be a nonempty regular file below 4 GiB",
            ));
        }
        let format = if let Some(format) = trusted_format {
            format
        } else {
            let extension = canonical
                .extension()
                .and_then(|extension| extension.to_str())
                .ok_or(SpeechError::InvalidAsset("audio extension is missing"))?;
            match extension.to_ascii_lowercase().as_str() {
                "wav" | "wave" => AudioFormat::Wav,
                "mp3" => AudioFormat::Mp3,
                "m4a" | "mp4" => AudioFormat::M4a,
                _ => return Err(SpeechError::InvalidAsset("unsupported audio format")),
            }
        };
        Ok(Self {
            path: canonical,
            format,
            bytes: metadata.len(),
        })
    }

    #[must_use]
    pub fn format(&self) -> AudioFormat {
        self.format
    }

    #[must_use]
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn revalidate(&self) -> Result<()> {
        let metadata = std::fs::symlink_metadata(&self.path)
            .map_err(|_| SpeechError::InvalidAsset("file unavailable"))?;
        if !metadata.file_type().is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_AUDIO_BYTES
            || metadata.len() != self.bytes
        {
            return Err(SpeechError::InvalidAsset("audio file changed"));
        }
        Ok(())
    }
}

impl fmt::Debug for AudioAsset {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AudioAsset")
            .field("path", &"<redacted>")
            .field("format", &self.format)
            .field("bytes", &self.bytes)
            .finish()
    }
}

/// Native output capability. Publication always uses a no-clobber operation.
#[derive(Clone)]
pub struct SpeechOutput {
    directory: PathBuf,
    stem: String,
    format: AudioFormat,
}

impl SpeechOutput {
    pub fn from_native_directory(
        directory: &Path,
        suggested_name: &str,
        format: AudioFormat,
    ) -> Result<Self> {
        Ok(Self {
            directory: canonical_directory(directory)?,
            stem: safe_stem(suggested_name),
            format,
        })
    }

    pub fn within_root(
        directory: &Path,
        approved_root: &Path,
        suggested_name: &str,
        format: AudioFormat,
    ) -> Result<Self> {
        let root = canonical_directory(approved_root)?;
        let directory = canonical_directory(directory)?;
        if !directory.starts_with(&root) {
            return Err(SpeechError::InvalidDestination(
                "directory is outside the approved root",
            ));
        }
        Ok(Self {
            directory,
            stem: safe_stem(suggested_name),
            format,
        })
    }

    #[must_use]
    pub fn filename(&self) -> String {
        format!("{}.{}", self.stem, self.format.extension())
    }

    #[must_use]
    pub fn format(&self) -> AudioFormat {
        self.format
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn final_path(&self) -> PathBuf {
        self.directory.join(self.filename())
    }
}

impl fmt::Debug for SpeechOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechOutput")
            .field("directory", &"<redacted>")
            .field("filename", &"<redacted>")
            .field("format", &self.format)
            .finish_non_exhaustive()
    }
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(SpeechError::InvalidDestination(
            "directory must be absolute",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| SpeechError::InvalidDestination("directory unavailable"))?;
    if !canonical.is_dir() {
        return Err(SpeechError::InvalidDestination("not a directory"));
    }
    Ok(canonical)
}

fn safe_stem(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(MAX_OUTPUT_STEM_CHARS));
    let mut count = 0;
    let mut space_pending = false;
    for character in value.chars() {
        if count >= MAX_OUTPUT_STEM_CHARS {
            break;
        }
        if character.is_whitespace() {
            space_pending = !output.is_empty();
            continue;
        }
        if space_pending {
            if count + 1 >= MAX_OUTPUT_STEM_CHARS {
                break;
            }
            output.push(' ');
            count += 1;
            space_pending = false;
        }
        output.push(
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            },
        );
        count += 1;
    }
    let mut output = output.trim_matches([' ', '.', '_']).to_owned();
    if output.is_empty() {
        output.push_str("speech");
    }
    let base = output
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches([' ', '.']);
    let base = base.to_ascii_uppercase();
    if matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .is_some_and(|number| {
                matches!(number, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
    {
        output.insert(0, '_');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_assets_are_capabilities_with_redacted_paths() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("voice.wav");
        std::fs::write(&path, b"RIFFmockWAVEdata").unwrap();
        let asset = AudioAsset::from_native_file(&path).unwrap();
        assert_eq!(asset.format(), AudioFormat::Wav);
        assert!(!format!("{asset:?}").contains(directory.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn trusted_format_reopens_an_extensionless_managed_artifact() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("content-addressed-artifact");
        std::fs::write(&path, b"RIFFmockWAVEdata").unwrap();
        assert!(AudioAsset::from_native_file(&path).is_err());

        let asset = AudioAsset::from_trusted_native_file(&path, AudioFormat::Wav).unwrap();
        assert_eq!(asset.format(), AudioFormat::Wav);
        assert_eq!(asset.bytes(), 16);
    }

    #[test]
    fn output_names_cannot_escape_or_use_device_names() {
        let directory = tempfile::tempdir().unwrap();
        let output = SpeechOutput::from_native_directory(
            directory.path(),
            "../../CON / take",
            AudioFormat::Wav,
        )
        .unwrap();
        assert_eq!(output.filename(), "CON _ take.wav");
        let canonical_directory = std::fs::canonicalize(directory.path()).unwrap();
        assert_eq!(
            output.final_path().parent(),
            Some(canonical_directory.as_path())
        );
        assert!(!format!("{output:?}").contains(directory.path().to_string_lossy().as_ref()));
        assert!(!format!("{output:?}").contains("take"));
    }

    #[test]
    fn root_capability_rejects_sibling_file() {
        let root = tempfile::tempdir().unwrap();
        let sibling = tempfile::tempdir().unwrap();
        let path = sibling.path().join("voice.mp3");
        std::fs::write(&path, b"ID3fixture").unwrap();
        assert!(AudioAsset::within_root(&path, root.path()).is_err());
    }

    #[test]
    fn revalidation_detects_replaced_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("voice.wav");
        std::fs::write(&path, b"RIFFoneWAVEdata").unwrap();
        let asset = AudioAsset::from_native_file(&path).unwrap();
        std::fs::write(&path, b"RIFFdifferentWAVEdata").unwrap();
        assert!(asset.revalidate().is_err());
    }
}
