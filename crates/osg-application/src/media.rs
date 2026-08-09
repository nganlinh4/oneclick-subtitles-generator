use std::fs;
use std::path::{Path, PathBuf};

use osg_domain::{MediaAsset, media_kind_for_extension};

use crate::ApplicationError;

#[derive(Debug, Clone)]
pub struct ImportedMedia {
    asset: MediaAsset,
    canonical_path: PathBuf,
}

impl ImportedMedia {
    #[must_use]
    pub const fn asset(&self) -> &MediaAsset {
        &self.asset
    }

    #[must_use]
    pub fn canonical_path(&self) -> &Path {
        &self.canonical_path
    }
}

pub fn inspect_media(path: &Path) -> Result<ImportedMedia, ApplicationError> {
    let canonical_path = fs::canonicalize(path).map_err(|source| ApplicationError::Io {
        operation: "resolve the selected media path",
        source,
    })?;
    let metadata = fs::metadata(&canonical_path).map_err(|source| ApplicationError::Io {
        operation: "read the selected media metadata",
        source,
    })?;
    if !metadata.is_file() {
        return Err(ApplicationError::InvalidPath);
    }
    if metadata.len() == 0 {
        return Err(ApplicationError::EmptyFile);
    }

    let extension = canonical_path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or(ApplicationError::InvalidPath)?;
    let kind = media_kind_for_extension(&extension)
        .ok_or_else(|| ApplicationError::UnsupportedMedia(extension.clone()))?;
    let display_name = canonical_path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.trim().is_empty())
        .ok_or(ApplicationError::InvalidPath)?;

    Ok(ImportedMedia {
        asset: MediaAsset::new(display_name, extension, metadata.len(), kind),
        canonical_path,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use osg_domain::MediaKind;

    use super::inspect_media;

    #[test]
    fn inspects_supported_media_without_exposing_content() {
        let path =
            std::env::temp_dir().join(format!("osg-media-inspection-{}.mp4", std::process::id()));
        fs::write(&path, b"not decoded during inspection").expect("create fixture");

        let imported = inspect_media(&path).expect("supported fixture");

        assert_eq!(imported.asset().kind, MediaKind::Video);
        assert_eq!(imported.asset().size_bytes, 29);
        fs::remove_file(path).expect("remove fixture");
    }
}
