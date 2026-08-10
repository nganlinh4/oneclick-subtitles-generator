use crate::{AsrError, Result};
use std::fmt;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
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

fn validate_pcm16_wav(file: &mut File, file_len: u64) -> Result<u64> {
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff)
        .map_err(|_| AsrError::InvalidAudio)?;
    if &riff[..4] != b"RIFF" || &riff[8..] != b"WAVE" {
        return Err(AsrError::InvalidAudio);
    }

    let declared_len = u64::from(u32::from_le_bytes(riff[4..8].try_into().unwrap())) + 8;
    if declared_len > file_len || declared_len < 44 {
        return Err(AsrError::InvalidAudio);
    }

    let mut format_valid = false;
    let mut data_bytes = None;
    while file.stream_position().map_err(|_| AsrError::InvalidAudio)? + 8 <= file_len {
        let chunk_start = file.stream_position().map_err(|_| AsrError::InvalidAudio)?;
        if chunk_start > MAX_HEADER_SCAN_BYTES && data_bytes.is_none() {
            return Err(AsrError::InvalidAudio);
        }
        let mut header = [0_u8; 8];
        file.read_exact(&mut header)
            .map_err(|_| AsrError::InvalidAudio)?;
        let size = u64::from(u32::from_le_bytes(header[4..].try_into().unwrap()));
        let payload_start = file.stream_position().map_err(|_| AsrError::InvalidAudio)?;
        let payload_end = payload_start
            .checked_add(size)
            .ok_or(AsrError::InvalidAudio)?;
        if payload_end > file_len || payload_end > declared_len {
            return Err(AsrError::InvalidAudio);
        }

        match &header[..4] {
            b"fmt " => {
                if !(16..=4_096).contains(&size) {
                    return Err(AsrError::InvalidAudio);
                }
                let mut format = [0_u8; 16];
                file.read_exact(&mut format)
                    .map_err(|_| AsrError::InvalidAudio)?;
                let encoding = u16::from_le_bytes(format[0..2].try_into().unwrap());
                let channels = u16::from_le_bytes(format[2..4].try_into().unwrap());
                let sample_rate = u32::from_le_bytes(format[4..8].try_into().unwrap());
                let byte_rate = u32::from_le_bytes(format[8..12].try_into().unwrap());
                let block_align = u16::from_le_bytes(format[12..14].try_into().unwrap());
                let bits = u16::from_le_bytes(format[14..16].try_into().unwrap());
                format_valid = encoding == 1
                    && channels == 1
                    && sample_rate == EXPECTED_SAMPLE_RATE
                    && byte_rate == EXPECTED_BYTES_PER_SECOND
                    && block_align == 2
                    && bits == 16;
            }
            b"data" => {
                if size == 0 || size % 2 != 0 {
                    return Err(AsrError::InvalidAudio);
                }
                data_bytes = Some(size);
            }
            _ => {}
        }

        let padded_end = payload_end
            .checked_add(size % 2)
            .ok_or(AsrError::InvalidAudio)?;
        if padded_end > file_len || padded_end > declared_len {
            return Err(AsrError::InvalidAudio);
        }
        file.seek(SeekFrom::Start(padded_end))
            .map_err(|_| AsrError::InvalidAudio)?;
        if format_valid && data_bytes.is_some() {
            break;
        }
    }
    if !format_valid {
        return Err(AsrError::InvalidAudio);
    }
    data_bytes.ok_or(AsrError::InvalidAudio)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub(crate) fn write_wav(path: &Path, milliseconds: u32) {
        let data_len = EXPECTED_BYTES_PER_SECOND * milliseconds / 1_000;
        let riff_len = 36 + data_len;
        let mut bytes = Vec::with_capacity((44 + data_len) as usize);
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&riff_len.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&EXPECTED_SAMPLE_RATE.to_le_bytes());
        bytes.extend_from_slice(&EXPECTED_BYTES_PER_SECOND.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&16_u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_len.to_le_bytes());
        bytes.resize((44 + data_len) as usize, 0);
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
    }
}
