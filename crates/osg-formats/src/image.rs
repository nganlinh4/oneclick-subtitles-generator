//! Image signature checks for bytes whose declared type must be verified before use.

const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
const JPEG_SIGNATURE: &[u8] = &[0xff, 0xd8, 0xff];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Webp,
    Gif,
}

impl ImageKind {
    pub const ALL: [Self; 4] = [Self::Png, Self::Jpeg, Self::Webp, Self::Gif];

    /// Parses a canonical, lower-case MIME type. Aliases and parameters are the caller's concern.
    #[must_use]
    pub fn from_mime_type(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.mime_type() == value)
    }

    #[must_use]
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Gif => "image/gif",
        }
    }

    /// Whether `bytes` starts with this format's signature.
    #[must_use]
    pub fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => bytes.starts_with(PNG_SIGNATURE),
            Self::Jpeg => bytes.starts_with(JPEG_SIGNATURE),
            Self::Webp => crate::is_riff_form(bytes, *b"WEBP"),
            Self::Gif => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        }
    }

    /// Identifies the format from its signature alone.
    #[must_use]
    pub fn sniff(bytes: &[u8]) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.matches(bytes))
    }
}

/// The canonical MIME type for `mime_type` when `bytes` really carries that format.
#[must_use]
pub fn verified_mime_type(mime_type: &str, bytes: &[u8]) -> Option<&'static str> {
    ImageKind::from_mime_type(mime_type)
        .filter(|kind| kind.matches(bytes))
        .map(ImageKind::mime_type)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_recognized_and_truncated_or_foreign_bytes_are_not() {
        let cases: &[(&[u8], Option<ImageKind>)] = &[
            (b"\x89PNG\r\n\x1a\nrest", Some(ImageKind::Png)),
            (b"\x89PNG\r\n\x1a", None),
            (&[0xff, 0xd8, 0xff, 0xe0], Some(ImageKind::Jpeg)),
            (&[0xff, 0xd8], None),
            (b"RIFF\0\0\0\0WEBPVP8 ", Some(ImageKind::Webp)),
            (b"RIFF\0\0\0\0WEB", None),
            (b"RIFF\0\0\0\0WAVEfmt ", None),
            (b"GIF89a", Some(ImageKind::Gif)),
            (b"GIF87a..", Some(ImageKind::Gif)),
            (b"GIF88a", None),
            (b"", None),
            (b"<svg/>", None),
        ];
        for (bytes, expected) in cases {
            assert_eq!(ImageKind::sniff(bytes), *expected, "{bytes:?}");
        }
    }

    #[test]
    fn declared_types_are_verified_against_the_bytes() {
        assert_eq!(
            verified_mime_type("image/png", b"\x89PNG\r\n\x1a\n"),
            Some("image/png")
        );
        assert_eq!(verified_mime_type("image/jpeg", b"\x89PNG\r\n\x1a\n"), None);
        assert_eq!(verified_mime_type("image/svg+xml", b"<svg/>"), None);
        assert_eq!(verified_mime_type("IMAGE/PNG", b"\x89PNG\r\n\x1a\n"), None);
        for kind in ImageKind::ALL {
            assert_eq!(ImageKind::from_mime_type(kind.mime_type()), Some(kind));
        }
    }
}
