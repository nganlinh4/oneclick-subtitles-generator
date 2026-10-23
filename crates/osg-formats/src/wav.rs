//! RIFF/WAVE header parsing and PCM WAV writing.
//!
//! [`parse_header`] walks the chunk list of a header prefix: every chunk before `data` must lie
//! wholly inside the prefix, `fmt ` must precede `data`, and `data` must fit inside the file. What
//! the samples must look like (rate, channels, RIFF size policy) stays with each caller.

use std::fmt;

const RIFF_HEADER_BYTES: usize = 12;
const CHUNK_HEADER_BYTES: usize = 8;
const FORMAT_BYTES: usize = 16;
pub const WAVE_FORMAT_PCM: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WavFormat {
    pub encoding: u16,
    pub channels: u16,
    pub sample_rate: u32,
    pub byte_rate: u32,
    pub block_align: u16,
    pub bits_per_sample: u16,
}

impl WavFormat {
    /// Signed 16-bit little-endian PCM.
    #[must_use]
    pub fn pcm16(sample_rate: u32, channels: u16) -> Self {
        let block_align = channels.saturating_mul(2);
        Self {
            encoding: WAVE_FORMAT_PCM,
            channels,
            sample_rate,
            byte_rate: sample_rate.saturating_mul(u32::from(block_align)),
            block_align,
            bits_per_sample: 16,
        }
    }

    fn parse(body: &[u8]) -> Option<Self> {
        let body = body.get(..FORMAT_BYTES)?;
        Some(Self {
            encoding: u16_at(body, 0)?,
            channels: u16_at(body, 2)?,
            sample_rate: u32_at(body, 4)?,
            byte_rate: u32_at(body, 8)?,
            block_align: u16_at(body, 12)?,
            bits_per_sample: u16_at(body, 14)?,
        })
    }
}

/// Where the parts of a WAV file are, as offsets into the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WavLayout {
    /// File length declared by the RIFF header (its size field plus eight).
    pub declared_len: u64,
    pub format: WavFormat,
    /// Offset of the `data` chunk's own eight-byte header.
    pub data_chunk: usize,
    /// Offset of the first sample byte.
    pub data_offset: usize,
    pub data_len: u64,
}

impl WavLayout {
    #[must_use]
    pub fn data_end(&self) -> u64 {
        u64::try_from(self.data_offset)
            .unwrap_or(u64::MAX)
            .saturating_add(self.data_len)
    }

    /// The sample bytes, when `bytes` holds the whole file.
    #[must_use]
    pub fn samples<'a>(&self, bytes: &'a [u8]) -> Option<&'a [u8]> {
        let end = usize::try_from(self.data_end()).ok()?;
        bytes.get(self.data_offset..end)
    }

    /// A WAV with this file's header chunks and `samples` as its data, with both RIFF and data
    /// sizes rewritten. `None` when `header` is shorter than the parsed layout or the result
    /// exceeds the format's 4 GiB limit.
    #[must_use]
    pub fn with_samples(&self, header: &[u8], samples: &[u8]) -> Option<Vec<u8>> {
        let mut wav = header.get(..self.data_offset)?.to_vec();
        wav.extend_from_slice(samples);
        let riff_size = u32::try_from(wav.len() - CHUNK_HEADER_BYTES).ok()?;
        let data_size = u32::try_from(samples.len()).ok()?;
        wav.get_mut(4..8)?.copy_from_slice(&riff_size.to_le_bytes());
        wav.get_mut(self.data_chunk + 4..self.data_chunk + 8)?
            .copy_from_slice(&data_size.to_le_bytes());
        Some(wav)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WavError {
    /// Not a RIFF/WAVE container.
    Signature,
    /// A chunk runs past the header prefix or the file.
    ChunkBounds,
    /// The `fmt ` chunk is shorter than 16 bytes.
    Format,
    /// `data` appeared before any `fmt ` chunk.
    MissingFormat,
    /// No `data` chunk header within the prefix.
    MissingData,
}

impl fmt::Display for WavError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Signature => "not a RIFF/WAVE file",
            Self::ChunkBounds => "a WAV chunk exceeds its container",
            Self::Format => "the WAV format chunk is malformed",
            Self::MissingFormat => "the WAV format chunk is missing",
            Self::MissingData => "the WAV data chunk is missing",
        })
    }
}

impl std::error::Error for WavError {}

/// Parses the header of a WAV file of `file_len` bytes whose first bytes are `prefix`.
///
/// For an in-memory file pass the whole buffer and its length.
pub fn parse_header(prefix: &[u8], file_len: u64) -> Result<WavLayout, WavError> {
    if !crate::is_riff_form(prefix, *b"WAVE") {
        return Err(WavError::Signature);
    }
    if !u64::try_from(prefix.len()).is_ok_and(|len| len <= file_len) {
        return Err(WavError::ChunkBounds);
    }
    let declared_len = u64::from(u32_at(prefix, 4).ok_or(WavError::Signature)?) + 8;
    let mut format = None;
    let mut cursor = RIFF_HEADER_BYTES;
    while let Some(header) = prefix.get(cursor..cursor + CHUNK_HEADER_BYTES) {
        let size = u32_at(header, 4).ok_or(WavError::ChunkBounds)?;
        let body = cursor + CHUNK_HEADER_BYTES;
        if &header[..4] == b"data" {
            let format = format.ok_or(WavError::MissingFormat)?;
            let layout = WavLayout {
                declared_len,
                format,
                data_chunk: cursor,
                data_offset: body,
                data_len: u64::from(size),
            };
            if layout.data_end() > file_len {
                return Err(WavError::ChunkBounds);
            }
            return Ok(layout);
        }
        let end = usize::try_from(size)
            .ok()
            .and_then(|size| body.checked_add(size))
            .filter(|end| *end <= prefix.len())
            .ok_or(WavError::ChunkBounds)?;
        if &header[..4] == b"fmt " {
            format = Some(WavFormat::parse(&prefix[body..end]).ok_or(WavError::Format)?);
        }
        // Chunks are word aligned: an odd-sized chunk is followed by one pad byte.
        cursor = end + (end - body) % 2;
    }
    Err(WavError::MissingData)
}

/// Whether `bytes` starts like a WAV file. A cheap signature check, not a parse.
#[must_use]
pub fn has_signature(bytes: &[u8]) -> bool {
    crate::is_riff_form(bytes, *b"WAVE")
}

/// A canonical 44-byte-header WAV holding `samples`. `None` past the format's 4 GiB limit.
#[must_use]
pub fn encode(format: WavFormat, samples: &[u8]) -> Option<Vec<u8>> {
    let data_size = u32::try_from(samples.len()).ok()?;
    let riff_size = data_size.checked_add(36)?;
    let mut wav = Vec::with_capacity(samples.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&riff_size.to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&format.encoding.to_le_bytes());
    wav.extend_from_slice(&format.channels.to_le_bytes());
    wav.extend_from_slice(&format.sample_rate.to_le_bytes());
    wav.extend_from_slice(&format.byte_rate.to_le_bytes());
    wav.extend_from_slice(&format.block_align.to_le_bytes());
    wav.extend_from_slice(&format.bits_per_sample.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(samples);
    Some(wav)
}

fn u16_at(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn u32_at(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

#[cfg(test)]
mod tests;
