//! Cue selection pins the no-blink contract shared by preview and export.

use osg_scene::cues::{CuePhase, CueTiming, active_cue_at};
use osg_scene::timeline::ExactTime;

fn at(seconds: i64, denominator: i64) -> ExactTime {
    ExactTime::new(seconds, denominator).expect("instant")
}

fn cue(start: i64, end: i64) -> CueTiming {
    CueTiming {
        start: at(start, 1),
        end: at(end, 1),
    }
}

#[test]
fn a_cue_holds_at_full_progress_between_its_own_start_and_end() {
    let cues = [cue(2, 4)];
    let active = active_cue_at(&cues, at(3, 1), 0.5, 0.5).expect("active");
    assert_eq!(active.index, 0);
    assert_eq!(active.phase, CuePhase::Holding);
    assert_eq!(active.progress.to_bits(), 1.0_f64.to_bits());
}

#[test]
fn the_fade_window_makes_a_cue_visible_before_its_own_start() {
    // Pinned deliberately: the shipped renderer shows a cue during its fade-in, which begins
    // before the cue's start time.
    let cues = [cue(2, 4)];
    let active = active_cue_at(&cues, at(3, 2), 1.0, 1.0).expect("active at 1.5s");
    assert_eq!(active.phase, CuePhase::FadingIn);
    assert_eq!(active.progress.to_bits(), 0.5_f64.to_bits());

    assert!(
        active_cue_at(&cues, at(1, 2), 1.0, 1.0).is_none(),
        "0.5s is outside the window"
    );
}

#[test]
fn the_fade_window_keeps_a_cue_visible_after_its_own_end() {
    let cues = [cue(2, 4)];
    let active = active_cue_at(&cues, at(9, 2), 1.0, 1.0).expect("active at 4.5s");
    assert_eq!(active.phase, CuePhase::FadingOut);
    assert_eq!(active.progress.to_bits(), 0.5_f64.to_bits());

    assert!(
        active_cue_at(&cues, at(6, 1), 1.0, 1.0).is_none(),
        "6s is past the window"
    );
}

#[test]
fn authored_overlap_remains_deterministic() {
    let cues = [cue(0, 10), cue(2, 4)];
    let active = active_cue_at(&cues, at(3, 1), 0.0, 0.0).expect("active");
    assert_eq!(active.index, 0, "the later overlapping cue must not win");
}

#[test]
fn an_authored_cue_outranks_an_earlier_cues_fade_window() {
    let cues = [cue(0, 1), cue(2, 3)];
    assert_eq!(
        active_cue_at(&cues, at(5, 2), 0.0, 2.0)
            .expect("active")
            .index,
        1,
        "cue 1 is live and must not be swallowed by cue 0's fade-out"
    );
    assert_eq!(
        active_cue_at(&cues, at(5, 2), 0.0, 0.0)
            .expect("active")
            .index,
        1,
        "without the wide window cue 1 renders normally"
    );
}

#[test]
fn overlapping_fades_choose_the_more_opaque_cue_without_a_blank_frame() {
    let cues = [cue(0, 1), cue(2, 3)];
    let early = active_cue_at(&cues, at(5, 4), 1.0, 1.0).expect("early gap fade");
    assert_eq!(early.index, 0);
    assert_eq!(early.phase, CuePhase::FadingOut);
    assert_eq!(early.progress.to_bits(), 0.75_f64.to_bits());

    let late = active_cue_at(&cues, at(7, 4), 1.0, 1.0).expect("late gap fade");
    assert_eq!(late.index, 1);
    assert_eq!(late.phase, CuePhase::FadingIn);
    assert_eq!(late.progress.to_bits(), 0.75_f64.to_bits());
}

#[test]
fn a_zero_fade_window_holds_at_full_progress_at_both_edges() {
    let cues = [cue(2, 4)];
    for instant in [at(2, 1), at(3, 1), at(4, 1)] {
        let active = active_cue_at(&cues, instant, 0.0, 0.0).expect("active");
        assert_eq!(active.phase, CuePhase::Holding);
        assert_eq!(active.progress.to_bits(), 1.0_f64.to_bits());
    }
    assert!(active_cue_at(&cues, at(19, 10), 0.0, 0.0).is_none());
    assert!(active_cue_at(&cues, at(41, 10), 0.0, 0.0).is_none());
}

#[test]
fn a_hostile_fade_duration_cannot_widen_the_window() {
    let cues = [cue(2, 4)];
    for fade in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -5.0] {
        assert!(
            active_cue_at(&cues, at(0, 1), fade, fade).is_none(),
            "fade {fade} must not make a cue visible at 0s"
        );
        let active = active_cue_at(&cues, at(3, 1), fade, fade).expect("still holds inside");
        assert_eq!(active.phase, CuePhase::Holding);
    }
}

#[test]
fn progress_is_always_clamped_into_the_unit_range() {
    let cues = [cue(2, 4)];
    for instant in [at(2, 1), at(3, 1), at(4, 1), at(9, 2), at(3, 2)] {
        for fade in [0.0, 0.25, 1.0, 4.0] {
            if let Some(active) = active_cue_at(&cues, instant, fade, fade) {
                assert!(
                    (0.0..=1.0).contains(&active.progress),
                    "progress {} escaped the unit range",
                    active.progress
                );
            }
        }
    }
}

#[test]
fn an_empty_cue_list_selects_nothing() {
    assert!(active_cue_at(&[], at(1, 1), 1.0, 1.0).is_none());
}

#[test]
fn selection_is_repeatable_for_the_same_instant() {
    let cues = [cue(0, 1), cue(2, 3), cue(4, 5)];
    for index in 0..200_i64 {
        let instant = at(index, 20);
        let first = active_cue_at(&cues, instant, 0.3, 0.3);
        let again = active_cue_at(&cues, instant, 0.3, 0.3);
        assert_eq!(first, again, "selection must not depend on call order");
    }
}
