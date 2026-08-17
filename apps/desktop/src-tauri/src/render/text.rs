//! Where an export's glyphs come from.
//!
//! The architecture forbids a Rust text stack: the `WebView` shapes, rasterizes and lays out, and
//! Rust draws what it laid out. An export therefore cannot be built from a [`RenderRequest`] alone —
//! the text has to arrive already shaped — and this module is the boundary that carries it.
//!
//! # Why the request cannot carry it
//!
//! [`osg_export::run_export`] needs one [`StagedText`]: a resolved face, the glyph atlas **pages**
//! the document was baked into, and **one run per cue** whose cells index the page that cue was
//! baked into. Two properties of the pieces that already exist decide the shape of this boundary:
//!
//! * A staged [`GlyphAtlasDescriptor`] carries exactly one [`AtlasLayout`](osg_scene::glyph::AtlasLayout),
//!   because the baker bakes one text run at a time. It is the whole layout of *one* cue.
//! * [`osg_compositor::SubtitleScene`] refuses a run count that is not the cue count, and every run
//!   indexes the page its own cue names.
//!
//! So an export of *n* cues is one or more atlases whose cell tables together cover every cue, the
//! page each cue was baked into, and *n* runs. Each atlas crosses as it always has, through
//! `glyph_atlas_stage`, and is addressed here by the handle that command minted — never re-baked,
//! never guessed at, never chosen by scanning the registry for something that looks close. The runs
//! cross here, as the positions the baker emitted, and are copied rather than derived: this side
//! accumulates no pen, wraps nothing and reorders nothing.
//!
//! # Why there is more than one page
//!
//! One atlas holds a bounded number of distinct cells. A Latin document never approaches that bound;
//! a CJK, Korean, mixed-script or emoji-heavy one passes it within a few lines, and used to be
//! unexportable for that reason alone. The baker now bakes such a document into several pages and
//! this payload records which page each cue belongs to. One cue is visible per frame, so one page is
//! bound per frame — nothing downstream needs a texture array or a per-quad page.
//!
//! # Why every handle is cross-checked
//!
//! A handle alone would let a stale editor cache address an atlas that has since been evicted and
//! replaced under a recycled identifier, and drawing that would be silently wrong — the exact
//! divergence between what the preview showed and what the export writes that this pipeline exists
//! to remove. The baker's own content hash is compared, per page, for the same reason the preview
//! compares it.

use std::fmt;

use osg_compositor::{CueLine, CueRun, MAX_RUN_GLYPHS, MAX_RUN_LINES};
use osg_domain::AssetId;
use osg_export::StagedText;
use osg_scene::glyph::{GlyphAtlasDescriptor, MAX_ATLAS_PAGES};
use osg_scene::scene::ResolvedFace;
use serde::Deserialize;

use crate::error::{CommandError, CommandResult};
use crate::glyph_atlas::registry::GlyphAtlasStore;

use super::refusal;

/// The only export-text payload version this build reads.
///
/// An unknown version is refused whole rather than migrated: a field's meaning is defined by its
/// version, so reading one out of an unknown payload is guessing. Version 1 carried one atlas handle
/// at the top level and no page per cue; it is refused by that same rule rather than read as a
/// one-page version 2, because a build that accepted both would have two payload shapes to keep in
/// step forever.
pub(crate) const EXPORT_TEXT_SCHEMA_VERSION: u32 = 2;

/// The longest opaque identity this boundary accepts, mirroring the preview's own bound.
const MAX_IDENTITY_BYTES: usize = 128;

/// The most cues one export may stage text for, mirroring the render contract's own lyric bound.
const MAX_STAGED_CUES: usize = 100_000;

/// Where a staged atlas is resolved from.
///
/// A trait rather than the registry directly, so this boundary can be tested without one — and so
/// the direction of the dependency matches the direction of the need: the export reaches for an
/// atlas, and the staging registry knows nothing about exports.
pub(crate) trait StagedAtlases {
    /// Resolves one staged atlas, or refuses.
    ///
    /// # Errors
    /// Returns [`refusal::atlas_unknown`] when nothing answers to `atlas_id`, when the staged atlas
    /// is not the one `content_hash` names, or when the registry is unavailable.
    fn descriptor(
        &self,
        atlas_id: AssetId,
        content_hash: &str,
    ) -> CommandResult<GlyphAtlasDescriptor>;
}

impl StagedAtlases for GlyphAtlasStore {
    fn descriptor(
        &self,
        atlas_id: AssetId,
        content_hash: &str,
    ) -> CommandResult<GlyphAtlasDescriptor> {
        let staged = self
            .resolve(atlas_id)
            .map_err(|_| CommandError::internal("The glyph atlas registry is unavailable."))?
            .ok_or_else(refusal::atlas_unknown)?;
        if staged.content_hash() != content_hash {
            return Err(refusal::atlas_unknown());
        }
        // Infallible in practice — staging refuses anything that cannot become a descriptor — but
        // the conversion is fallible by type, and inventing an `expect` here would be the one place
        // a malformed atlas could take the process down.
        staged.to_descriptor().map_err(|_| refusal::atlas_unknown())
    }
}

/// The text the `WebView` staged for one export, exactly as it arrives.
///
/// Deserialized with `deny_unknown_fields`, so a payload this build does not read is refused whole
/// rather than half-understood.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportTextRequest {
    /// The payload shape version, refused before any other field is read.
    pub(crate) schema_version: u32,
    /// The face the `WebView` resolved and baked from.
    pub(crate) face: ResolvedFace,
    /// The atlas pages the document was baked into, in the baker's own page order.
    pub(crate) pages: Vec<ExportAtlasPage>,
    /// One laid-out run per cue, in the request's own cue order.
    pub(crate) cues: Vec<ExportCueRun>,
}

impl fmt::Debug for ExportTextRequest {
    /// Redacted: the face family is editor content and the runs are the shape of a user's text.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExportTextRequest")
            .field("schema_version", &self.schema_version)
            .field("pages", &self.pages.len())
            .field("cues", &self.cues.len())
            .finish_non_exhaustive()
    }
}

/// One baked atlas page, as the handle it was staged under plus the identity to cross-check it with.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportAtlasPage {
    /// The handle `glyph_atlas_stage` minted for this page.
    pub(crate) atlas_id: AssetId,
    /// The baker's identity for this page, cross-checked against the staged one.
    pub(crate) atlas_content_hash: String,
}

/// One cue's laid-out lines, and the page they were baked into.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportCueRun {
    /// Which entry of [`ExportTextRequest::pages`] this cue's cells index.
    pub(crate) page: u32,
    pub(crate) lines: Vec<ExportCueLine>,
}

impl fmt::Debug for ExportCueRun {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExportCueRun")
            .field("page", &self.page)
            .field("lines", &self.lines.len())
            .finish()
    }
}

/// One laid-out line, in the atlas pixel space the baker measured in.
///
/// Field for field what [`CueLine::new`] takes, because it is the same data: the cells in visual
/// order, each one's line-relative pen, the line box's width and the line's baseline.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExportCueLine {
    pub(crate) glyphs: Vec<u32>,
    pub(crate) pen_x_px: Vec<f64>,
    pub(crate) advance_width_px: f64,
    pub(crate) baseline_y_px: f64,
}

impl fmt::Debug for ExportCueLine {
    /// Cell indices address an atlas the user's own text was baked into, so only counts are logged.
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ExportCueLine")
            .field("glyphs", &self.glyphs.len())
            .finish_non_exhaustive()
    }
}

impl ExportTextRequest {
    /// Checks everything decidable without touching the registry.
    ///
    /// Deliberately shallow. Whether the runs agree with the atlas is decided by
    /// [`osg_compositor::SubtitleScene`], which is the code that defines what a drawable run is;
    /// restating any of it here would be a second vocabulary to keep in step. What is checked is
    /// only what belongs to *this* boundary: the version, the opacity of the identity it carries,
    /// and the sizes it would otherwise make this process allocate.
    fn check(&self, cue_count: usize) -> CommandResult<()> {
        if self.schema_version != EXPORT_TEXT_SCHEMA_VERSION {
            return Err(refusal::text_mismatched());
        }
        if self.pages.is_empty() {
            return Err(refusal::text_pages_missing());
        }
        if self.pages.len() > MAX_ATLAS_PAGES {
            return Err(refusal::text_too_many_pages());
        }
        if !self
            .pages
            .iter()
            .all(|page| is_opaque_identity(&page.atlas_content_hash))
        {
            return Err(refusal::text_mismatched());
        }
        if self.cues.len() != cue_count || cue_count > MAX_STAGED_CUES {
            return Err(refusal::text_mismatched());
        }
        for run in &self.cues {
            // A page a cue names but the payload did not stage is refused here rather than at the
            // registry, so the message says which agreement broke instead of blaming an atlas that
            // is missing only because it was never named.
            if !usize::try_from(run.page).is_ok_and(|page| page < self.pages.len()) {
                return Err(refusal::text_page_unknown());
            }
            if run.lines.is_empty() || run.lines.len() > MAX_RUN_LINES {
                return Err(refusal::text_mismatched());
            }
            let mut cells = 0_usize;
            for line in &run.lines {
                if line.glyphs.len() != line.pen_x_px.len() {
                    return Err(refusal::text_mismatched());
                }
                cells = cells
                    .checked_add(line.glyphs.len())
                    .filter(|total| *total <= MAX_RUN_GLYPHS)
                    .ok_or_else(refusal::text_mismatched)?;
            }
        }
        Ok(())
    }

    /// Resolves the staged atlas and turns the payload into the text an export is built from.
    ///
    /// `cue_count` is the validated plan's own cue count. A payload that describes a different
    /// number of cues is refused here rather than surfacing later as a run-count rejection whose
    /// cause is not obvious.
    ///
    /// # Errors
    /// Returns [`refusal::text_mismatched`] for a payload this build does not read or one that does
    /// not describe these cues, [`refusal::text_pages_missing`], [`refusal::text_too_many_pages`] or
    /// [`refusal::text_page_unknown`] for a page list this build cannot draw from, and
    /// [`refusal::atlas_unknown`] when no staged atlas answers to a handle it names.
    pub(crate) fn resolve(
        self,
        atlases: &dyn StagedAtlases,
        cue_count: usize,
    ) -> CommandResult<StagedText> {
        self.check(cue_count)?;
        // One descriptor per page, each cross-checked against the identity the payload named for it,
        // exactly as the single-atlas payload cross-checked its one.
        let mut pages = Vec::with_capacity(self.pages.len());
        for page in &self.pages {
            pages.push(atlases.descriptor(page.atlas_id, &page.atlas_content_hash)?);
        }
        let page_of_cue = self.cues.iter().map(|run| run.page).collect();
        let runs = self.cues.into_iter().map(ExportCueRun::into_run).collect();
        Ok(StagedText::new(self.face, pages, page_of_cue, runs))
    }
}

impl ExportCueRun {
    /// Copies the baker's positions into the compositor's own run type.
    ///
    /// A copy rather than a computation: the pens already carry letter spacing and justification,
    /// and the baselines already carry the line height, exactly as [`CueRun::from_layout`] copies
    /// them for the preview.
    fn into_run(self) -> CueRun {
        CueRun::new(
            self.lines
                .into_iter()
                .map(|line| {
                    CueLine::new(
                        line.glyphs,
                        line.pen_x_px,
                        line.advance_width_px,
                        line.baseline_y_px,
                    )
                })
                .collect(),
        )
    }
}

/// A bounded, control-free opaque token: a content hash this side only ever compares.
fn is_opaque_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTITY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}
