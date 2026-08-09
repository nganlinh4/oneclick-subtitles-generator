use std::fs;
use std::path::Path;

use osg_domain::formats::{parse_legacy_json, parse_srt};
use osg_domain::{SubtitleTrack, TrackOrigin};

use crate::ApplicationError;

const MAX_SUBTITLE_FILE_BYTES: u64 = 32 * 1024 * 1024;

pub fn import_subtitle_track(path: &Path) -> Result<SubtitleTrack, ApplicationError> {
    let metadata = fs::metadata(path).map_err(|source| ApplicationError::Io {
        operation: "read the selected subtitle metadata",
        source,
    })?;
    if !metadata.is_file() {
        return Err(ApplicationError::InvalidPath);
    }
    if metadata.len() == 0 {
        return Err(ApplicationError::EmptyFile);
    }
    if metadata.len() > MAX_SUBTITLE_FILE_BYTES {
        return Err(ApplicationError::SubtitleFileTooLarge);
    }

    let bytes = fs::read(path).map_err(|source| ApplicationError::Io {
        operation: "read the selected subtitle file",
        source,
    })?;
    let input = String::from_utf8(bytes).map_err(|_| ApplicationError::InvalidSubtitleEncoding)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(ApplicationError::InvalidPath)?;
    let (origin, cues) = match extension.as_str() {
        "srt" => (TrackOrigin::Srt, parse_srt(&input)?),
        "json" => (TrackOrigin::LegacyJson, parse_legacy_json(&input)?),
        _ => return Err(ApplicationError::UnsupportedSubtitle(extension)),
    };
    let label = path.file_stem().map_or_else(
        || "Imported subtitles".to_owned(),
        |value| value.to_string_lossy().into_owned(),
    );

    SubtitleTrack::new(label, origin, cues).map_err(|error| {
        ApplicationError::SubtitleFormat(osg_domain::formats::SubtitleFormatError::InvalidCue(
            error,
        ))
    })
}
