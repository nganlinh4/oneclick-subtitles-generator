//! The native side of the glyph atlas staging boundary.
//!
//! `src/platform/glyphAtlasStaging.js` bakes one atlas per text revision inside the `WebView` and
//! hands it to native code as a single self-describing binary body. This module is the receiving
//! end: it decodes that frame, refuses anything the baker could not have produced, and holds the
//! result in a bounded registry that the compositor later addresses by an opaque identifier.
//!
//! Direction matters here. The content security policy stops the `WebView` from fetching,
//! streaming, or opening a socket to the loopback capability server, which is why composited frames
//! travel back as element loads. An atlas travelling `WebView` -> Rust over the command boundary is
//! the opposite direction and needs no relaxation of that policy; nothing in this module opens a
//! new origin or a new receive path.
//!
//! Frame layout (little-endian), mirroring `glyphAtlasStaging.js`:
//!
//! ```text
//! offset  size  field
//! 0       8     magic "OSGATLAS"
//! 8       4     u32 frame version
//! 12      4     u32 metadata length in bytes
//! 16      m     metadata, UTF-8 JSON
//! 16+m    p     pixels, tightly packed RGBA8, bytes_per_row = width_px * 4
//! ```
//!
//! The pixel length is deliberately absent from the header, so the declared atlas stays the single
//! source of truth: the body length is cross-checked against `width_px * height_px * 4` rather than
//! against a second copy of the same number.
//!
//! ## Why the staged frame is not a [`osg_scene::glyph::GlyphAtlasDescriptor`]
//!
//! The descriptor is the contract between the baker and the compositor, and it stays that. The
//! staged frame is a strictly smaller message, so it gets its own type that reuses the descriptor's
//! shared pieces ([`AtlasMetrics`], [`AtlasGeometry`], [`Direction`], `PixelFormat`,
//! [`GlyphAtlasError`]) and re-derives the rest:
//!
//! * `glyph.codePoints` is omitted on the wire and re-derived exactly from `cluster` here, because
//!   a second encoding of the same identity can only ever disagree with the first.
//! * `face.cssFont` and `face.probes` are omitted and are **not** invented. They are `WebView`-only
//!   shaping evidence — the proof that the requested face actually participated in the measurement.
//!   Synthesising them would turn the substitution check into a rubber stamp that always passes, so
//!   this side simply does not make that claim.
//!
//! ## What never crosses back
//!
//! Every refusal names a field and never a value: no cluster text, no family name, no path, no byte
//! count. A refusal may be logged; a user's subtitle text and the atlas pixels may not.

use std::cmp::Ordering;
use std::fmt;
use std::marker::PhantomData;
use std::sync::{Arc, Mutex};

use osg_domain::AssetId;
use osg_scene::glyph::{
    AtlasGeometry, AtlasMetrics, CONTENT_HASH_DIGITS, Direction, FaceStyle, GLYPH_ATLAS_VERSION,
    GlyphAtlasError, MAX_ATLAS_DIMENSION_PX, MAX_CLUSTER_CODE_POINTS, MAX_FAMILY_CHARACTERS,
    MAX_FONT_SIZE_PX, MAX_GLYPH_COUNT, MAX_PADDING_PX, MAX_TEXT_CODE_POINTS, MIN_FONT_SIZE_PX,
};
use serde::de::{Error as _, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use tauri::State;
use tauri::ipc::{InvokeBody, Request};

use crate::error::{CommandError, CommandResult};

/// The request header that declares what a raw command body carries.
const CONTENT_TYPE_HEADER: &str = "x-osg-content-type";
/// The only media type this command accepts, mirroring `GLYPH_ATLAS_FRAME_MEDIA_TYPE`.
const GLYPH_ATLAS_FRAME_MEDIA_TYPE: &str = "application/vnd.osg.glyph-atlas.v1";
/// The frame magic, mirroring `FRAME_MAGIC`.
const FRAME_MAGIC: &[u8; 8] = b"OSGATLAS";
/// Magic, frame version and metadata length, mirroring `FRAME_HEADER_BYTES`.
const FRAME_HEADER_BYTES: usize = 16;
/// The only staging frame version this build implements, mirroring `GLYPH_ATLAS_STAGING_VERSION`.
///
/// An unknown version is refused whole rather than migrated: a field's meaning is defined by its
/// version, so reading one out of an unknown frame is guessing.
const GLYPH_ATLAS_STAGING_VERSION: u32 = 1;
/// The largest staged frame, mirroring `GLYPH_ATLAS_STAGING_LIMITS.maxPayloadBytes`.
const MAX_FRAME_BYTES: usize = 32 * 1024 * 1024;
/// The largest metadata block, mirroring `GLYPH_ATLAS_STAGING_LIMITS.maxMetadataBytes`.
const MAX_METADATA_BYTES: usize = 1024 * 1024;
/// Live atlases the registry retains, mirroring `GLYPH_ATLAS_STAGING_LIMITS.maxStagedAtlases`.
///
/// The `WebView` bounds its handle cache by the same count, so both sides evict in the same order
/// and a `WebView` cache miss simply re-stages.
const MAX_STAGED_ATLASES: usize = 8;
/// Retained atlas pixel bytes across the whole registry.
///
/// The count bound alone would admit eight frames at the frame budget, so the byte bound is what
/// actually caps residency. Pixels are the whole of it: the glyph table is bounded by
/// [`MAX_METADATA_BYTES`] and is negligible beside a texture.
const MAX_STAGED_BYTES: u64 = 64 * 1024 * 1024;

/// One frame always fits the registry, so eviction never has to refuse a well-formed atlas.
const _: () = assert!(MAX_FRAME_BYTES as u64 <= MAX_STAGED_BYTES);

// Refusals

/// Why one staged glyph atlas frame was refused.
///
/// Deliberately coarse and value-free: every variant names the part of the frame that failed, never
/// its contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StagingRefusal {
    /// The request did not declare the glyph atlas frame media type.
    UnsupportedMediaType,
    /// The request body was not a raw binary body.
    UnsupportedBody,
    /// The frame is larger than the staging budget.
    FrameTooLarge,
    /// The frame is shorter than a frame header.
    FrameTooShort,
    /// The frame does not begin with the staging magic.
    UnsupportedMagic,
    /// The frame declares a staging version this build does not implement.
    UnsupportedFrameVersion,
    /// The declared metadata length is past the metadata budget or past the end of the frame.
    UnsupportedMetadataLength,
    /// The metadata is not the UTF-8 JSON object this build reads.
    UnsupportedMetadata,
    /// The frame length disagrees with the atlas the metadata declares.
    PixelLengthMismatch,
    /// The staged descriptor is not one the baker could have produced.
    Descriptor(GlyphAtlasError),
    /// The staging registry is unavailable.
    Unavailable,
}

impl fmt::Display for StagingRefusal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::UnsupportedMediaType => "the request does not declare the glyph atlas media type",
            Self::UnsupportedBody => "the glyph atlas frame is not a raw binary body",
            Self::FrameTooLarge => "the glyph atlas frame is larger than the staging budget",
            Self::FrameTooShort => "the glyph atlas frame is shorter than a frame header",
            Self::UnsupportedMagic => "the glyph atlas frame does not begin with the staging magic",
            Self::UnsupportedFrameVersion => "the glyph atlas frame version is not supported",
            Self::UnsupportedMetadataLength => {
                "the glyph atlas metadata length is not supported by this frame"
            }
            Self::UnsupportedMetadata => "the glyph atlas metadata is not readable",
            Self::PixelLengthMismatch => {
                "the glyph atlas frame length disagrees with the declared atlas"
            }
            Self::Descriptor(error) => return error.fmt(formatter),
            Self::Unavailable => "the glyph atlas staging registry is unavailable",
        };
        formatter.write_str(message)
    }
}

impl From<GlyphAtlasError> for StagingRefusal {
    fn from(error: GlyphAtlasError) -> Self {
        Self::Descriptor(error)
    }
}

impl From<StagingRefusal> for CommandError {
    fn from(refusal: StagingRefusal) -> Self {
        // Every `StagingRefusal` message names a field and never a value, so the whole of it is
        // safe to surface. The `WebView` reduces it to a typed code anyway.
        match refusal {
            StagingRefusal::Unavailable => Self::internal("Glyph atlas staging is unavailable."),
            refusal => Self::invalid_input(format!("The glyph atlas was not staged: {refusal}.")),
        }
    }
}

// The staged frame

/// The face the atlas was baked from, as far as the staged frame reports it.
///
/// Every field means what the same field means on [`osg_scene::glyph::AtlasFace`]. What is missing
/// is the point: `cssFont` and `probes` are the `WebView`'s own shaping evidence, they are not on
/// the wire, and this side does not invent them.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StagedFace {
    requested_family: String,
    weight: u16,
    style: FaceStyle,
    font_size_px: f64,
    /// Whether any cell fell back to another face. Derived from the cells.
    substituted: bool,
}

impl fmt::Debug for StagedFace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The family is editor content. `finish_non_exhaustive` is what stops a field added later
        // from joining the output just by existing.
        formatter
            .debug_struct("StagedFace")
            .field("requested_family", &"<redacted>")
            .field("weight", &self.weight)
            .field("style", &self.style)
            .field("font_size_px", &self.font_size_px)
            .finish_non_exhaustive()
    }
}

/// One rasterized grapheme cluster and where its ink sits in the atlas.
///
/// Every field means what the same field means on [`osg_scene::glyph::AtlasGlyph`], except that
/// `codePoints` is absent from the wire and is re-derived from `cluster` during validation.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StagedGlyph {
    cluster: String,
    direction: Direction,
    advance_width_px: f64,
    x_px: u32,
    y_px: u32,
    width_px: u32,
    height_px: u32,
    /// Signed: ink may start right of the pen, and above the baseline.
    origin_x_px: i32,
    origin_y_px: i32,
    substituted: bool,
}

impl fmt::Debug for StagedGlyph {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The cluster is the user's subtitle text. Only the cell's placement is loggable.
        formatter
            .debug_struct("StagedGlyph")
            .field("cluster", &"<redacted>")
            .field("direction", &self.direction)
            .field("x_px", &self.x_px)
            .field("y_px", &self.y_px)
            .field("width_px", &self.width_px)
            .field("height_px", &self.height_px)
            .finish_non_exhaustive()
    }
}

/// The staged metadata as it arrives: shape-checked and length-bounded, but not yet consistent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UncheckedStagedAtlas {
    /// The staging frame version, repeated from the binary header.
    frame_version: u32,
    /// The descriptor schema version.
    atlas_version: u32,
    /// The baker's non-cryptographic identity for this atlas. Cache key only, never a boundary.
    content_hash: String,
    /// The face the atlas was baked from.
    face: StagedFace,
    /// The run's metrics.
    metrics: AtlasMetrics,
    /// The atlas geometry.
    atlas: AtlasGeometry,
    /// The rasterized cells, in the baker's strictly increasing cluster order.
    #[serde(deserialize_with = "deserialize_glyphs")]
    glyphs: Vec<StagedGlyph>,
}

/// A checked staged glyph atlas: metadata that passed every bound and agreement, plus its pixels.
#[derive(Clone, PartialEq)]
pub(crate) struct StagedGlyphAtlas {
    metadata: UncheckedStagedAtlas,
    pixels: Vec<u8>,
}

impl fmt::Debug for StagedGlyphAtlas {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagedGlyphAtlas")
            .field("metadata", &self.metadata)
            .field("pixels", &"<redacted>")
            .finish()
    }
}

impl StagedGlyphAtlas {
    /// The baker's identity for this atlas, echoed back so the `WebView` can match its own cache.
    pub(crate) fn content_hash(&self) -> &str {
        &self.metadata.content_hash
    }

    /// The retained cost of this atlas, which the registry bounds.
    fn resident_bytes(&self) -> u64 {
        u64::try_from(self.pixels.len()).unwrap_or(u64::MAX)
    }
}

// Frame decoding

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
fn decode_frame(
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
    Ok(StagedGlyphAtlas {
        metadata,
        pixels: frame[pixels_at..].to_vec(),
    })
}

// Validation
//
// Mirrors `osg_scene::glyph`'s own checks for the fields the staged frame carries. The baker
// enforces these on the way out, but nothing guarantees the bytes arriving here came from the
// baker, so every bound is enforced again on this side.

fn validate(atlas: &UncheckedStagedAtlas) -> Result<(), GlyphAtlasError> {
    // First and alone: a field's meaning is defined by the descriptor version, so an unknown one is
    // refused before anything else is looked at.
    if atlas.atlas_version != GLYPH_ATLAS_VERSION {
        return Err(GlyphAtlasError::UnsupportedVersion);
    }
    validate_face(&atlas.face)?;
    validate_metrics(&atlas.metrics)?;
    validate_geometry(&atlas.atlas)?;
    validate_glyphs(&atlas.glyphs, &atlas.atlas)?;
    validate_agreements(atlas)
}

/// The family shape the baker accepts: alphanumeric first, then alphanumerics, space, dot,
/// underscore or hyphen. Mirrors `osg_scene::glyph`'s own predicate, which is a superset of the
/// baker's `\p{L}\p{N}`, so nothing the baker emits is refused here.
fn is_supported_family(family: &str) -> bool {
    let mut characters = family.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    first.is_alphanumeric()
        && family.encode_utf16().count() <= MAX_FAMILY_CHARACTERS
        && family.chars().all(|character| {
            character.is_alphanumeric() || matches!(character, ' ' | '.' | '_' | '-')
        })
}

fn validate_face(face: &StagedFace) -> Result<(), GlyphAtlasError> {
    if !is_supported_family(&face.requested_family) || !matches!(face.weight, 1..=1_000) {
        return Err(GlyphAtlasError::UnsupportedFace);
    }
    if !face.font_size_px.is_finite()
        || !(MIN_FONT_SIZE_PX..=MAX_FONT_SIZE_PX).contains(&face.font_size_px)
    {
        return Err(GlyphAtlasError::UnsupportedFontSize);
    }
    Ok(())
}

fn validate_metrics(metrics: &AtlasMetrics) -> Result<(), GlyphAtlasError> {
    let non_negative = [
        metrics.ascent_px,
        metrics.descent_px,
        metrics.line_height_px,
        metrics.baseline_px,
        metrics.run_advance_width_px,
    ];
    if non_negative
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
        || !metrics.shaping_residual_px.is_finite()
    {
        return Err(GlyphAtlasError::UnsupportedMetrics);
    }
    // The baker resolves a run with no strong character to left-to-right, so a neutral base
    // direction is not something it can emit.
    if metrics.base_direction == Direction::Neutral {
        return Err(GlyphAtlasError::UnsupportedDirection);
    }
    Ok(())
}

fn validate_geometry(geometry: &AtlasGeometry) -> Result<(), GlyphAtlasError> {
    if geometry.width_px > MAX_ATLAS_DIMENSION_PX
        || geometry.height_px > MAX_ATLAS_DIMENSION_PX
        // An inkless run packs to 0x0. Half a dimension is never a valid atlas.
        || (geometry.width_px == 0) != (geometry.height_px == 0)
    {
        return Err(GlyphAtlasError::UnsupportedAtlasSize);
    }
    if geometry.padding_px > MAX_PADDING_PX {
        return Err(GlyphAtlasError::UnsupportedPadding);
    }
    // The staged frame is tightly packed by construction, so the stride is not merely bounded here
    // as it is in the descriptor: it is pinned to one row. That is what lets the body length be
    // cross-checked against the declared atlas alone.
    if geometry.bytes_per_row != geometry.width_px.saturating_mul(4) {
        return Err(GlyphAtlasError::UnsupportedRowStride);
    }
    if usize::try_from(geometry.glyph_count).unwrap_or(usize::MAX) > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    Ok(())
}

fn validate_glyphs(
    glyphs: &[StagedGlyph],
    geometry: &AtlasGeometry,
) -> Result<(), GlyphAtlasError> {
    if glyphs.len() > MAX_GLYPH_COUNT {
        return Err(GlyphAtlasError::UnsupportedGlyphCount);
    }
    let mut total_code_points = 0_usize;
    let mut previous: Option<&str> = None;
    for glyph in glyphs {
        // The wire omits `codePoints` and this is where they come back: derived from the cluster
        // itself, so the two identities cannot come apart the way a second encoding could.
        let code_points = glyph.cluster.chars().count();
        if code_points == 0
            || code_points > MAX_CLUSTER_CODE_POINTS
            || !glyph.advance_width_px.is_finite()
            || glyph.advance_width_px < 0.0
            || glyph.origin_x_px.unsigned_abs() > MAX_ATLAS_DIMENSION_PX
            || glyph.origin_y_px.unsigned_abs() > MAX_ATLAS_DIMENSION_PX
        {
            return Err(GlyphAtlasError::UnsupportedCluster);
        }
        // Widened before adding: a cell that would wrap around the addressable range must fail as
        // an out-of-atlas cell, not as an in-range sum.
        if u64::from(glyph.x_px) + u64::from(glyph.width_px) > u64::from(geometry.width_px)
            || u64::from(glyph.y_px) + u64::from(glyph.height_px) > u64::from(geometry.height_px)
        {
            return Err(GlyphAtlasError::GlyphOutsideAtlas);
        }
        // The baker sorts distinct clusters by UTF-16 code unit, which is what makes the same glyph
        // set pack to the same atlas. Comparing the same way keeps astral clusters in the order the
        // baker put them, and strictness rejects a duplicated cell.
        if let Some(previous) = previous
            && previous.encode_utf16().cmp(glyph.cluster.encode_utf16()) != Ordering::Less
        {
            return Err(GlyphAtlasError::UnorderedGlyphs);
        }
        previous = Some(&glyph.cluster);
        total_code_points += code_points;
    }
    // The clusters are the run's distinct graphemes, so their code points cannot outnumber the
    // run's own — which is the bound the baker enforces on the text.
    if total_code_points > MAX_TEXT_CODE_POINTS {
        return Err(GlyphAtlasError::UnsupportedTextLength);
    }
    Ok(())
}

fn validate_agreements(atlas: &UncheckedStagedAtlas) -> Result<(), GlyphAtlasError> {
    if usize::try_from(atlas.atlas.glyph_count).unwrap_or(usize::MAX) != atlas.glyphs.len() {
        return Err(GlyphAtlasError::GlyphCountMismatch);
    }
    if atlas.face.substituted != atlas.glyphs.iter().any(|glyph| glyph.substituted) {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    // A right-to-left base direction is the first strong cluster in the run, and every cluster in
    // the run has a cell, so at least one cell must be right-to-left too.
    if atlas.metrics.base_direction == Direction::Rtl
        && !atlas
            .glyphs
            .iter()
            .any(|glyph| glyph.direction == Direction::Rtl)
    {
        return Err(GlyphAtlasError::DerivedFieldMismatch);
    }
    if atlas.content_hash.len() != CONTENT_HASH_DIGITS
        || !atlas
            .content_hash
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(GlyphAtlasError::UnsupportedContentHash);
    }
    Ok(())
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

fn deserialize_glyphs<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<StagedGlyph>, D::Error> {
    deserializer.deserialize_seq(BoundedSeq {
        limit: MAX_GLYPH_COUNT,
        what: "atlas glyphs",
        marker: PhantomData,
    })
}

// The registry

struct StagedEntry {
    atlas_id: AssetId,
    atlas: Arc<StagedGlyphAtlas>,
    resident_bytes: u64,
}

impl fmt::Debug for StagedEntry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StagedEntry")
            .field("atlas_id", &self.atlas_id)
            .field("resident_bytes", &self.resident_bytes)
            .finish_non_exhaustive()
    }
}

/// Recomputed after every change rather than adjusted, so the bound can never drift away from what
/// is actually resident. The registry holds at most [`MAX_STAGED_ATLASES`] entries, so this is free.
fn total_resident_bytes(entries: &[StagedEntry]) -> u64 {
    entries.iter().map(|entry| entry.resident_bytes).sum()
}

/// Least recently used first, so the front of `entries` is always the next eviction.
#[derive(Debug)]
struct GlyphAtlasRegistry {
    entries: Vec<StagedEntry>,
    total_bytes: u64,
    max_atlases: usize,
    max_bytes: u64,
}

/// A bounded, least-recently-used registry of staged glyph atlases.
///
/// Bounded twice, by count and by retained pixel bytes, because either alone leaves the other
/// unbounded. Eviction order matches the `WebView`'s own handle cache, so the two sides forget the
/// same atlas first and a `WebView` cache miss simply re-stages it.
#[derive(Clone)]
pub(crate) struct GlyphAtlasStore(Arc<Mutex<GlyphAtlasRegistry>>);

impl fmt::Debug for GlyphAtlasStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GlyphAtlasStore")
            .field("registry", &"<redacted>")
            .finish()
    }
}

impl GlyphAtlasStore {
    /// Creates the registry with the shipped bounds.
    #[allow(
        dead_code,
        reason = "reachable once lib.rs manages this store; remove with the wiring change"
    )]
    pub(crate) fn new() -> Self {
        Self::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES)
    }

    fn with_limits(max_atlases: usize, max_bytes: u64) -> Self {
        Self(Arc::new(Mutex::new(GlyphAtlasRegistry {
            entries: Vec::new(),
            total_bytes: 0,
            max_atlases,
            max_bytes,
        })))
    }

    /// Retains one checked atlas under a fresh opaque identifier, evicting as far as it must.
    ///
    /// A well-formed frame always fits, because the frame budget is below the registry budget, so
    /// eviction never has to refuse an atlas that passed decoding.
    fn stage(&self, atlas: StagedGlyphAtlas) -> Result<AssetId, StagingRefusal> {
        let resident_bytes = atlas.resident_bytes();
        let atlas_id = AssetId::new();
        let mut registry = self.0.lock().map_err(|_| StagingRefusal::Unavailable)?;
        while !registry.entries.is_empty()
            && (registry.entries.len() >= registry.max_atlases
                || registry.total_bytes.saturating_add(resident_bytes) > registry.max_bytes)
        {
            registry.entries.remove(0);
            registry.total_bytes = total_resident_bytes(&registry.entries);
        }
        registry.entries.push(StagedEntry {
            atlas_id,
            atlas: Arc::new(atlas),
            resident_bytes,
        });
        registry.total_bytes = total_resident_bytes(&registry.entries);
        Ok(atlas_id)
    }

    /// Resolves a staged atlas by its opaque identifier and marks it most recently used.
    ///
    /// This is what makes the bound least-recently-*used* rather than least-recently-staged: the
    /// compositor's own reads decide what survives.
    #[allow(
        dead_code,
        reason = "the compositor wave consumes staged atlases by id; staging lands first"
    )]
    pub(crate) fn resolve(
        &self,
        atlas_id: AssetId,
    ) -> Result<Option<Arc<StagedGlyphAtlas>>, StagingRefusal> {
        let mut registry = self.0.lock().map_err(|_| StagingRefusal::Unavailable)?;
        let Some(index) = registry
            .entries
            .iter()
            .position(|entry| entry.atlas_id == atlas_id)
        else {
            return Ok(None);
        };
        let entry = registry.entries.remove(index);
        let atlas = Arc::clone(&entry.atlas);
        registry.entries.push(entry);
        Ok(Some(atlas))
    }
}

// The command

/// The whole of what staging returns: an opaque handle and the hash the caller sent.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GlyphAtlasStageResponse {
    atlas_id: AssetId,
    content_hash: String,
}

/// Stages one baked glyph atlas frame and returns an opaque handle for it.
#[tauri::command]
#[allow(
    dead_code,
    reason = "reachable once lib.rs registers the command; remove with the wiring change"
)]
#[allow(
    clippy::needless_pass_by_value,
    reason = "Tauri injects State and Request as owned command extractors"
)]
pub(crate) fn glyph_atlas_stage(
    store: State<'_, GlyphAtlasStore>,
    request: Request<'_>,
) -> CommandResult<GlyphAtlasStageResponse> {
    let media_type = request
        .headers()
        .get(CONTENT_TYPE_HEADER)
        .and_then(|value| value.to_str().ok());
    let InvokeBody::Raw(frame) = request.body() else {
        return Err(StagingRefusal::UnsupportedBody.into());
    };
    let atlas = decode_frame(media_type, frame)?;
    let content_hash = atlas.content_hash().to_owned();
    let atlas_id = store.stage(atlas)?;
    Ok(GlyphAtlasStageResponse {
        atlas_id,
        content_hash,
    })
}

#[cfg(test)]
mod tests {
    use osg_scene::glyph::GlyphAtlasError;

    use super::{
        FRAME_HEADER_BYTES, GLYPH_ATLAS_FRAME_MEDIA_TYPE, GLYPH_ATLAS_STAGING_VERSION,
        GlyphAtlasStore, MAX_FRAME_BYTES, MAX_METADATA_BYTES, MAX_STAGED_ATLASES, MAX_STAGED_BYTES,
        StagedGlyphAtlas, StagingRefusal, decode_frame,
    };
    use crate::error::CommandError;

    /// A family and two clusters that appear nowhere else, so a leak is unambiguous.
    const MARKER_FAMILY: &str = "Zmarkerfamilyz";
    const MARKER_CLUSTER_ONE: &str = "Ǆ";
    const MARKER_CLUSTER_TWO: &str = "ǅ";

    /// The exact metadata `glyphAtlasStaging.js` emits, written literally so this test pins the
    /// wire format independently of the JavaScript that produces it.
    ///
    /// `glyphs` is spliced in whole rather than generated, so a test can pin an inkless run as
    /// deliberately as it pins an inked one.
    fn metadata_with(width_px: u32, height_px: u32, glyph_count: u32, glyphs: &str) -> String {
        format!(
            concat!(
                r#"{{"frameVersion":1,"atlasVersion":1,"contentHash":"0a1b2c3d","#,
                r#""face":{{"requestedFamily":"{family}","weight":400,"style":"normal","#,
                r#""fontSizePx":48,"substituted":false}},"#,
                r#""metrics":{{"ascentPx":38,"descentPx":10,"lineHeightPx":56,"baselinePx":40,"#,
                r#""runAdvanceWidthPx":64,"shapingResidualPx":0,"baseDirection":"ltr"}},"#,
                r#""atlas":{{"widthPx":{width},"heightPx":{height},"paddingPx":1,"#,
                r#""glyphCount":{count},"pixelFormat":"rgba8","bytesPerRow":{stride}}},"#,
                r#""glyphs":[{glyphs}]}}"#
            ),
            family = MARKER_FAMILY,
            width = width_px,
            height = height_px,
            count = glyph_count,
            stride = width_px * 4,
            glyphs = glyphs,
        )
    }

    fn metadata(width_px: u32, height_px: u32) -> String {
        let cell = |cluster: &str, x_px: u32| {
            format!(
                concat!(
                    r#"{{"cluster":"{cluster}","direction":"ltr","advanceWidthPx":32,"#,
                    r#""xPx":{x},"yPx":0,"widthPx":2,"heightPx":2,"originXPx":0,"#,
                    r#""originYPx":1,"substituted":false}}"#
                ),
                cluster = cluster,
                x = x_px,
            )
        };
        metadata_with(
            width_px,
            height_px,
            2,
            &format!(
                "{},{}",
                cell(MARKER_CLUSTER_ONE, 0),
                cell(MARKER_CLUSTER_TWO, 2)
            ),
        )
    }

    /// Builds a frame by hand from its three parts, so a test can corrupt exactly one of them.
    fn frame_parts(
        magic: &[u8],
        frame_version: u32,
        metadata: &[u8],
        declared_metadata_len: u32,
        pixels: &[u8],
    ) -> Vec<u8> {
        let mut frame = Vec::with_capacity(FRAME_HEADER_BYTES + metadata.len() + pixels.len());
        frame.extend_from_slice(magic);
        frame.extend_from_slice(&frame_version.to_le_bytes());
        frame.extend_from_slice(&declared_metadata_len.to_le_bytes());
        frame.extend_from_slice(metadata);
        frame.extend_from_slice(pixels);
        frame
    }

    fn frame(metadata: &str, pixels: &[u8]) -> Vec<u8> {
        let metadata = metadata.as_bytes();
        frame_parts(
            b"OSGATLAS",
            GLYPH_ATLAS_STAGING_VERSION,
            metadata,
            u32::try_from(metadata.len()).expect("test metadata length"),
            pixels,
        )
    }

    /// A 4x2 RGBA8 atlas: 32 tightly packed bytes.
    fn valid_frame() -> Vec<u8> {
        frame(&metadata(4, 2), &[0x7f_u8; 32])
    }

    fn stage(frame: &[u8]) -> Result<StagedGlyphAtlas, StagingRefusal> {
        decode_frame(Some(GLYPH_ATLAS_FRAME_MEDIA_TYPE), frame)
    }

    #[test]
    fn a_valid_frame_stages_and_returns_the_echoed_hash() {
        let atlas = stage(&valid_frame()).expect("valid frame");

        assert_eq!(atlas.content_hash(), "0a1b2c3d");
        assert_eq!(atlas.pixels.len(), 32);
        assert_eq!(atlas.metadata.atlas.width_px, 4);
        assert_eq!(atlas.metadata.atlas.height_px, 2);
        assert_eq!(atlas.metadata.glyphs.len(), 2);
        assert_eq!(atlas.metadata.glyphs[0].cluster, MARKER_CLUSTER_ONE);
        assert_eq!(atlas.metadata.face.requested_family, MARKER_FAMILY);

        let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES);
        let atlas_id = store.stage(atlas).expect("stage");
        let resolved = store.resolve(atlas_id).expect("resolve").expect("present");
        assert_eq!(resolved.content_hash(), "0a1b2c3d");
        // The handle is a fresh UUIDv7, which is what the WebView validates before trusting it.
        assert_eq!(atlas_id.as_uuid().get_version_num(), 7);
    }

    #[test]
    fn an_inkless_run_stages_as_a_zero_by_zero_atlas() {
        let atlas = stage(&frame(&metadata_with(0, 0, 0, ""), &[])).expect("inkless run");
        assert!(atlas.pixels.is_empty());
        assert!(atlas.metadata.glyphs.is_empty());

        // Half a dimension is never a valid atlas, whichever half it is.
        for metadata in [metadata_with(0, 4, 0, ""), metadata_with(4, 0, 0, "")] {
            assert_eq!(
                stage(&frame(&metadata, &[])),
                Err(StagingRefusal::Descriptor(
                    GlyphAtlasError::UnsupportedAtlasSize
                ))
            );
        }
    }

    #[test]
    fn the_shipped_bounds_are_the_ones_the_webview_stages_against() {
        assert_eq!(MAX_FRAME_BYTES, 33_554_432);
        assert_eq!(MAX_METADATA_BYTES, 1_048_576);
        assert_eq!(MAX_STAGED_ATLASES, 8);
        assert_eq!(MAX_STAGED_BYTES, 67_108_864);
        assert_eq!(FRAME_HEADER_BYTES, 16);
        assert_eq!(GLYPH_ATLAS_STAGING_VERSION, 1);
    }

    #[test]
    fn the_frame_media_type_is_required() {
        assert_eq!(
            decode_frame(None, &valid_frame()),
            Err(StagingRefusal::UnsupportedMediaType)
        );
        assert_eq!(
            decode_frame(Some("application/octet-stream"), &valid_frame()),
            Err(StagingRefusal::UnsupportedMediaType)
        );
        assert_eq!(
            decode_frame(Some("application/vnd.osg.glyph-atlas.v2"), &valid_frame()),
            Err(StagingRefusal::UnsupportedMediaType)
        );
    }

    #[test]
    fn oversized_and_undersized_bodies_are_refused_before_the_frame_is_read() {
        // Both refusals are decided against the borrowed body, so neither copies it: the oversized
        // body carries no magic at all and is still refused as over budget rather than as garbage.
        let oversized = vec![0_u8; MAX_FRAME_BYTES + 1];
        assert_eq!(stage(&oversized), Err(StagingRefusal::FrameTooLarge));

        for length in 0..FRAME_HEADER_BYTES {
            assert_eq!(
                stage(&valid_frame()[..length]),
                Err(StagingRefusal::FrameTooShort),
                "a {length}-byte body is not a frame"
            );
        }
    }

    #[test]
    fn a_frame_without_the_staging_magic_is_refused() {
        let metadata = metadata(4, 2);
        let frame = frame_parts(
            b"OSGATLA5",
            GLYPH_ATLAS_STAGING_VERSION,
            metadata.as_bytes(),
            u32::try_from(metadata.len()).expect("length"),
            &[0_u8; 32],
        );
        assert_eq!(stage(&frame), Err(StagingRefusal::UnsupportedMagic));
    }

    #[test]
    fn an_unknown_frame_version_is_refused_rather_than_migrated() {
        let metadata = metadata(4, 2);
        for version in [0, 2, u32::MAX] {
            let frame = frame_parts(
                b"OSGATLAS",
                version,
                metadata.as_bytes(),
                u32::try_from(metadata.len()).expect("length"),
                &[0_u8; 32],
            );
            assert_eq!(stage(&frame), Err(StagingRefusal::UnsupportedFrameVersion));
        }
        // The header and the metadata both carry the frame version, and they must agree.
        let disagreeing = metadata.replace(r#""frameVersion":1"#, r#""frameVersion":2"#);
        assert_eq!(
            stage(&frame(&disagreeing, &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedFrameVersion)
        );
    }

    #[test]
    fn an_unknown_atlas_version_is_refused() {
        let metadata = metadata(4, 2).replace(r#""atlasVersion":1"#, r#""atlasVersion":2"#);
        assert_eq!(
            stage(&frame(&metadata, &[0_u8; 32])),
            Err(StagingRefusal::Descriptor(
                GlyphAtlasError::UnsupportedVersion
            ))
        );
    }

    #[test]
    fn a_metadata_length_past_its_budget_or_past_the_frame_is_refused() {
        let metadata = metadata(4, 2);
        let honest = u32::try_from(metadata.len()).expect("length");

        // Past the metadata budget, and past the frame, without either quantity being allocated.
        for declared in [
            u32::try_from(MAX_METADATA_BYTES + 1).expect("budget"),
            u32::MAX,
            // Past the end of this frame: the honest metadata plus every pixel byte and one more.
            honest + 33,
        ] {
            let frame = frame_parts(
                b"OSGATLAS",
                GLYPH_ATLAS_STAGING_VERSION,
                metadata.as_bytes(),
                declared,
                &[0_u8; 32],
            );
            assert_eq!(
                stage(&frame),
                Err(StagingRefusal::UnsupportedMetadataLength),
                "a declared metadata length of {declared} is not readable"
            );
        }
    }

    #[test]
    fn a_pixel_length_disagreeing_with_the_declared_atlas_is_refused_both_ways() {
        assert_eq!(
            stage(&frame(&metadata(4, 2), &[0_u8; 31])),
            Err(StagingRefusal::PixelLengthMismatch),
            "one byte short of the declared atlas"
        );
        assert_eq!(
            stage(&frame(&metadata(4, 2), &[0_u8; 33])),
            Err(StagingRefusal::PixelLengthMismatch),
            "one byte past the declared atlas"
        );
        assert_eq!(
            stage(&frame(&metadata(4, 2), &[])),
            Err(StagingRefusal::PixelLengthMismatch),
            "no pixels at all"
        );
    }

    #[test]
    fn malformed_and_unknown_metadata_is_refused() {
        assert_eq!(
            stage(&frame("{\"frameVersion\":1,", &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedMetadata),
            "truncated JSON"
        );
        assert_eq!(
            stage(&frame("not json at all", &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedMetadata),
            "not JSON"
        );

        let unknown_top_level = metadata(4, 2).replace(
            r#""contentHash":"0a1b2c3d""#,
            r#""contentHash":"0a1b2c3d","cssFont":"48px \"Zmarkerfamilyz\"""#,
        );
        assert_eq!(
            stage(&frame(&unknown_top_level, &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedMetadata),
            "an invented top-level field"
        );

        let unknown_face_field = metadata(4, 2).replace(
            r#""fontSizePx":48"#,
            r#""fontSizePx":48,"probes":[{"probeFamily":"serif"}]"#,
        );
        assert_eq!(
            stage(&frame(&unknown_face_field, &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedMetadata),
            "invented shaping evidence"
        );

        let unknown_glyph_field = metadata(4, 2).replace(
            r#""advanceWidthPx":32"#,
            r#""advanceWidthPx":32,"codePoints":[453]"#,
        );
        assert_eq!(
            stage(&frame(&unknown_glyph_field, &[0_u8; 32])),
            Err(StagingRefusal::UnsupportedMetadata),
            "a second encoding of the cluster identity"
        );
    }

    #[test]
    fn descriptor_agreements_the_wire_cannot_carry_are_re_derived() {
        let cases = [
            (
                metadata(4, 2).replace(r#""glyphCount":2"#, r#""glyphCount":3"#),
                GlyphAtlasError::GlyphCountMismatch,
            ),
            (
                metadata(4, 2)
                    .replace(r#""contentHash":"0a1b2c3d""#, r#""contentHash":"0A1B2C3D""#),
                GlyphAtlasError::UnsupportedContentHash,
            ),
            (
                metadata(4, 2).replace(r#""bytesPerRow":16"#, r#""bytesPerRow":256"#),
                GlyphAtlasError::UnsupportedRowStride,
            ),
            (
                metadata(4, 2).replace(r#""fontSizePx":48"#, r#""fontSizePx":2048"#),
                GlyphAtlasError::UnsupportedFontSize,
            ),
            (
                metadata(4, 2).replace(r#""baseDirection":"ltr""#, r#""baseDirection":"rtl""#),
                GlyphAtlasError::DerivedFieldMismatch,
            ),
            (
                metadata(4, 2).replace(r#""paddingPx":1"#, r#""paddingPx":64"#),
                GlyphAtlasError::UnsupportedPadding,
            ),
            (
                metadata(4, 2).replace(r#""xPx":2,"yPx":0"#, r#""xPx":3,"yPx":0"#),
                GlyphAtlasError::GlyphOutsideAtlas,
            ),
            (
                // The clusters swapped, so they are no longer in the baker's order.
                metadata(4, 2)
                    .replace(MARKER_CLUSTER_ONE, "\u{fffd}")
                    .replace(MARKER_CLUSTER_TWO, MARKER_CLUSTER_ONE)
                    .replace('\u{fffd}', MARKER_CLUSTER_TWO),
                GlyphAtlasError::UnorderedGlyphs,
            ),
            (
                // The face claims a substitution that no cell records.
                metadata(4, 2).replace(
                    r#""substituted":false},"metrics""#,
                    r#""substituted":true},"metrics""#,
                ),
                GlyphAtlasError::DerivedFieldMismatch,
            ),
        ];
        for (metadata, expected) in cases {
            assert_eq!(
                stage(&frame(&metadata, &[0_u8; 32])),
                Err(StagingRefusal::Descriptor(expected)),
                "{expected} was not re-derived"
            );
        }
    }

    #[test]
    fn the_registry_evicts_the_least_recently_used_atlas_by_count() {
        let store = GlyphAtlasStore::with_limits(2, MAX_STAGED_BYTES);
        let first = store
            .stage(stage(&valid_frame()).expect("first"))
            .expect("id");
        let second = store
            .stage(stage(&valid_frame()).expect("second"))
            .expect("id");

        // Resolving the older atlas makes it the most recently used, so the newer one goes first.
        assert!(store.resolve(first).expect("resolve").is_some());
        let third = store
            .stage(stage(&valid_frame()).expect("third"))
            .expect("id");

        assert!(store.resolve(second).expect("resolve").is_none());
        assert!(store.resolve(first).expect("resolve").is_some());
        assert!(store.resolve(third).expect("resolve").is_some());
        assert_eq!(store.0.lock().expect("registry").entries.len(), 2);
    }

    #[test]
    fn the_registry_evicts_by_retained_bytes_before_it_reaches_its_count() {
        // Three 32-byte atlases do not fit a 64-byte budget, though three entries would fit eight.
        let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, 64);
        let first = store
            .stage(stage(&valid_frame()).expect("first"))
            .expect("id");
        let second = store
            .stage(stage(&valid_frame()).expect("second"))
            .expect("id");
        assert_eq!(store.0.lock().expect("registry").total_bytes, 64);

        let third = store
            .stage(stage(&valid_frame()).expect("third"))
            .expect("id");

        assert!(store.resolve(first).expect("resolve").is_none());
        assert!(store.resolve(second).expect("resolve").is_some());
        assert!(store.resolve(third).expect("resolve").is_some());
        let registry = store.0.lock().expect("registry");
        assert_eq!(registry.entries.len(), 2);
        assert_eq!(registry.total_bytes, 64);
        assert!(registry.total_bytes <= registry.max_bytes);
    }

    #[test]
    fn a_refusal_never_names_a_family_a_cluster_a_path_or_a_byte_count() {
        let refusals = [
            StagingRefusal::UnsupportedMediaType,
            StagingRefusal::UnsupportedBody,
            StagingRefusal::FrameTooLarge,
            StagingRefusal::FrameTooShort,
            StagingRefusal::UnsupportedMagic,
            StagingRefusal::UnsupportedFrameVersion,
            StagingRefusal::UnsupportedMetadataLength,
            StagingRefusal::UnsupportedMetadata,
            StagingRefusal::PixelLengthMismatch,
            StagingRefusal::Unavailable,
            StagingRefusal::Descriptor(GlyphAtlasError::UnsupportedFace),
            StagingRefusal::Descriptor(GlyphAtlasError::UnsupportedCluster),
            StagingRefusal::Descriptor(GlyphAtlasError::PixelBufferMismatch),
        ];
        for refusal in refusals {
            let command = CommandError::from(refusal);
            let rendered = format!("{refusal} {command:?}");
            assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
            assert!(!rendered.contains(MARKER_CLUSTER_ONE), "{rendered}");
            assert!(!rendered.contains(MARKER_CLUSTER_TWO), "{rendered}");
            assert!(
                !rendered.contains('\\') && !rendered.contains('/'),
                "{rendered}"
            );
            assert!(!rendered.chars().any(|c| c.is_ascii_digit()), "{rendered}");
        }

        // The same holds for a refusal produced from real hostile input carrying the markers.
        let hostile = metadata(4, 2).replace(r#""weight":400"#, r#""weight":9001"#);
        let refusal = stage(&frame(&hostile, &[0_u8; 32])).expect_err("refused");
        let command = CommandError::from(refusal);
        let rendered = format!("{refusal} {command:?}");
        assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
        assert!(!rendered.contains("9001"), "{rendered}");
    }

    #[test]
    fn a_staged_atlas_is_never_formatted_into_a_log() {
        let atlas = stage(&valid_frame()).expect("valid frame");
        let rendered = format!("{atlas:?}");

        assert!(!rendered.contains(MARKER_FAMILY), "{rendered}");
        assert!(!rendered.contains(MARKER_CLUSTER_ONE), "{rendered}");
        assert!(!rendered.contains(MARKER_CLUSTER_TWO), "{rendered}");
        assert!(rendered.contains("<redacted>"), "{rendered}");

        let store = GlyphAtlasStore::with_limits(MAX_STAGED_ATLASES, MAX_STAGED_BYTES);
        store.stage(atlas).expect("stage");
        assert!(!format!("{store:?}").contains(MARKER_FAMILY));
    }
}
