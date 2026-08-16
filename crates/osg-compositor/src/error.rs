//! Typed, path-safe failures for the headless compositor.

use core::fmt;

/// Which side of a frame a dimension bound rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    /// The horizontal axis.
    Width,
    /// The vertical axis.
    Height,
}

impl fmt::Display for Axis {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Width => "width",
            Self::Height => "height",
        };
        f.write_str(name)
    }
}

/// Which 2D texture a device's own dimension limit refused.
///
/// The three are named separately because the remedy differs: a composition that is too large is a
/// resolution the user chose, a source frame that is too large is the media they opened, and an
/// atlas that is too large is a font size the baker was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TextureTarget {
    /// The composition target, and every intermediate allocated at the composition size: the
    /// decoration masks and both passes of the separable blur.
    Frame,
    /// The decoded video frame uploaded under the subtitle layer.
    Source,
    /// The baked glyph atlas.
    Atlas,
}

impl fmt::Display for TextureTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let name = match self {
            Self::Frame => "composition",
            Self::Source => "video source frame",
            Self::Atlas => "glyph atlas",
        };
        f.write_str(name)
    }
}

/// Why a staged atlas, style, run or scene was refused.
///
/// Deliberately coarse and `Copy`: it names the field that failed and never the value, so a refusal
/// can be logged without leaking a user's subtitle text, font choice or colours.
///
/// The atlas descriptor's own bounds — version, geometry, cell rectangles, pixel buffer — are
/// checked by [`osg_scene::glyph::GlyphAtlasDescriptor`] before one can exist, so they are not
/// repeated here. What remains is what only the compositor can decide: whether the atlas belongs to
/// this scene, whether its metrics can lay a line out, and whether the staged runs fit it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The atlas was baked from a different face than the scene resolved.
    AtlasFaceMismatch,
    /// The atlas metrics cannot place a line: the line box or the bake size is not positive.
    AtlasMetrics,
    /// The descriptor refuses layout from per-cell advances, so this compositor cannot draw it.
    ///
    /// Either shaping crossed cluster boundaries, or the run is right-to-left and the cells are in
    /// logical rather than visual order. Both would draw the wrong picture rather than fail.
    AtlasLayoutRefused,
    /// The font size is not a finite in-range number.
    StyleFontSize,
    /// The line spacing multiplier is not a finite in-range number.
    StyleLineSpacing,
    /// The text colour could not be resolved.
    StyleColor,
    /// The background colour or its opacity could not be resolved.
    StyleBackground,
    /// A padding, radius, margin or custom placement value is out of range.
    StyleGeometry,
    /// A fade duration is not a finite in-range number.
    StyleTiming,
    /// The cue opacity is outside `0.0..=1.0`.
    StyleOpacity,
    /// The subtitle position is not one the renderer implements.
    StylePosition,
    /// The text alignment is not one the renderer implements.
    StyleAlign,
    /// The animation is not one the renderer implements.
    StyleAnimation,
    /// The easing is not one of the reviewed curves.
    StyleEasing,
    /// The stroke width is out of range, or its colour could not be resolved.
    DecorationStroke,
    /// A text-shadow offset or blur is out of range, or its colour could not be resolved.
    DecorationShadow,
    /// The glow intensity is out of range, or its colour could not be resolved.
    DecorationGlow,
    /// The border width is out of range, or its colour could not be resolved.
    DecorationBorder,
    /// The border style is not one of `none`, `solid`, `dashed`, `dotted` or `double`.
    DecorationBorderStyle,
    /// A gradient stop could not be resolved, or the direction is not `<0..=360>deg`.
    DecorationGradient,
    /// The scene and the staged runs disagree on how many cues there are.
    RunCount,
    /// A run has no lines, no glyphs at all, or more than the renderer accepts.
    RunLength,
    /// A run refers to a glyph cell the atlas does not contain.
    RunGlyphIndex,
    /// A run line carries a position that cannot place a glyph: a pen count that does not match the
    /// cells it draws, a value that is not finite, or a baseline that does not descend.
    RunGeometry,
    /// A crop offset or extent is not a finite value inside the stored range.
    CropRegion,
    /// The canvas background mode is neither `solid` nor `blur`.
    CropCanvasMode,
    /// The canvas background colour is not a supported hex colour.
    CropCanvasColor,
    /// The canvas background blur is not a finite value inside the stored range.
    CropCanvasBlur,
    /// A decoded source frame does not carry exactly `width * height * 4` bytes.
    SourcePixelCount,
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::AtlasFaceMismatch => {
                "the glyph atlas was not baked from the scene's resolved face"
            }
            Self::AtlasMetrics => "the glyph atlas metrics cannot place a line",
            Self::AtlasLayoutRefused => {
                "the glyph atlas refuses layout from per-cell advances alone"
            }
            Self::StyleFontSize => "the font size is not supported",
            Self::StyleLineSpacing => "the line spacing is not supported",
            Self::StyleColor => "the text colour could not be resolved",
            Self::StyleBackground => "the background colour could not be resolved",
            Self::StyleGeometry => "a padding, radius, margin or placement value is not supported",
            Self::StyleTiming => "a fade duration is not supported",
            Self::StyleOpacity => "the cue opacity is outside 0.0..=1.0",
            Self::StylePosition => "the subtitle position is not supported",
            Self::StyleAlign => "the text alignment is not supported",
            Self::StyleAnimation => "the animation is not supported",
            Self::StyleEasing => "the easing is not one of the reviewed curves",
            Self::DecorationStroke => "the glyph stroke is not supported",
            Self::DecorationShadow => "the text shadow is not supported",
            Self::DecorationGlow => "the glow is not supported",
            Self::DecorationBorder => "the border is not supported",
            Self::DecorationBorderStyle => "the border style is not supported",
            Self::DecorationGradient => "the gradient fill is not supported",
            Self::RunCount => "the scene and its staged runs disagree on the cue count",
            Self::RunLength => "a staged run is empty or longer than the renderer accepts",
            Self::RunGlyphIndex => "a staged run refers to a glyph cell the atlas does not contain",
            Self::RunGeometry => "a staged run line cannot place its glyphs",
            Self::CropRegion => "the crop region is not supported",
            Self::CropCanvasMode => "the canvas background mode is not supported",
            Self::CropCanvasColor => "the canvas background colour could not be resolved",
            Self::CropCanvasBlur => "the canvas background blur is not supported",
            Self::SourcePixelCount => {
                "the source frame does not carry exactly one RGBA8 pixel per position"
            }
        };
        f.write_str(message)
    }
}

/// Everything the compositor can refuse to do.
///
/// Every variant fails closed: the compositor never substitutes a degraded result for a failure,
/// and it never panics on a missing adapter, an out-of-range request or a lost device. Messages
/// carry only bounded numbers and adapter-reported text, never filesystem paths or credentials.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CompositorError {
    /// No GPU adapter — hardware or software — could be acquired.
    #[error("no GPU adapter is available for headless composition: {reason}")]
    NoAdapter {
        /// The adapter-request failure reported by the graphics backend.
        reason: String,
    },

    /// An adapter existed but would not yield a device and queue.
    #[error("the GPU adapter refused to create a device: {reason}")]
    DeviceUnavailable {
        /// The device-request failure reported by the graphics backend.
        reason: String,
    },

    /// A requested frame dimension fell outside the accepted range.
    #[error("frame {axis} must be {min}..={max} pixels, got {value}")]
    DimensionOutOfRange {
        /// The axis that was rejected.
        axis: Axis,
        /// The rejected value.
        value: u32,
        /// The smallest accepted value.
        min: u32,
        /// The largest accepted value.
        max: u32,
    },

    /// Both dimensions were individually acceptable but their product was not.
    #[error("frame area must be at most {max} pixels, got {value} ({width}x{height})")]
    AreaOutOfRange {
        /// The requested width.
        width: u32,
        /// The requested height.
        height: u32,
        /// The requested pixel count.
        value: u64,
        /// The largest accepted pixel count.
        max: u64,
    },

    /// The acquired device cannot allocate a texture this composition needs.
    ///
    /// Separate from [`CompositorError::DimensionOutOfRange`] because it is a property of the
    /// machine rather than of the request: the same project renders on an adapter with a larger
    /// `max_texture_dimension_2d`. It is raised before a single texture exists, because `wgpu`
    /// validates that dimension inside `Device::create_texture` by panicking — and the release
    /// profile aborts, which would take the whole process down mid-export.
    #[error(
        "this GPU allocates at most {max} pixels per texture edge; the {target} needs {value} on its {axis}"
    )]
    DeviceTextureLimit {
        /// Which texture was refused.
        target: TextureTarget,
        /// The axis that exceeded the device limit.
        axis: Axis,
        /// The rejected value.
        value: u32,
        /// The device's granted `max_texture_dimension_2d`.
        max: u32,
    },

    /// A scene parameter was not a finite value inside its documented range.
    #[error("scene phase must be a finite value in 0.0..=1.0, got {value}")]
    PhaseOutOfRange {
        /// The rejected value.
        value: f32,
    },

    /// A staged atlas, style, run or scene could not be drawn as given.
    #[error("the subtitle scene was refused: {reason}")]
    UnsupportedSceneInput {
        /// Which part of the input was refused.
        reason: Rejection,
    },

    /// A frame index was requested that the scene's timeline does not contain.
    #[error("frame {index} is outside the scene timeline of {frame_count} frames")]
    FrameOutOfRange {
        /// The requested frame index.
        index: u32,
        /// How many frames the timeline actually has.
        frame_count: u32,
    },

    /// The composed frame could not be copied back to host memory.
    #[error("the composed frame could not be read back from the GPU: {reason}")]
    ReadbackFailed {
        /// The mapping or polling failure reported by the graphics backend.
        reason: String,
    },
}

impl From<Rejection> for CompositorError {
    fn from(reason: Rejection) -> Self {
        Self::UnsupportedSceneInput { reason }
    }
}
