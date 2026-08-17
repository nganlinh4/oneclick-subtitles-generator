//! The native side of the glyph atlas staging boundary.
//!
//! `src/platform/glyphAtlasStaging.js` bakes a text revision inside the `WebView` and hands each
//! baked atlas to native code as a single self-describing binary body. This module is the receiving
//! end: it decodes that frame, refuses anything the baker could not have produced, and holds the
//! result in a bounded registry that the compositor later addresses by an opaque identifier.
//!
//! One atlas holds a bounded number of distinct cells, so a document with a large character set is
//! baked into several pages. Each page crosses this boundary on its own and gets its own handle;
//! nothing here knows they belong together. What binds them into one document is the export payload
//! in `crate::render::text`, which names the pages and the page each cue was baked into.
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
//! [`GlyphAtlasError`](osg_scene::glyph::GlyphAtlasError)) and re-derives the rest:
//!
//! * `glyph.codePoints` is omitted on the wire and re-derived exactly from `cluster` here, because
//!   a second encoding of the same identity can only ever disagree with the first.
//! * `face.cssFont` and `face.probes` DO cross, and carrying the baker's real measurements is the
//!   point. They are the proof that the requested face actually participated in the measurement,
//!   and with them here the substitution verdict is re-derived rather than taken on trust. They
//!   were once omitted, on the reasoning that this side should not make a claim it could not
//!   support — but the answer to that is to forward the evidence, not to drop it. What must never
//!   happen is synthesising them, which would turn the check into a rubber stamp that always
//!   passes; a staged frame that omits them is refused, never repaired.
//!
//! ## What never crosses back
//!
//! Every refusal names a field and never a value: no cluster text, no family name, no path, no byte
//! count. A refusal may be logged; a user's subtitle text and the atlas pixels may not.
//!
//! ## Layout
//!
//! The module is split along the boundary's own seams: [`decode`] turns a body into a staged frame,
//! [`validation`] enforces every bound the baker enforces on the way out, [`registry`] retains what
//! passed, [`command`] is the `WebView`-facing entry point, and [`refusal`] is the value-free
//! vocabulary all of them refuse in. This file owns the shared limits and the staged frame itself.
//!
//! The wiring change reaches this boundary through [`registry::GlyphAtlasStore`] and
//! [`command::glyph_atlas_stage`]; every other item stays inside the module.

use std::fmt;

use osg_scene::glyph::{
    AtlasFace, AtlasGeometry, AtlasGlyph, AtlasLayout, AtlasMetrics, Direction, FaceProbe,
    FaceStyle, GlyphAtlasDescriptor, MAX_ATLAS_PAGES, UncheckedGlyphAtlas,
};
use serde::Deserialize;

use self::refusal::StagingRefusal;

pub(crate) mod command;
mod decode;
mod refusal;
pub(crate) mod registry;
mod validation;

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
/// One export stages up to [`MAX_ATLAS_PAGES`] pages and they must all be resident at once, because
/// the export resolves every page before it composes its first frame. Eight more is the preview's
/// headroom: the editor re-bakes as the user types, and evicting an export's own pages to make room
/// for a preview bake would fail the export that is already running.
///
/// The `WebView` bounds its handle cache by the same count, so both sides evict in the same order
/// and a `WebView` cache miss simply re-stages.
const MAX_STAGED_ATLASES: usize = MAX_ATLAS_PAGES + 8;
/// Retained atlas pixel bytes across the whole registry.
///
/// **This is the declared limit that decides whether a large-character-set document exports.** The
/// count bound above admits pages; this one admits their pixels, and pixels are the whole of the
/// cost — the glyph table is bounded by [`MAX_METADATA_BYTES`] and is negligible beside a texture.
/// A document past this budget is refused with a message that says so; it is never truncated to fit,
/// because a truncated atlas exports a video with characters silently missing from it.
///
/// 256 MiB is eight frames at the [`MAX_FRAME_BYTES`] ceiling, which is what a document of the very
/// largest pages would need before it is refused. Real pages are far smaller: a 24px bake of 1024
/// cells is around a megabyte, so an ordinary CJK document's whole page set is a few tens of
/// megabytes and never approaches this.
const MAX_STAGED_BYTES: u64 = 256 * 1024 * 1024;

/// One frame always fits the registry, so eviction never has to refuse a well-formed atlas.
const _: () = assert!(MAX_FRAME_BYTES as u64 <= MAX_STAGED_BYTES);

// The staged frame

/// The face the atlas was baked from, as the staged frame reports it.
///
/// Field for field the same as [`osg_scene::glyph::AtlasFace`]; it exists separately only to keep a
/// redacting `Debug`, because the requested family is editor content.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StagedFace {
    requested_family: String,
    weight: u16,
    style: FaceStyle,
    font_size_px: f64,
    /// The CSS shorthand the baker measured and drew with. Provenance; this side never interprets it.
    css_font: String,
    /// Whether any cell fell back to another face. Derived from the cells.
    substituted: bool,
    /// The generic-family probes proving the requested face took part in the measurement.
    ///
    /// These cross the boundary deliberately. Carrying the baker's REAL measurements is what lets
    /// this side re-derive the substitution verdict instead of taking the flag on trust; inventing
    /// them would turn that check into a rubber stamp, which is the failure the migration removes.
    probes: Vec<FaceProbe>,
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
    /// The authoritative layout: where every cell is drawn, in visual order.
    ///
    /// Reused from `osg-scene` rather than mirrored a second time. It is the only description of
    /// pen positions, baselines, line boxes, wrapping and visual order that exists — the compositor
    /// copies it and derives none of its own — so a staged frame without it is not renderable.
    layout: AtlasLayout,
    /// The rasterized cells, in the baker's strictly increasing cluster order.
    #[serde(deserialize_with = "decode::deserialize_glyphs")]
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

    /// The checked descriptor the compositor draws from.
    ///
    /// Built by handing the staged metadata to `osg-scene`'s own validation rather than by
    /// re-implementing it here. That is the point: the compositor's input is checked by exactly the
    /// code that defines what a valid atlas is, so this boundary cannot accidentally be more
    /// permissive than the contract. The only thing added is `codePoints`, which the wire omits
    /// deliberately and which is re-derived from the cluster it belongs to.
    pub(crate) fn to_descriptor(&self) -> Result<GlyphAtlasDescriptor, StagingRefusal> {
        let unchecked = UncheckedGlyphAtlas {
            version: self.metadata.atlas_version,
            face: AtlasFace {
                requested_family: self.metadata.face.requested_family.clone(),
                weight: self.metadata.face.weight,
                style: self.metadata.face.style,
                font_size_px: self.metadata.face.font_size_px,
                css_font: self.metadata.face.css_font.clone(),
                substituted: self.metadata.face.substituted,
                probes: self.metadata.face.probes.clone(),
            },
            metrics: self.metadata.metrics,
            atlas: self.metadata.atlas,
            layout: self.metadata.layout.clone(),
            glyphs: self
                .metadata
                .glyphs
                .iter()
                .map(|glyph| AtlasGlyph {
                    cluster: glyph.cluster.clone(),
                    code_points: glyph.cluster.chars().map(u32::from).collect(),
                    direction: glyph.direction,
                    advance_width_px: glyph.advance_width_px,
                    x_px: glyph.x_px,
                    y_px: glyph.y_px,
                    width_px: glyph.width_px,
                    height_px: glyph.height_px,
                    origin_x_px: glyph.origin_x_px,
                    origin_y_px: glyph.origin_y_px,
                    substituted: glyph.substituted,
                })
                .collect(),
            content_hash: self.metadata.content_hash.clone(),
            pixels: self.pixels.clone(),
        };
        // `GlyphAtlasError` names the field it rejected and never a value, which is this boundary's
        // contract, so it is carried through rather than flattened — the caller who staged a bad
        // atlas learns which agreement it broke.
        GlyphAtlasDescriptor::try_from(unchecked).map_err(StagingRefusal::from)
    }

    /// The retained cost of this atlas, which the registry bounds.
    fn resident_bytes(&self) -> u64 {
        u64::try_from(self.pixels.len()).unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod fixtures;
#[cfg(test)]
mod tests;
