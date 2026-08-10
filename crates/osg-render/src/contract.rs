use std::collections::HashSet;

use osg_domain::{AssetId, ProjectId};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{RenderError, Result};

const MAX_LYRICS: usize = 100_000;
const MAX_LYRIC_TEXT_BYTES: usize = 16 * 1024;
const MAX_TOTAL_LYRIC_BYTES: usize = 8 * 1024 * 1024;
const MAX_RENDER_DURATION_US: u64 = 24 * 60 * 60 * 1_000_000;
const MAX_RENDER_FRAMES: u64 = 1_000_000;
const MAX_FONT_FAMILY_BYTES: usize = 256;
const MAX_PRESET_BYTES: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub source_asset_id: AssetId,
    pub project_id: ProjectId,
    pub narration_artifact_id: Option<Uuid>,
    pub lyrics: Vec<RenderLyric>,
    pub settings: RenderSettings,
    pub customization: SubtitleCustomization,
    pub crop: CropSettings,
}

impl RenderRequest {
    pub fn validate(
        self,
        source_width: u32,
        source_height: u32,
        source_duration_us: u64,
    ) -> Result<RenderPlan> {
        if source_width == 0
            || source_height == 0
            || source_duration_us == 0
            || source_duration_us > MAX_RENDER_DURATION_US
            || self
                .narration_artifact_id
                .is_some_and(|id| id.get_version_num() != 7)
        {
            return Err(RenderError::InvalidRequest);
        }
        let lyrics = validate_lyrics(self.lyrics, source_duration_us)?;
        self.settings.validate()?;
        self.customization.validate()?;
        self.crop.validate()?;
        let trim_start_us = self.settings.trim_start_us;
        let trim_end_us = self.settings.trim_end_us.unwrap_or(source_duration_us);
        if trim_start_us >= trim_end_us || trim_end_us > source_duration_us {
            return Err(RenderError::InvalidRequest);
        }
        let duration_us = trim_end_us - trim_start_us;
        let fps = self.settings.frame_rate.value();
        let duration_frames = duration_us
            .checked_mul(u64::from(fps))
            .and_then(|value| value.checked_add(999_999))
            .map(|value| value / 1_000_000)
            .filter(|value| *value > 0 && *value <= MAX_RENDER_FRAMES)
            .ok_or(RenderError::InvalidRequest)?;
        let target_height = self.settings.resolution.height();
        let crop_ratio = self.crop.width / self.crop.height;
        let effective_aspect = f64::from(source_width) / f64::from(source_height) * crop_ratio;
        if !effective_aspect.is_finite() || effective_aspect <= 0.0 {
            return Err(RenderError::InvalidRequest);
        }
        let rounded_width = (f64::from(target_height) * effective_aspect).round();
        if !(2.0..=15_360.0).contains(&rounded_width) {
            return Err(RenderError::InvalidRequest);
        }
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_sign_loss,
            reason = "the finite render width is range checked before conversion"
        )]
        let mut target_width = rounded_width as u32;
        if !target_width.is_multiple_of(2) {
            target_width = target_width
                .checked_add(1)
                .ok_or(RenderError::InvalidRequest)?;
        }
        let target_height = if target_height.is_multiple_of(2) {
            target_height
        } else {
            target_height + 1
        };
        Ok(RenderPlan {
            source_asset_id: self.source_asset_id,
            project_id: self.project_id,
            narration_artifact_id: self.narration_artifact_id,
            lyrics,
            settings: self.settings,
            customization: self.customization,
            crop: self.crop,
            source_width,
            source_height,
            source_duration_us,
            trim_start_us,
            trim_end_us,
            duration_frames: u32::try_from(duration_frames)
                .map_err(|_| RenderError::InvalidRequest)?,
            width: target_width,
            height: target_height,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderLyric {
    pub id: String,
    pub start_us: u64,
    pub end_us: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedLyric {
    pub id: String,
    pub start_us: u64,
    pub end_us: u64,
    pub text: String,
}

fn validate_lyrics(
    lyrics: Vec<RenderLyric>,
    source_duration_us: u64,
) -> Result<Vec<ValidatedLyric>> {
    if lyrics.is_empty() || lyrics.len() > MAX_LYRICS {
        return Err(RenderError::InvalidRequest);
    }
    let mut total_bytes = 0_usize;
    let mut ids = HashSet::with_capacity(lyrics.len());
    let mut validated = Vec::with_capacity(lyrics.len());
    for lyric in lyrics {
        if lyric.id.is_empty()
            || lyric.id.len() > 128
            || lyric.id.chars().any(char::is_control)
            || !ids.insert(lyric.id.clone())
            || lyric.start_us >= lyric.end_us
            || lyric.end_us > source_duration_us
            || lyric.text.is_empty()
            || lyric.text.len() > MAX_LYRIC_TEXT_BYTES
            || lyric
                .text
                .chars()
                .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        {
            return Err(RenderError::InvalidRequest);
        }
        total_bytes = total_bytes
            .checked_add(lyric.text.len())
            .filter(|value| *value <= MAX_TOTAL_LYRIC_BYTES)
            .ok_or(RenderError::InvalidRequest)?;
        validated.push(ValidatedLyric {
            id: lyric.id,
            start_us: lyric.start_us,
            end_us: lyric.end_us,
            text: lyric.text,
        });
    }
    Ok(validated)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum RenderResolution {
    #[serde(rename = "360p")]
    P360,
    #[serde(rename = "480p")]
    P480,
    #[serde(rename = "720p")]
    P720,
    #[serde(rename = "1080p")]
    P1080,
    #[serde(rename = "1440p")]
    P1440,
    #[serde(rename = "4K")]
    K4,
    #[serde(rename = "8K")]
    K8,
}

impl RenderResolution {
    const fn height(self) -> u32 {
        match self {
            Self::P360 => 360,
            Self::P480 => 480,
            Self::P720 => 720,
            Self::P1080 => 1_080,
            Self::P1440 => 1_440,
            Self::K4 => 2_160,
            Self::K8 => 4_320,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(try_from = "u16", into = "u16")]
pub struct FrameRate(u16);

impl FrameRate {
    #[must_use]
    pub const fn value(self) -> u16 {
        self.0
    }
}

impl TryFrom<u16> for FrameRate {
    type Error = &'static str;

    fn try_from(value: u16) -> std::result::Result<Self, Self::Error> {
        matches!(value, 24 | 25 | 30 | 50 | 60 | 120)
            .then_some(Self(value))
            .ok_or("unsupported render frame rate")
    }
}

impl From<FrameRate> for u16 {
    fn from(value: FrameRate) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderSettings {
    pub resolution: RenderResolution,
    pub frame_rate: FrameRate,
    pub original_audio_volume: u8,
    pub narration_volume: u8,
    pub trim_start_us: u64,
    pub trim_end_us: Option<u64>,
}

impl RenderSettings {
    fn validate(&self) -> Result<()> {
        if self.original_audio_volume > 100 || self.narration_volume > 100 {
            return Err(RenderError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextTransform {
    None,
    Uppercase,
    Lowercase,
    Capitalize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BorderStyle {
    None,
    Solid,
    Dashed,
    Dotted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GradientType {
    Linear,
    Radial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitlePosition {
    Bottom,
    Top,
    Center,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnimationType {
    Fade,
    SlideUp,
    SlideDown,
    SlideLeft,
    SlideRight,
    Scale,
    Bounce,
    Flip,
    Rotate,
    Typewriter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum AnimationEasing {
    #[serde(rename = "linear")]
    Linear,
    #[serde(rename = "ease")]
    Ease,
    #[serde(rename = "ease-in")]
    EaseIn,
    #[serde(rename = "ease-out")]
    EaseOut,
    #[serde(rename = "ease-in-out")]
    EaseInOut,
    #[serde(rename = "cubic-bezier(0.25, 0.46, 0.45, 0.94)")]
    Smooth,
    #[serde(rename = "cubic-bezier(0.68, -0.55, 0.265, 1.55)")]
    Bounce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LineBreakBehavior {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the exact legacy visual customization DTO contains independent toggles"
)]
pub struct SubtitleCustomization {
    pub font_size: f64,
    pub font_family: String,
    pub font_weight: u16,
    pub text_color: String,
    pub text_align: TextAlign,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub text_transform: TextTransform,
    pub background_color: String,
    pub background_opacity: f64,
    pub border_radius: f64,
    pub border_width: f64,
    pub border_color: String,
    pub border_style: BorderStyle,
    pub text_shadow_enabled: bool,
    pub text_shadow_color: String,
    pub text_shadow_blur: f64,
    pub text_shadow_offset_x: f64,
    pub text_shadow_offset_y: f64,
    pub glow_enabled: bool,
    pub glow_color: String,
    pub glow_intensity: f64,
    pub gradient_enabled: bool,
    pub gradient_type: GradientType,
    pub gradient_direction: String,
    pub gradient_color_start: String,
    pub gradient_color_end: String,
    pub gradient_color_mid: String,
    pub stroke_enabled: bool,
    pub stroke_width: f64,
    pub stroke_color: String,
    pub multi_shadow_enabled: bool,
    pub shadow_layers: u8,
    pub pulse_enabled: bool,
    pub pulse_speed: f64,
    pub shake_enabled: bool,
    pub shake_intensity: f64,
    pub position: SubtitlePosition,
    pub custom_position_x: f64,
    pub custom_position_y: f64,
    pub margin_bottom: f64,
    pub margin_top: f64,
    pub margin_left: f64,
    pub margin_right: f64,
    pub max_width: f64,
    pub fade_in_duration: f64,
    pub fade_out_duration: f64,
    pub animation_type: AnimationType,
    pub animation_easing: AnimationEasing,
    pub word_wrap: bool,
    pub max_lines: u8,
    pub line_break_behavior: LineBreakBehavior,
    pub rtl_support: bool,
    pub preset: String,
}

impl SubtitleCustomization {
    fn validate(&self) -> Result<()> {
        if self.font_family.is_empty()
            || self.font_family.len() > MAX_FONT_FAMILY_BYTES
            || self.font_family.chars().any(char::is_control)
            || !matches!(self.font_weight, 100..=900)
            || !self.font_weight.is_multiple_of(100)
            || !valid_color(&self.text_color)
            || !valid_color(&self.background_color)
            || !valid_color(&self.border_color)
            || !valid_color(&self.text_shadow_color)
            || !valid_color(&self.glow_color)
            || !valid_color(&self.gradient_color_start)
            || !valid_color(&self.gradient_color_end)
            || !valid_color(&self.gradient_color_mid)
            || !valid_color(&self.stroke_color)
            || !valid_gradient_direction(&self.gradient_direction)
            || self.shadow_layers > 16
            || self.max_lines == 0
            || self.max_lines > 32
            || self.preset.is_empty()
            || self.preset.len() > MAX_PRESET_BYTES
            || self.preset.chars().any(char::is_control)
        {
            return Err(RenderError::InvalidRequest);
        }
        let bounded = [
            (self.font_size, 1.0, 1_000.0),
            (self.line_height, 0.1, 10.0),
            (self.letter_spacing, -100.0, 1_000.0),
            (self.background_opacity, 0.0, 100.0),
            (self.border_radius, 0.0, 1_000.0),
            (self.border_width, 0.0, 100.0),
            (self.text_shadow_blur, 0.0, 1_000.0),
            (self.text_shadow_offset_x, -2_000.0, 2_000.0),
            (self.text_shadow_offset_y, -2_000.0, 2_000.0),
            (self.glow_intensity, 0.0, 1_000.0),
            (self.stroke_width, 0.0, 100.0),
            (self.pulse_speed, 0.0, 100.0),
            (self.shake_intensity, 0.0, 1_000.0),
            (self.custom_position_x, -1_000.0, 1_000.0),
            (self.custom_position_y, -1_000.0, 1_000.0),
            (self.margin_bottom, -10_000.0, 10_000.0),
            (self.margin_top, -10_000.0, 10_000.0),
            (self.margin_left, -10_000.0, 10_000.0),
            (self.margin_right, -10_000.0, 10_000.0),
            (self.max_width, 1.0, 1_000.0),
            (self.fade_in_duration, 0.0, 60.0),
            (self.fade_out_duration, 0.0, 60.0),
        ];
        if bounded.into_iter().any(|(value, minimum, maximum)| {
            !value.is_finite() || !(minimum..=maximum).contains(&value)
        }) {
            return Err(RenderError::InvalidRequest);
        }
        Ok(())
    }
}

fn valid_color(value: &str) -> bool {
    matches!(value.len(), 4 | 5 | 7 | 9)
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_gradient_direction(value: &str) -> bool {
    let Some(degrees) = value.strip_suffix("deg") else {
        return false;
    };
    degrees.parse::<u16>().is_ok_and(|degrees| degrees <= 360)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CanvasBackgroundMode {
    Solid,
    Blur,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CropSettings {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub aspect_ratio: Option<f64>,
    #[serde(default)]
    pub canvas_bg_mode: Option<CanvasBackgroundMode>,
    #[serde(default)]
    pub canvas_bg_color: Option<String>,
    #[serde(default)]
    pub canvas_bg_blur: Option<f64>,
    #[serde(default)]
    pub flip_x: bool,
    #[serde(default)]
    pub flip_y: bool,
}

impl CropSettings {
    fn validate(&self) -> Result<()> {
        let values = [self.x, self.y, self.width, self.height];
        if values.into_iter().any(|value| !value.is_finite())
            || !(-1_000.0..=1_000.0).contains(&self.x)
            || !(-1_000.0..=1_000.0).contains(&self.y)
            || !(0.01..=1_000.0).contains(&self.width)
            || !(0.01..=1_000.0).contains(&self.height)
            || self
                .aspect_ratio
                .is_some_and(|value| !value.is_finite() || !(0.01..=100.0).contains(&value))
            || self
                .canvas_bg_color
                .as_deref()
                .is_some_and(|value| !valid_color(value))
            || self
                .canvas_bg_blur
                .is_some_and(|value| !value.is_finite() || !(0.0..=1_000.0).contains(&value))
        {
            return Err(RenderError::InvalidRequest);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct RenderPlan {
    pub source_asset_id: AssetId,
    pub project_id: ProjectId,
    pub narration_artifact_id: Option<Uuid>,
    pub lyrics: Vec<ValidatedLyric>,
    pub settings: RenderSettings,
    pub customization: SubtitleCustomization,
    pub crop: CropSettings,
    pub source_width: u32,
    pub source_height: u32,
    pub source_duration_us: u64,
    pub trim_start_us: u64,
    pub trim_end_us: u64,
    pub duration_frames: u32,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request_json() -> serde_json::Value {
        json!({
            "sourceAssetId": AssetId::new(),
            "projectId": ProjectId::new(),
            "narrationArtifactId": null,
            "lyrics": [{"id":"cue-1","startUs":0,"endUs":2_000_000,"text":"Hello"}],
            "settings": {
                "resolution":"720p","frameRate":30,"originalAudioVolume":100,
                "narrationVolume":80,"trimStartUs":0,"trimEndUs":2_000_000
            },
            "customization": {
                "fontSize":28,"fontFamily":"'Inter', sans-serif","fontWeight":600,
                "textColor":"#ffffff","textAlign":"center","lineHeight":1.2,
                "letterSpacing":0,"textTransform":"none","backgroundColor":"#000000",
                "backgroundOpacity":50,"borderRadius":4,"borderWidth":0,
                "borderColor":"#ffffff","borderStyle":"none","textShadowEnabled":true,
                "textShadowColor":"#000000","textShadowBlur":4,"textShadowOffsetX":0,
                "textShadowOffsetY":2,"glowEnabled":false,"glowColor":"#ffffff",
                "glowIntensity":10,"gradientEnabled":false,"gradientType":"linear",
                "gradientDirection":"45deg","gradientColorStart":"#ffffff",
                "gradientColorEnd":"#cccccc","gradientColorMid":"#eeeeee",
                "strokeEnabled":false,"strokeWidth":0,"strokeColor":"#000000",
                "multiShadowEnabled":false,"shadowLayers":1,"pulseEnabled":false,
                "pulseSpeed":1,"shakeEnabled":false,"shakeIntensity":2,"position":"bottom",
                "customPositionX":50,"customPositionY":80,"marginBottom":80,"marginTop":80,
                "marginLeft":0,"marginRight":0,"maxWidth":80,"fadeInDuration":0.3,
                "fadeOutDuration":0.3,"animationType":"fade","animationEasing":"ease",
                "wordWrap":true,"maxLines":3,"lineBreakBehavior":"auto",
                "rtlSupport":false,"preset":"default"
            },
            "crop": {"x":0,"y":0,"width":100,"height":100,"aspectRatio":null}
        })
    }

    #[test]
    fn request_is_exact_path_free_and_dimension_math_is_stable() {
        let request: RenderRequest = serde_json::from_value(request_json()).expect("request");
        let plan = request.validate(1_920, 1_080, 5_000_000).expect("plan");
        assert_eq!(
            (plan.width, plan.height, plan.duration_frames),
            (1_280, 720, 60)
        );

        let mut unknown = request_json();
        unknown["sourcePath"] = json!("C:\\private\\clip.mp4");
        assert!(serde_json::from_value::<RenderRequest>(unknown).is_err());
    }

    #[test]
    fn crop_changes_output_aspect_without_pre_cropping_visuals() {
        let mut value = request_json();
        value["crop"]["width"] = json!(50);
        let request: RenderRequest = serde_json::from_value(value).expect("request");
        let plan = request.validate(1_920, 1_080, 5_000_000).expect("plan");
        assert_eq!((plan.width, plan.height), (640, 720));
        assert!((plan.crop.width - 50.0).abs() < f64::EPSILON);
    }

    #[test]
    fn invalid_timing_fonts_colors_and_non_finite_values_fail_closed() {
        let mut duplicate = request_json();
        duplicate["lyrics"] = json!([
            {"id":"same","startUs":0,"endUs":1,"text":"A"},
            {"id":"same","startUs":1,"endUs":2,"text":"B"}
        ]);
        let request: RenderRequest = serde_json::from_value(duplicate).expect("shape");
        assert!(request.validate(100, 100, 10).is_err());

        let mut bad_color = request_json();
        bad_color["customization"]["textColor"] = json!("url(secret)");
        let request: RenderRequest = serde_json::from_value(bad_color).expect("shape");
        assert!(request.validate(100, 100, 5_000_000).is_err());

        let mut bad_fps = request_json();
        bad_fps["settings"]["frameRate"] = json!(29);
        assert!(serde_json::from_value::<RenderRequest>(bad_fps).is_err());
    }
}
