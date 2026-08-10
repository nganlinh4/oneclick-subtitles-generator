use crate::protocol::{WireArtifact, WireVoice};
use crate::{AudioFormat, LanguageTag, Result, SpeechError, TimeMicros, VoiceId};
use serde::Serialize;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_VOICES: usize = 2_048;
const MAX_VOICE_NAME_CHARS: usize = 128;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpeechArtifactSummary {
    format: AudioFormat,
    bytes: u64,
    duration: TimeMicros,
    sample_rate_hz: u32,
    channels: u8,
}

impl SpeechArtifactSummary {
    #[must_use]
    pub fn format(&self) -> AudioFormat {
        self.format
    }

    #[must_use]
    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    #[must_use]
    pub fn duration(&self) -> TimeMicros {
        self.duration
    }

    #[must_use]
    pub fn sample_rate_hz(&self) -> u32 {
        self.sample_rate_hz
    }

    #[must_use]
    pub fn channels(&self) -> u8 {
        self.channels
    }
}

#[derive(Clone)]
pub struct SpeechArtifact {
    path: PathBuf,
    summary: SpeechArtifactSummary,
}

impl SpeechArtifact {
    #[must_use]
    pub fn native_path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn summary(&self) -> &SpeechArtifactSummary {
        &self.summary
    }
}

impl fmt::Debug for SpeechArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SpeechArtifact")
            .field("path", &"<redacted>")
            .field("summary", &self.summary)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VoiceGender {
    Female,
    Male,
    Neutral,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VoiceDescriptor {
    id: VoiceId,
    display_name: String,
    language: LanguageTag,
    gender: VoiceGender,
}

impl VoiceDescriptor {
    #[must_use]
    pub fn id(&self) -> &VoiceId {
        &self.id
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    #[must_use]
    pub fn language(&self) -> &LanguageTag {
        &self.language
    }

    #[must_use]
    pub fn gender(&self) -> VoiceGender {
        self.gender
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VoiceInventory {
    voices: Vec<VoiceDescriptor>,
}

impl VoiceInventory {
    #[must_use]
    pub fn voices(&self) -> &[VoiceDescriptor] {
        &self.voices
    }

    pub(crate) fn from_wire(voices: Vec<WireVoice>) -> Result<Self> {
        if voices.len() > MAX_VOICES {
            return Err(SpeechError::Protocol("voice inventory is too large"));
        }
        let mut result = Vec::with_capacity(voices.len());
        let mut ids = std::collections::HashSet::with_capacity(voices.len());
        for voice in voices {
            let id = VoiceId::new(voice.id)
                .map_err(|_| SpeechError::Protocol("invalid voice identifier"))?;
            if !ids.insert(id.clone()) {
                return Err(SpeechError::Protocol("duplicate voice identifier"));
            }
            let display_name = voice.display_name.trim();
            if display_name.is_empty()
                || display_name.chars().count() > MAX_VOICE_NAME_CHARS
                || display_name.chars().any(char::is_control)
            {
                return Err(SpeechError::Protocol("invalid voice display name"));
            }
            let language = LanguageTag::new(voice.language)
                .map_err(|_| SpeechError::Protocol("invalid voice language"))?;
            let gender = match voice.gender.as_str() {
                "female" => VoiceGender::Female,
                "male" => VoiceGender::Male,
                "neutral" => VoiceGender::Neutral,
                "unknown" => VoiceGender::Unknown,
                _ => return Err(SpeechError::Protocol("invalid voice gender")),
            };
            result.push(VoiceDescriptor {
                id,
                display_name: display_name.to_owned(),
                language,
                gender,
            });
        }
        Ok(Self { voices: result })
    }
}

pub(crate) struct StagedArtifact {
    path: PathBuf,
    _directory: tempfile::TempDir,
}

impl StagedArtifact {
    pub(crate) fn create(directory: &Path, format: AudioFormat) -> Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix(".osg-speech-")
            .tempdir_in(directory)
            .map_err(SpeechError::Publish)?;
        let path = directory
            .path()
            .join(format!("artifact.{}", format.extension()));
        Ok(Self {
            path,
            _directory: directory,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn verify_and_publish(
        self,
        destination: PathBuf,
        format: AudioFormat,
        wire: WireArtifact,
    ) -> Result<SpeechArtifact> {
        let summary = verify(&self.path, format, wire)?;
        publish_no_clobber(&self.path, &destination)?;
        let _ = std::fs::remove_file(&self.path);
        Ok(SpeechArtifact {
            path: destination,
            summary,
        })
    }
}

impl fmt::Debug for StagedArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagedArtifact")
            .field("path", &"<redacted>")
            .finish()
    }
}

fn verify(path: &Path, format: AudioFormat, wire: WireArtifact) -> Result<SpeechArtifactSummary> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| SpeechError::MissingArtifact)?;
    if !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_ARTIFACT_BYTES
        || metadata.len() != wire.bytes
    {
        return Err(SpeechError::InvalidArtifact(
            "file type or reported size is invalid",
        ));
    }
    if !(8_000..=384_000).contains(&wire.sample_rate_hz) || !(1..=8).contains(&wire.channels) {
        return Err(SpeechError::InvalidArtifact(
            "audio stream parameters are invalid",
        ));
    }
    let duration = TimeMicros::new(wire.duration_micros)
        .map_err(|_| SpeechError::InvalidArtifact("duration is invalid"))?;
    if duration == TimeMicros::ZERO {
        return Err(SpeechError::InvalidArtifact("duration is zero"));
    }

    match format {
        AudioFormat::Wav => verify_wav(path, wire.sample_rate_hz, wire.channels, duration)?,
        AudioFormat::Mp3 => verify_mp3(path)?,
        AudioFormat::M4a => verify_m4a(path)?,
    }
    Ok(SpeechArtifactSummary {
        format,
        bytes: wire.bytes,
        duration,
        sample_rate_hz: wire.sample_rate_hz,
        channels: wire.channels,
    })
}

fn verify_wav(
    path: &Path,
    expected_rate: u32,
    expected_channels: u8,
    expected_duration: TimeMicros,
) -> Result<()> {
    let mut file = File::open(path).map_err(|_| SpeechError::MissingArtifact)?;
    let file_bytes = file
        .metadata()
        .map_err(|_| SpeechError::InvalidArtifact("WAV metadata is unreadable"))?
        .len();
    let mut header = vec![0_u8; 64 * 1024];
    let read = file
        .read(&mut header)
        .map_err(|_| SpeechError::InvalidArtifact("WAV header is unreadable"))?;
    header.truncate(read);
    if header.len() < 12 || &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(SpeechError::InvalidArtifact("invalid WAV signature"));
    }
    let riff_bytes = u64::from(u32::from_le_bytes(header[4..8].try_into().unwrap())) + 8;
    if riff_bytes != file_bytes {
        return Err(SpeechError::InvalidArtifact("invalid WAV container size"));
    }
    let mut cursor = 12_usize;
    let mut stream = None;
    let mut data = None;
    while cursor.checked_add(8).is_some_and(|end| end <= header.len()) {
        let id = &header[cursor..cursor + 4];
        let size = usize::try_from(u32::from_le_bytes(
            header[cursor + 4..cursor + 8]
                .try_into()
                .map_err(|_| SpeechError::InvalidArtifact("invalid WAV chunk"))?,
        ))
        .map_err(|_| SpeechError::InvalidArtifact("invalid WAV chunk size"))?;
        let body = cursor + 8;
        if id == b"fmt " && size >= 16 && body + 16 <= header.len() {
            let codec = u16::from_le_bytes([header[body], header[body + 1]]);
            let channels = u16::from_le_bytes([header[body + 2], header[body + 3]]);
            let rate = u32::from_le_bytes(header[body + 4..body + 8].try_into().unwrap());
            let byte_rate = u32::from_le_bytes(header[body + 8..body + 12].try_into().unwrap());
            if !matches!(codec, 1 | 3 | 0xfffe) || byte_rate == 0 {
                return Err(SpeechError::InvalidArtifact("unsupported WAV encoding"));
            }
            stream = Some((rate, channels, byte_rate));
        } else if id == b"data" {
            data = Some((
                u64::try_from(body).unwrap_or(u64::MAX),
                u64::try_from(size).unwrap_or(u64::MAX),
            ));
            break;
        }
        let padded = size
            .checked_add(size % 2)
            .and_then(|value| body.checked_add(value))
            .ok_or(SpeechError::InvalidArtifact("invalid WAV chunk size"))?;
        if padded > header.len() {
            break;
        }
        cursor = padded;
    }
    let (rate, channels, byte_rate) =
        stream.ok_or(SpeechError::InvalidArtifact("WAV format chunk is missing"))?;
    let (data_start, data_bytes) =
        data.ok_or(SpeechError::InvalidArtifact("WAV data chunk is missing"))?;
    if data_start
        .checked_add(data_bytes)
        .is_none_or(|end| end > file_bytes)
    {
        return Err(SpeechError::InvalidArtifact("invalid WAV data size"));
    }
    if rate != expected_rate || channels != u16::from(expected_channels) {
        return Err(SpeechError::InvalidArtifact(
            "WAV metadata does not match worker report",
        ));
    }
    let measured = data_bytes.saturating_mul(1_000_000) / u64::from(byte_rate);
    let difference = measured.abs_diff(expected_duration.get());
    let tolerance = 100_000_u64.max(measured / 50);
    if difference > tolerance {
        return Err(SpeechError::InvalidArtifact(
            "WAV duration does not match worker report",
        ));
    }
    Ok(())
}

fn verify_mp3(path: &Path) -> Result<()> {
    let mut signature = [0_u8; 3];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .map_err(|_| SpeechError::InvalidArtifact("MP3 header is unreadable"))?;
    if &signature != b"ID3" && !(signature[0] == 0xff && signature[1] & 0xe0 == 0xe0) {
        return Err(SpeechError::InvalidArtifact("invalid MP3 signature"));
    }
    Ok(())
}

fn verify_m4a(path: &Path) -> Result<()> {
    let mut signature = [0_u8; 12];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut signature))
        .map_err(|_| SpeechError::InvalidArtifact("M4A header is unreadable"))?;
    if &signature[4..8] != b"ftyp" {
        return Err(SpeechError::InvalidArtifact("invalid M4A signature"));
    }
    Ok(())
}

fn publish_no_clobber(staged: &Path, destination: &Path) -> Result<()> {
    if destination.exists() {
        return Err(SpeechError::OutputExists);
    }
    if std::fs::hard_link(staged, destination).is_ok() {
        return Ok(());
    }
    let mut source = File::open(staged).map_err(SpeechError::Publish)?;
    let mut target = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(target) => target,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(SpeechError::OutputExists);
        }
        Err(error) => return Err(SpeechError::Publish(error)),
    };
    if let Err(error) = std::io::copy(&mut source, &mut target)
        .and_then(|_| target.flush())
        .and_then(|()| target.sync_all())
    {
        drop(target);
        let _ = std::fs::remove_file(destination);
        return Err(SpeechError::Publish(error));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inventory_rejects_duplicate_and_hostile_values() {
        let voice = || WireVoice {
            id: "en-US-Test".into(),
            display_name: "Test".into(),
            language: "en-US".into(),
            gender: "neutral".into(),
        };
        assert!(VoiceInventory::from_wire(vec![voice()]).is_ok());
        assert!(VoiceInventory::from_wire(vec![voice(), voice()]).is_err());
        let mut hostile = voice();
        hostile.display_name = "bad\nname".into();
        assert!(VoiceInventory::from_wire(vec![hostile]).is_err());
    }

    #[test]
    fn malformed_artifact_error_does_not_reveal_path() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("private.wav");
        std::fs::write(&path, b"not wav").unwrap();
        let wire = WireArtifact {
            bytes: 7,
            duration_micros: 1_000_000,
            sample_rate_hz: 24_000,
            channels: 1,
        };
        let error = verify(&path, AudioFormat::Wav, wire).unwrap_err();
        assert!(!format!("{error:?}").contains(directory.path().to_string_lossy().as_ref()));
    }
}
