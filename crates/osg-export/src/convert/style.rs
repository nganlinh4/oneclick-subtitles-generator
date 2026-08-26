//! The subtitle style, from the persisted customization vocabulary to the compositor's.
//!
//! Every enum the request can carry is mapped here, exhaustively, so adding a variant to the
//! contract is a compile error rather than a silently unhandled case. Nothing is derived: the
//! compositor resolves colours, positions, alignments, animations and easings through `osg-scene`,
//! and this module only renames.
//!
//! Two mappings are worth stating out loud because they look like mistakes and are not:
//!
//! * The contract's `fade` animation becomes `osg-scene`'s `none`. `fade` is the absence of a
//!   transform, not a transform: the fade itself is the opacity curve the cue always carries.
//! * Background padding is persisted explicitly on both axes. Older scenes receive the reviewed
//!   shipped defaults at the render-contract boundary; this conversion never substitutes them.

use osg_compositor::{SubtitleDecorationSpec, SubtitleStyle, SubtitleStyleSpec};
use osg_render::{
    AnimationEasing, AnimationType, BorderStyle, SubtitleCustomization, SubtitlePosition, TextAlign,
};
use osg_scene::layout::Margins;

use crate::error::ExportError;

/// The flat cue opacity. The persisted vocabulary has no such control, so it is fully opaque and
/// the fade curve is the only thing that changes a cue's alpha.
const CUE_OPACITY: f64 = 1.0;

/// The staged style a customization describes, before the compositor resolves it.
pub(crate) fn style_spec(customization: &SubtitleCustomization) -> SubtitleStyleSpec {
    SubtitleStyleSpec {
        font_size: customization.font_size,
        line_spacing: customization.line_height,
        text_color: customization.text_color.clone(),
        gradient_enabled: customization.gradient_enabled,
        background_color: customization.background_color.clone(),
        background_opacity: customization.background_opacity,
        background_padding_x: customization.background_padding_x,
        background_padding_y: customization.background_padding_y,
        border_radius: customization.border_radius,
        position: position_name(customization.position).to_owned(),
        margins: Margins {
            bottom: customization.margin_bottom,
            top: customization.margin_top,
            left: customization.margin_left,
            right: customization.margin_right,
        },
        custom_x: customization.custom_position_x,
        custom_y: customization.custom_position_y,
        text_align: align_name(customization.text_align).to_owned(),
        animation: animation_name(customization.animation_type).to_owned(),
        easing: easing_name(customization.animation_easing).to_owned(),
        fade_in: customization.fade_in_duration,
        fade_out: customization.fade_out_duration,
        opacity: CUE_OPACITY,
        decoration: decoration_spec(customization),
    }
}

/// The stroke, shadow, glow, border and gradient stops a customization describes.
///
/// Listed field by field rather than filled in from a default, so a decoration field added to the
/// compositor is a compile error here instead of a persisted setting that silently stops drawing.
/// That is the whole point of the parity ledger: a user who saved a project with `strokeWidth: 4`
/// must not open it after the migration to find the setting still in the file, still in the UI, and
/// no longer on the screen.
pub(crate) fn decoration_spec(customization: &SubtitleCustomization) -> SubtitleDecorationSpec {
    SubtitleDecorationSpec {
        stroke_enabled: customization.stroke_enabled,
        stroke_width: customization.stroke_width,
        stroke_color: customization.stroke_color.clone(),
        text_shadow_enabled: customization.text_shadow_enabled,
        text_shadow_color: customization.text_shadow_color.clone(),
        text_shadow_blur: customization.text_shadow_blur,
        text_shadow_offset_x: customization.text_shadow_offset_x,
        text_shadow_offset_y: customization.text_shadow_offset_y,
        glow_enabled: customization.glow_enabled,
        glow_color: customization.glow_color.clone(),
        glow_intensity: customization.glow_intensity,
        border_width: customization.border_width,
        border_color: customization.border_color.clone(),
        border_style: border_style_name(customization.border_style).to_owned(),
        gradient_color_start: customization.gradient_color_start.clone(),
        gradient_color_end: customization.gradient_color_end.clone(),
        gradient_direction: customization.gradient_direction.clone(),
    }
}

/// The wire name the compositor's decoration resolver accepts.
#[must_use]
pub(crate) const fn border_style_name(style: BorderStyle) -> &'static str {
    match style {
        BorderStyle::None => "none",
        BorderStyle::Solid => "solid",
        BorderStyle::Dashed => "dashed",
        BorderStyle::Dotted => "dotted",
        BorderStyle::Double => "double",
    }
}

/// Resolves a customization into the style the compositor draws with.
pub(crate) fn resolve(customization: &SubtitleCustomization) -> Result<SubtitleStyle, ExportError> {
    Ok(SubtitleStyle::resolve(&style_spec(customization))?)
}

/// The wire name `osg_scene::layout::SubtitlePosition::from_wire` accepts.
#[must_use]
pub(crate) const fn position_name(position: SubtitlePosition) -> &'static str {
    match position {
        SubtitlePosition::Bottom => "bottom",
        SubtitlePosition::Top => "top",
        SubtitlePosition::Center => "center",
        SubtitlePosition::Custom => "custom",
    }
}

/// The wire name `osg_scene::layout::TextAlign::from_wire` accepts.
#[must_use]
pub(crate) const fn align_name(align: TextAlign) -> &'static str {
    match align {
        TextAlign::Left => "left",
        TextAlign::Center => "center",
        TextAlign::Right => "right",
        TextAlign::Justify => "justify",
    }
}

/// The wire name `osg_scene::animation::AnimationType::from_wire` accepts.
#[must_use]
pub(crate) const fn animation_name(animation: AnimationType) -> &'static str {
    match animation {
        // Not an omission: `fade` is the absence of a transform, and the opacity curve that gives
        // it its name is applied to every cue whatever the animation is.
        AnimationType::Fade => "none",
        AnimationType::SlideUp => "slide-up",
        AnimationType::SlideDown => "slide-down",
        AnimationType::SlideLeft => "slide-left",
        AnimationType::SlideRight => "slide-right",
        AnimationType::Scale => "scale",
        AnimationType::Bounce => "bounce",
        AnimationType::Flip => "flip",
        AnimationType::Rotate => "rotate",
        AnimationType::Typewriter => "typewriter",
    }
}

/// The curve name from `osg_scene::easing::SUBTITLE_ANIMATION_EASINGS`.
#[must_use]
pub(crate) const fn easing_name(easing: AnimationEasing) -> &'static str {
    match easing {
        AnimationEasing::Linear => "linear",
        AnimationEasing::Ease => "ease",
        AnimationEasing::EaseIn => "ease-in",
        AnimationEasing::EaseOut => "ease-out",
        AnimationEasing::EaseInOut => "ease-in-out",
        AnimationEasing::Smooth => "cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        AnimationEasing::Bounce => "cubic-bezier(0.68, -0.55, 0.265, 1.55)",
    }
}

#[cfg(test)]
mod tests {
    use osg_render::{AnimationEasing, AnimationType, SubtitlePosition, TextAlign};
    use osg_scene::animation::AnimationType as SceneAnimation;
    use osg_scene::easing::SUBTITLE_ANIMATION_EASINGS;
    use osg_scene::layout::{SubtitlePosition as ScenePosition, TextAlign as SceneAlign};

    use super::{align_name, animation_name, easing_name, position_name};

    /// Every contract variant, so a variant added to the contract fails to compile here.
    const ANIMATIONS: [AnimationType; 10] = [
        AnimationType::Fade,
        AnimationType::SlideUp,
        AnimationType::SlideDown,
        AnimationType::SlideLeft,
        AnimationType::SlideRight,
        AnimationType::Scale,
        AnimationType::Bounce,
        AnimationType::Flip,
        AnimationType::Rotate,
        AnimationType::Typewriter,
    ];

    const EASINGS: [AnimationEasing; 7] = [
        AnimationEasing::Linear,
        AnimationEasing::Ease,
        AnimationEasing::EaseIn,
        AnimationEasing::EaseOut,
        AnimationEasing::EaseInOut,
        AnimationEasing::Smooth,
        AnimationEasing::Bounce,
    ];

    #[test]
    fn every_animation_names_a_curve_the_scene_implements() {
        let mut seen = Vec::new();
        for animation in ANIMATIONS {
            let name = animation_name(animation);
            let resolved = SceneAnimation::from_wire(name)
                .unwrap_or_else(|| panic!("{name} is not a scene animation"));
            assert!(
                !seen.contains(&resolved),
                "{name} duplicates another animation"
            );
            seen.push(resolved);
        }
        assert_eq!(seen.len(), ANIMATIONS.len());
        assert_eq!(animation_name(AnimationType::Fade), "none");
    }

    #[test]
    fn every_easing_names_a_reviewed_curve() {
        let mut seen = Vec::new();
        for easing in EASINGS {
            let name = easing_name(easing);
            assert!(
                SUBTITLE_ANIMATION_EASINGS.contains(&name),
                "{name} is not a reviewed curve"
            );
            assert!(!seen.contains(&name), "{name} duplicates another easing");
            seen.push(name);
        }
        // Every reviewed curve is reachable from the contract, so none of them is dead.
        assert_eq!(seen.len(), SUBTITLE_ANIMATION_EASINGS.len());
    }

    #[test]
    fn every_position_and_alignment_names_a_layout_the_scene_implements() {
        for position in [
            SubtitlePosition::Bottom,
            SubtitlePosition::Top,
            SubtitlePosition::Center,
            SubtitlePosition::Custom,
        ] {
            let name = position_name(position);
            assert!(
                ScenePosition::from_wire(name).is_some(),
                "{name} is not a scene position"
            );
        }
        for align in [
            TextAlign::Left,
            TextAlign::Center,
            TextAlign::Right,
            TextAlign::Justify,
        ] {
            let name = align_name(align);
            assert!(
                SceneAlign::from_wire(name).is_some(),
                "{name} is not a scene alignment"
            );
        }
    }
}
