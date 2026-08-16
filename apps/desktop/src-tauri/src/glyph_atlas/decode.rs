//! Frame decoding

use std::fmt;
use std::marker::PhantomData;

use osg_scene::glyph::MAX_GLYPH_COUNT;
use serde::de::{Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use super::refusal::StagingRefusal;
use super::validation::validate;
use super::{
    FRAME_HEADER_BYTES, FRAME_MAGIC, GLYPH_ATLAS_FRAME_MEDIA_TYPE, GLYPH_ATLAS_STAGING_VERSION,
    MAX_FRAME_BYTES, MAX_METADATA_BYTES, StagedGlyph, StagedGlyphAtlas, UncheckedStagedAtlas,
};

/// Reads four little-endian bytes at `offset`, which the caller has already bounds-checked.
fn read_u32(frame: &[u8], offset: usize) -> u32 {
    let mut bytes = [0_u8; 4];
    bytes.copy_from_slice(&frame[offset..offset + 4]);
    u32::from_le_bytes(bytes)
}

/// Decodes one staged frame, refusing before anything large is copied.
///
/// The order is deliberate. The media type, the frame bounds, the magic and the frame version are
/// settled against the borrowed body, so an over-budget or unrecognised frame costs no allocation
/// here at all. Only once the metadata has been read, validated and reconciled with the body length
/// are the pixels copied.
pub(super) fn decode_frame(
    media_type: Option<&str>,
    frame: &[u8],
) -> Result<StagedGlyphAtlas, StagingRefusal> {
    if media_type != Some(GLYPH_ATLAS_FRAME_MEDIA_TYPE) {
        return Err(StagingRefusal::UnsupportedMediaType);
    }
    if frame.len() > MAX_FRAME_BYTES {
        return Err(StagingRefusal::FrameTooLarge);
    }
    if frame.len() < FRAME_HEADER_BYTES {
        return Err(StagingRefusal::FrameTooShort);
    }
    if &frame[..FRAME_MAGIC.len()] != FRAME_MAGIC {
        return Err(StagingRefusal::UnsupportedMagic);
    }
    if read_u32(frame, 8) != GLYPH_ATLAS_STAGING_VERSION {
        return Err(StagingRefusal::UnsupportedFrameVersion);
    }

    let pixels_at = usize::try_from(read_u32(frame, 12))
        .ok()
        .and_then(|metadata_len| {
            (metadata_len <= MAX_METADATA_BYTES)
                .then(|| FRAME_HEADER_BYTES.checked_add(metadata_len))
                .flatten()
        })
        .filter(|pixels_at| *pixels_at <= frame.len())
        .ok_or(StagingRefusal::UnsupportedMetadataLength)?;

    let metadata: UncheckedStagedAtlas =
        serde_json::from_slice(&frame[FRAME_HEADER_BYTES..pixels_at])
            // The serde message quotes the offending input, so only the fact of failure crosses.
            .map_err(|_| StagingRefusal::UnsupportedMetadata)?;
    if metadata.frame_version != GLYPH_ATLAS_STAGING_VERSION {
        return Err(StagingRefusal::UnsupportedFrameVersion);
    }
    validate(&metadata)?;

    // The declared atlas is the single source of truth for the pixel length, and validation has
    // already pinned `bytes_per_row` to exactly one tightly packed row.
    let declared = u64::from(metadata.atlas.height_px) * u64::from(metadata.atlas.bytes_per_row);
    if declared != u64::try_from(frame.len() - pixels_at).unwrap_or(u64::MAX) {
        return Err(StagingRefusal::PixelLengthMismatch);
    }
    let staged = StagedGlyphAtlas {
        metadata,
        pixels: frame[pixels_at..].to_vec(),
    };
    // Build the checked descriptor here, at the door, rather than at render time. An atlas that
    // cannot become one is not renderable, and refusing it now means the registry only ever holds
    // atlases the compositor can actually draw — and that the refusal reaches the caller who staged
    // it, instead of surfacing later as a mysterious preview failure.
    staged.to_descriptor()?;
    Ok(staged)
}

// Bounded reading
//
// Validation runs after a value exists, which is too late for a sequence: a hostile frame would
// have allocated whatever it declared before anything looked at it. This reader stops at the bound
// instead, so the largest allocation a refused frame can cause is the bound itself.

struct BoundedSeq<T> {
    limit: usize,
    what: &'static str,
    marker: PhantomData<T>,
}

impl<'de, T: Deserialize<'de>> Visitor<'de> for BoundedSeq<T> {
    type Value = Vec<T>;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "at most {} {}", self.limit, self.what)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Self::Value, A::Error> {
        // The hint comes from the input, so it may only ever shrink the reservation.
        let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(self.limit));
        while let Some(value) = sequence.next_element()? {
            if values.len() == self.limit {
                return Err(A::Error::custom(format_args!(
                    "more than {} {}",
                    self.limit, self.what
                )));
            }
            values.push(value);
        }
        Ok(values)
    }
}

pub(super) fn deserialize_glyphs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<StagedGlyph>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq {
        limit: MAX_GLYPH_COUNT,
        what: "atlas glyphs",
        marker: PhantomData,
    })
}
