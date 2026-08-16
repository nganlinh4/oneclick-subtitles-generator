//! The `RenderRequest`-to-pipeline conversion: the one place every parity decision is applied.
//!
//! `docs/rewrite/NATIVE_RENDERER.md` settles that the native pipeline *converts* a validated
//! `RenderRequest` into a scene plus the style, crop and audio inputs, and that the conversion is
//! the single place every decision in `src/platform/renderParityLedger.js` lands. That is what this
//! directory is. Splitting it by concern keeps each decision next to the fields it governs while
//! keeping the whole conversion in one place to review:
//!
//! | Module | What it owns |
//! | --- | --- |
//! | [`font`] | Which family a persisted `font-family` value asks for, and the refusal when the staged face is not it. |
//! | [`timeline`] | The `trimStart` rebase and the `DURATION_SOURCE` decision. |
//! | [`dimensions`] | The output frame size, and why `crop.aspectRatio` is not read. |
//! | [`style`] | Every subtitle-customization enum and number, mapped exhaustively. |
//! | [`crop`] | The crop, the flips, and the opaque canvas backfill. |
//! | [`audio`] | The two volumes and the trim window both sources are read through. |
//! | [`plan`] | The assembly, the encoder configuration and the bitrate rule. |

mod audio;
mod crop;
mod dimensions;
mod font;
mod plan;
mod style;
mod timeline;

pub(crate) use crop::check_canvas_background;

pub use audio::{AUDIO_BITRATE_KBPS, AUDIO_CHANNELS, AUDIO_SAMPLE_RATE_HZ, AudioPlan};
pub use crop::EXPORT_CANVAS_GROUND;
pub use font::primary_font_family;
pub use plan::ExportPlan;
pub use style::{BACKGROUND_PADDING_X, BACKGROUND_PADDING_Y};
