//! The scene envelope: what the editor hands the renderer for one frame or one export.
//!
//! Two things the replaced contract did not have, and their absence caused real problems:
//!
//! * **A version.** The old customization DTO had none, so a field's meaning could change with no
//!   way for either side to notice. Every scene here declares its schema version and a mismatched
//!   one is refused rather than guessed at.
//! * **A resolved font face.** The old contract carried a CSS family string and hoped the renderer
//!   found something similar, which is why most families silently fell back to a substitute. A
//!   scene carries the exact face identity that was resolved, so preview and export cannot use
//!   different bytes.
//!
//! Every bound is checked on construction, so a scene that exists is a scene that can be rendered.
//! Validation is deliberately strict and total: nothing is clamped silently, because a clamp here
//! is a picture that disagrees with the editor.

use serde::{Deserialize, Serialize};

use crate::timeline::{ExactTime, FrameTimeline, TimelineError};

/// The only schema version this build understands.
pub const SCENE_SCHEMA_VERSION: u32 = 1;

/// The largest composition edge, in pixels. Comfortably past 4K in either orientation.
pub const MAX_DIMENSION: u32 = 7_680;
/// The smallest composition edge, in pixels.
pub const MIN_DIMENSION: u32 = 16;
/// The most cues one scene may carry.
pub const MAX_CUES: usize = 100_000;
/// The most bytes one cue's text may carry.
pub const MAX_CUE_TEXT_BYTES: usize = 4_096;
/// The most bytes a face identity string may carry.
pub const MAX_FACE_BYTES: usize = 256;

/// Why a scene was refused. Deliberately coarse: it names the field, never the value, so an error
/// can be logged without leaking a user's subtitle text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SceneError {
    /// The scene declared a schema version this build does not implement.
    UnsupportedSchemaVersion,
    /// The composition size is outside the supported range or not even.
    UnsupportedDimensions,
    /// The timeline is unsupported; see [`TimelineError`].
    UnsupportedTimeline(TimelineError),
    /// There are too many cues, or a cue's text is too long or empty.
    UnsupportedCues,
    /// A cue's end is not after its start, or a cue starts before the one before it.
    UnorderedCues,
    /// The resolved face identity is missing, too long, or carries control characters.
    UnsupportedFace,
}

impl core::fmt::Display for SceneError {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let message = match self {
            Self::UnsupportedSchemaVersion => "the scene schema version is not supported",
            Self::UnsupportedDimensions => "the composition size is not supported",
            Self::UnsupportedTimeline(_) => "the scene timeline is not supported",
            Self::UnsupportedCues => "the scene cue list is not supported",
            Self::UnorderedCues => "the scene cues are not in order",
            Self::UnsupportedFace => "the resolved font face is not supported",
        };
        formatter.write_str(message)
    }
}

impl core::error::Error for SceneError {}

impl From<TimelineError> for SceneError {
    fn from(error: TimelineError) -> Self {
        Self::UnsupportedTimeline(error)
    }
}

/// The exact face a scene was resolved against.
///
/// `source` identifies the bytes — a content hash for managed fonts, or an explicit system-face
/// declaration. It exists so that a preview and an export can be proven to have used the same
/// glyphs rather than merely the same family name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedFace {
    /// The family the user chose, as recorded in the project.
    pub family: String,
    /// The exact byte source: a content hash, or a declared system face.
    pub source: String,
    /// The weight actually resolved, which may differ from the requested one.
    pub weight: u16,
}

impl ResolvedFace {
    fn validate(&self) -> Result<(), SceneError> {
        for value in [&self.family, &self.source] {
            if value.is_empty()
                || value.len() > MAX_FACE_BYTES
                || value.chars().any(char::is_control)
            {
                return Err(SceneError::UnsupportedFace);
            }
        }
        if !matches!(self.weight, 100..=900) || !self.weight.is_multiple_of(100) {
            return Err(SceneError::UnsupportedFace);
        }
        Ok(())
    }
}

/// One cue's text and the window it occupies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SceneCue {
    /// The cue's text, exactly as it will be rendered.
    pub text: String,
    /// When the cue's own text begins.
    pub start: ExactTime,
    /// When the cue's own text ends.
    pub end: ExactTime,
}

/// A validated scene. Construction is the only way to get one, so holding one means it is usable.
#[derive(Debug, Clone, PartialEq)]
pub struct Scene {
    width: u32,
    height: u32,
    timeline: FrameTimeline,
    face: ResolvedFace,
    cues: Vec<SceneCue>,
}

impl Scene {
    /// Validate and build a scene.
    ///
    /// # Errors
    /// Returns [`SceneError`] when any bound, ordering or identity requirement is not met. Nothing
    /// is clamped or repaired: a scene the editor could not have meant is refused.
    pub fn new(
        schema_version: u32,
        width: u32,
        height: u32,
        timeline: FrameTimeline,
        face: ResolvedFace,
        cues: Vec<SceneCue>,
    ) -> Result<Self, SceneError> {
        if schema_version != SCENE_SCHEMA_VERSION {
            return Err(SceneError::UnsupportedSchemaVersion);
        }
        // Odd dimensions are refused because the encoders this feeds require even ones, and
        // discovering that at the encode stage would waste an entire render.
        if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&width)
            || !(MIN_DIMENSION..=MAX_DIMENSION).contains(&height)
            || !width.is_multiple_of(2)
            || !height.is_multiple_of(2)
        {
            return Err(SceneError::UnsupportedDimensions);
        }
        face.validate()?;
        if cues.len() > MAX_CUES {
            return Err(SceneError::UnsupportedCues);
        }

        let mut previous_start: Option<ExactTime> = None;
        for cue in &cues {
            if cue.text.is_empty() || cue.text.len() > MAX_CUE_TEXT_BYTES {
                return Err(SceneError::UnsupportedCues);
            }
            if cue.end.cmp_exact(cue.start) != core::cmp::Ordering::Greater {
                return Err(SceneError::UnorderedCues);
            }
            if let Some(previous) = previous_start
                && cue.start.cmp_exact(previous) == core::cmp::Ordering::Less
            {
                // Selection takes the first match, so an out-of-order list would silently hide
                // cues. Refusing here turns that into an error the caller can see.
                return Err(SceneError::UnorderedCues);
            }
            previous_start = Some(cue.start);
        }

        Ok(Self {
            width,
            height,
            timeline,
            face,
            cues,
        })
    }

    /// The composition width in pixels.
    #[must_use]
    pub const fn width(&self) -> u32 {
        self.width
    }

    /// The composition height in pixels.
    #[must_use]
    pub const fn height(&self) -> u32 {
        self.height
    }

    /// The frame grid both surfaces sample.
    #[must_use]
    pub const fn timeline(&self) -> FrameTimeline {
        self.timeline
    }

    /// The exact face the scene was resolved against.
    #[must_use]
    pub const fn face(&self) -> &ResolvedFace {
        &self.face
    }

    /// The cues, in start order.
    #[must_use]
    pub fn cues(&self) -> &[SceneCue] {
        &self.cues
    }
}
