use crate::{AsrError, Result};
use osg_formats::wav::{self, WavFormat};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024 * 1024;
const MAX_HEADER_SCAN_BYTES: u64 = 1024 * 1024;
const EXPECTED_SAMPLE_RATE: u32 = 16_000;
const EXPECTED_BYTES_PER_SECOND: u32 = 32_000;

#[derive(Clone)]
pub struct NormalizedAudio {
    path: PathBuf,
    duration_ms: u64,
    bytes: u64,
}

impl NormalizedAudio {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = std::fs::canonicalize(path).map_err(|_| AsrError::InvalidAudio)?;
        let metadata = std::fs::metadata(&path).map_err(|_| AsrError::InvalidAudio)?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUDIO_BYTES {
            return Err(AsrError::InvalidAudio);
        }
        let mut file = File::open(&path).map_err(|_| AsrError::InvalidAudio)?;
        let data_bytes = validate_pcm16_wav(&mut file, metadata.len())?;
        let duration_ms = data_bytes
            .checked_mul(1_000)
            .ok_or(AsrError::InvalidAudio)?
            / u64::from(EXPECTED_BYTES_PER_SECOND);
        if duration_ms == 0 {
            return Err(AsrError::InvalidAudio);
        }
        Ok(Self {
            path,
            duration_ms,
            bytes: metadata.len(),
        })
    }

    #[must_use]
    pub const fn duration_ms(&self) -> u64 {
        self.duration_ms
    }

    #[must_use]
    pub const fn bytes(&self) -> u64 {
        self.bytes
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn revalidate(&self) -> Result<()> {
        let metadata = std::fs::metadata(&self.path).map_err(|_| AsrError::InvalidAudio)?;
        if !metadata.is_file() || metadata.len() != self.bytes {
            return Err(AsrError::InvalidAudio);
        }
        Ok(())
    }
}

impl fmt::Debug for NormalizedAudio {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NormalizedAudio")
            .field("path", &"<redacted>")
            .field("duration_ms", &self.duration_ms)
            .field("bytes", &self.bytes)
            .finish()
    }
}

/// Returns the sample byte count of a 16 kHz mono PCM16 WAV. Only the first MiB is scanned for the
/// `data` chunk; the samples themselves may extend to the end of the file.
fn validate_pcm16_wav(file: &mut File, file_len: u64) -> Result<u64> {
    let mut header = Vec::new();
    file.take(MAX_HEADER_SCAN_BYTES + 8)
        .read_to_end(&mut header)
        .map_err(|_| AsrError::InvalidAudio)?;
    let layout = wav::parse_header(&header, file_len).map_err(|_| AsrError::InvalidAudio)?;
    let declared_len = layout.declared_len;
    if declared_len > file_len || declared_len < 44 || layout.data_end() > declared_len {
        return Err(AsrError::InvalidAudio);
    }
    if layout.format != WavFormat::pcm16(EXPECTED_SAMPLE_RATE, 1)
        || layout.data_len == 0
        || !layout.data_len.is_multiple_of(2)
    {
        return Err(AsrError::InvalidAudio);
    }
    Ok(layout.data_len)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) fn write_wav(path: &Path, milliseconds: u32) {
        let data_len = EXPECTED_BYTES_PER_SECOND * milliseconds / 1_000;
        let samples = vec![0; usize::try_from(data_len).unwrap()];
        let bytes = wav::encode(WavFormat::pcm16(EXPECTED_SAMPLE_RATE, 1), &samples).unwrap();
        std::fs::write(path, bytes).unwrap();
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::write_wav;
    use super::*;

    #[test]
    fn accepts_only_real_normalized_audio_and_redacts_its_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private-recording.bin");
        write_wav(&path, 1_500);
        let audio = NormalizedAudio::open(&path).unwrap();
        assert_eq!(audio.duration_ms(), 1_500);
        let debug = format!("{audio:?}");
        assert!(!debug.contains("private-recording"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn rejects_spoofed_truncated_and_non_mono_audio() {
        let directory = tempfile::tempdir().unwrap();
        let spoofed = directory.path().join("spoofed.wav");
        std::fs::write(&spoofed, b"not a wave file").unwrap();
        assert!(NormalizedAudio::open(&spoofed).is_err());

        let truncated = directory.path().join("truncated.wav");
        write_wav(&truncated, 100);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&truncated)
            .unwrap();
        file.set_len(50).unwrap();
        assert!(NormalizedAudio::open(&truncated).is_err());

        let stereo = directory.path().join("stereo.wav");
        write_wav(&stereo, 100);
        let mut bytes = std::fs::read(&stereo).unwrap();
        bytes[22..24].copy_from_slice(&2_u16.to_le_bytes());
        std::fs::write(&stereo, bytes).unwrap();
        assert!(NormalizedAudio::open(&stereo).is_err());

        let short_riff = directory.path().join("short-riff.wav");
        write_wav(&short_riff, 100);
        let mut bytes = std::fs::read(&short_riff).unwrap();
        bytes[4..8].copy_from_slice(&36_u32.to_le_bytes());
        std::fs::write(&short_riff, bytes).unwrap();
        assert!(NormalizedAudio::open(&short_riff).is_err());
    }
}
