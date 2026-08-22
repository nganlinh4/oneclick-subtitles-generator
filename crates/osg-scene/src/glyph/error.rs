//! The refusal vocabulary. Kept apart from the rules that raise it so a variant can only ever name
//! a field, never carry one.

/// Why a glyph atlas descriptor was refused.
///
/// Deliberately coarse and value-free: every variant names the field that failed, never its
/// contents, so a refusal can be logged without leaking subtitle text, a family name or atlas
/// pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphAtlasError {
    /// The descriptor declared a version this build does not implement.
    UnsupportedVersion,
    /// The requested family, the weight or the CSS shorthand is not one the baker could emit.
    UnsupportedFace,
    /// The font size is outside the bakeable range.
    UnsupportedFontSize,
    /// The substitution probes are missing, duplicated, or show a face that never participated.
    UnsupportedProbes,
    /// A face metric is not a finite, non-negative number.
    UnsupportedMetrics,
    /// The run's base direction is not a first-strong classification the baker could emit.
    UnsupportedDirection,
    /// The atlas is larger than the supported dimension.
    UnsupportedAtlasSize,
    /// The cell padding is larger than the supported padding.
    UnsupportedPadding,
    /// The row stride is narrower than a row of pixels, wider than any atlas needs, or not a whole
    /// number of pixels.
    UnsupportedRowStride,
    /// There are more glyph cells than the supported count.
    UnsupportedGlyphCount,
    /// A cluster is empty, too long, or does not match the code points recorded beside it.
    UnsupportedCluster,
    /// The glyph cells are not in the baker's strictly increasing cluster order.
    UnorderedGlyphs,
    /// The clusters together carry more code points than a bakeable run.
    UnsupportedTextLength,
    /// A glyph's source rectangle is not wholly inside the atlas.
    GlyphOutsideAtlas,
    /// A layout number is not finite, is larger in magnitude than a consumer could scale and still
    /// place a glyph from, or a line carries a pen position for a cell it does not draw.
    UnsupportedLayout,
    /// The layout carries more lines or more placed cells than is supported.
    UnsupportedLayoutSize,
    /// The layout's wrap width is not a positive finite width this build accepts.
    UnsupportedLayoutWidth,
    /// The letter spacing is not a finite value inside the supported range.
    UnsupportedLetterSpacing,
    /// A laid-out line draws a cell the atlas does not contain.
    LayoutCellIndex,
    /// The layout's line baselines do not strictly descend.
    UnorderedLayoutBaselines,
    /// The declared line count disagrees with the layout's lines.
    LayoutLineCountMismatch,
    /// The declared glyph count disagrees with the glyph list.
    GlyphCountMismatch,
    /// The pixel buffer is not exactly the declared height times the declared row stride.
    PixelBufferMismatch,
    /// A field the baker derived from another field no longer agrees with it.
    DerivedFieldMismatch,
    /// The content hash is not eight lower-case hexadecimal digits.
    UnsupportedContentHash,
}

impl GlyphAtlasError {
    /// Stable, value-free code for command responses and diagnostics.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedVersion => "glyphAtlasUnsupportedVersion",
            Self::UnsupportedFace => "glyphAtlasUnsupportedFace",
            Self::UnsupportedFontSize => "glyphAtlasUnsupportedFontSize",
            Self::UnsupportedProbes => "glyphAtlasUnsupportedProbes",
            Self::UnsupportedMetrics => "glyphAtlasUnsupportedMetrics",
            Self::UnsupportedDirection => "glyphAtlasUnsupportedDirection",
            Self::UnsupportedAtlasSize => "glyphAtlasUnsupportedAtlasSize",
            Self::UnsupportedPadding => "glyphAtlasUnsupportedPadding",
            Self::UnsupportedRowStride => "glyphAtlasUnsupportedRowStride",
            Self::UnsupportedGlyphCount => "glyphAtlasUnsupportedGlyphCount",
            Self::UnsupportedCluster => "glyphAtlasUnsupportedCluster",
            Self::UnorderedGlyphs => "glyphAtlasUnorderedGlyphs",
            Self::UnsupportedTextLength => "glyphAtlasUnsupportedTextLength",
            Self::GlyphOutsideAtlas => "glyphAtlasCellOutsideAtlas",
            Self::UnsupportedLayout => "glyphAtlasUnsupportedLayout",
            Self::UnsupportedLayoutSize => "glyphAtlasUnsupportedLayoutSize",
            Self::UnsupportedLayoutWidth => "glyphAtlasUnsupportedLayoutWidth",
            Self::UnsupportedLetterSpacing => "glyphAtlasUnsupportedLetterSpacing",
            Self::LayoutCellIndex => "glyphAtlasLayoutCellIndex",
            Self::UnorderedLayoutBaselines => "glyphAtlasUnorderedLayoutBaselines",
            Self::LayoutLineCountMismatch => "glyphAtlasLayoutLineCountMismatch",
            Self::GlyphCountMismatch => "glyphAtlasCellCountMismatch",
            Self::PixelBufferMismatch => "glyphAtlasPixelBufferMismatch",
            Self::DerivedFieldMismatch => "glyphAtlasDerivedFieldMismatch",
            Self::UnsupportedContentHash => "glyphAtlasUnsupportedContentHash",
        }
    }
}

impl core::fmt::Display for GlyphAtlasError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let message = match self {
            Self::UnsupportedVersion => "the glyph atlas version is not supported",
            Self::UnsupportedFace => "the glyph atlas face identity is not supported",
            Self::UnsupportedFontSize => "the glyph atlas font size is not supported",
            Self::UnsupportedProbes => "the glyph atlas face probes are not supported",
            Self::UnsupportedMetrics => "the glyph atlas metrics are not supported",
            Self::UnsupportedDirection => "the glyph atlas base direction is not supported",
            Self::UnsupportedAtlasSize => "the glyph atlas is larger than is supported",
            Self::UnsupportedPadding => "the glyph atlas padding is not supported",
            Self::UnsupportedRowStride => "the glyph atlas row stride is not supported",
            Self::UnsupportedGlyphCount => "the glyph atlas carries more cells than is supported",
            Self::UnsupportedCluster => "a glyph atlas cluster is not supported",
            Self::UnorderedGlyphs => "the glyph atlas cells are not in cluster order",
            Self::UnsupportedTextLength => "the glyph atlas clusters are longer than is supported",
            Self::GlyphOutsideAtlas => "a glyph atlas cell lies outside the atlas",
            Self::UnsupportedLayout => "a glyph atlas layout value is not supported",
            Self::UnsupportedLayoutSize => "the glyph atlas layout is larger than is supported",
            Self::UnsupportedLayoutWidth => "the glyph atlas layout wrap width is not supported",
            Self::UnsupportedLetterSpacing => "the glyph atlas letter spacing is not supported",
            Self::LayoutCellIndex => "a glyph atlas layout line draws a cell that does not exist",
            Self::UnorderedLayoutBaselines => "the glyph atlas layout baselines do not descend",
            Self::LayoutLineCountMismatch => {
                "the glyph atlas layout line count disagrees with its lines"
            }
            Self::GlyphCountMismatch => "the glyph atlas cell count disagrees with its cells",
            Self::PixelBufferMismatch => "the glyph atlas pixel buffer disagrees with its geometry",
            Self::DerivedFieldMismatch => "a derived glyph atlas field disagrees with its source",
            Self::UnsupportedContentHash => "the glyph atlas content hash is not supported",
        };
        formatter.write_str(message)
    }
}

impl core::error::Error for GlyphAtlasError {}
