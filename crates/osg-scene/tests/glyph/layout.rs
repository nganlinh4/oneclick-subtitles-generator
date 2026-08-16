//! The authoritative layout, judged.
//!
//! Everything a consumer places a glyph from is here, so every one of these numbers is checked
//! before a descriptor can exist: a pen for every cell, an index that addresses a cell, baselines
//! that descend by the declared line box, and a verdict that is exactly the disjunction of its own
//! reasons.

use osg_scene::glyph::{
    AtlasLine, CellAdvanceLayout, CellAdvanceVerdict, Direction, GlyphAtlasDescriptor,
    GlyphAtlasError, LayoutRefusal, LayoutTextAlign, MAX_LAYOUT_CELLS, MAX_LAYOUT_COORDINATE_PX,
    MAX_LAYOUT_LINES, MAX_LAYOUT_WIDTH_PX, MAX_LETTER_SPACING_PX, MIN_LETTER_SPACING_PX,
    UncheckedGlyphAtlas,
};

use super::support::{
    ADVANCE_PX, BASELINE_PX, LINE_HEIGHT_PX, accept, empty, layout_of, line, refuse, valid,
};

/// Puts one value into one named layout field, so a bounds table can name what it broke.
type Bend = fn(&mut UncheckedGlyphAtlas, f64);

/// The layout the fixture ships with: two cells on one line, one advance apart.
#[test]
fn the_emitted_positions_are_what_a_consumer_reads() {
    let descriptor = accept(|_| {});
    let layout = descriptor.layout();

    assert_eq!(layout.line_count, 1);
    assert_eq!(layout.lines[0].glyphs, vec![0, 1]);
    assert_eq!(layout.lines[0].pen_x_px, vec![0.0, ADVANCE_PX]);
    assert_eq!(
        layout.lines[0].baseline_y_px.to_bits(),
        BASELINE_PX.to_bits()
    );
    assert_eq!(layout.placed_cells(), 2);
    assert_eq!(layout.text_align, LayoutTextAlign::Left);
    assert!(layout.max_width_px.is_none());
}

/// The one invariant the whole contract rests on: a pen position for every cell drawn. Without it
/// the consumer would have to invent one, which is the accumulation this replaces.
#[test]
fn a_line_must_carry_one_pen_position_per_cell() {
    for pens in [vec![0.0], vec![0.0, ADVANCE_PX, 26.4]] {
        assert_eq!(
            refuse(|atlas| atlas.layout.lines[0].pen_x_px = pens),
            GlyphAtlasError::UnsupportedLayout
        );
    }
}

#[test]
fn a_line_that_draws_a_cell_the_atlas_does_not_have_is_refused() {
    for cells in [vec![0, 2], vec![u32::MAX]] {
        let error = refuse(|atlas| {
            atlas.layout.lines[0].pen_x_px = vec![0.0; cells.len()];
            atlas.layout.lines[0].glyphs = cells;
        });
        assert_eq!(error, GlyphAtlasError::LayoutCellIndex);
    }
}

#[test]
fn a_layout_number_that_cannot_place_a_glyph_is_refused() {
    for pen in [f64::NAN, f64::INFINITY] {
        assert_eq!(
            refuse(|atlas| atlas.layout.lines[0].pen_x_px[1] = pen),
            GlyphAtlasError::UnsupportedLayout,
            "{pen}"
        );
        assert_eq!(
            refuse(|atlas| atlas.layout.lines[0].baseline_y_px = pen),
            GlyphAtlasError::UnsupportedLayout,
            "{pen}"
        );
    }
    // The advance is signed, because tight letter spacing can pull a line narrower than nothing.
    // The measured width and the justification are widths and cannot be negative.
    for broken in [f64::NAN, f64::INFINITY] {
        assert_eq!(
            refuse(|atlas| atlas.layout.lines[0].advance_width_px = broken),
            GlyphAtlasError::UnsupportedLayout,
            "{broken}"
        );
    }
    assert_eq!(
        refuse(|atlas| atlas.layout.lines[0].measured_width_px = -1.0),
        GlyphAtlasError::UnsupportedLayout
    );
    assert_eq!(
        refuse(|atlas| {
            atlas.layout.text_align = LayoutTextAlign::Justify;
            atlas.layout.lines[0].justification_px = -1.0;
        }),
        GlyphAtlasError::UnsupportedLayout
    );
}

/// Bounding these by magnitude is what closes the `NaN` path. Finiteness never did.
///
/// `osg-compositor` scales every one of them before it places anything: it multiplies each line's
/// advance by the glyph scale, takes the widest result as the run's text width, and offsets a
/// centred line by `text_width - line_width`. Hand it the largest finite `f64` and the multiply
/// leaves the finite numbers, that subtraction becomes `inf - inf`, and every vertex on the line
/// comes out `NaN` — from a descriptor whose every number passed `is_finite`.
///
/// The bound is the one `glyphAtlasStaging.js` applies to the very same fields, so a descriptor
/// this side accepts is one the staging side would have accepted too.
#[test]
fn a_finite_layout_coordinate_past_the_bound_is_refused_before_it_can_scale_to_nan() {
    // The bound itself is a layout, on both sides of zero: a pen sits left of its own line start
    // whenever letter spacing tightens, so this is a magnitude and not a range.
    let at_the_bound = accept(|atlas| {
        atlas.layout.lines[0].pen_x_px[1] = -MAX_LAYOUT_COORDINATE_PX;
        atlas.layout.lines[0].advance_width_px = MAX_LAYOUT_COORDINATE_PX;
        atlas.layout.width_px = MAX_LAYOUT_COORDINATE_PX;
    });
    assert_eq!(
        at_the_bound.layout().width_px.to_bits(),
        MAX_LAYOUT_COORDINATE_PX.to_bits()
    );

    // Every number a consumer places a glyph from, fed the largest finite value there is.
    let signed: [(&str, Bend); 4] = [
        ("pen_x_px", |atlas, value| {
            atlas.layout.lines[0].pen_x_px[1] = value;
        }),
        ("advance_width_px", |atlas, value| {
            atlas.layout.lines[0].advance_width_px = value;
        }),
        ("shaping_residual_px", |atlas, value| {
            atlas.layout.lines[0].shaping_residual_px = value;
        }),
        ("baseline_y_px", |atlas, value| {
            atlas.layout.lines[0].baseline_y_px = value;
        }),
    ];
    let unsigned: [(&str, Bend); 4] = [
        ("measured_width_px", |atlas, value| {
            atlas.layout.lines[0].measured_width_px = value;
        }),
        ("justification_px", |atlas, value| {
            atlas.layout.text_align = LayoutTextAlign::Justify;
            atlas.layout.lines[0].justification_px = value;
        }),
        ("width_px", |atlas, value| atlas.layout.width_px = value),
        ("height_px", |atlas, value| atlas.layout.height_px = value),
    ];

    for (field, bend) in signed.into_iter().chain(unsigned) {
        for magnitude in [f64::MAX, MAX_LAYOUT_COORDINATE_PX + 1.0] {
            assert_eq!(
                refuse(|atlas| bend(atlas, magnitude)),
                GlyphAtlasError::UnsupportedLayout,
                "{field} at {magnitude}"
            );
        }
    }
    // The signed fields are refused just as hard going the other way, rather than only by the sign
    // checks the widths already carry.
    for (field, bend) in signed {
        assert_eq!(
            refuse(|atlas| bend(atlas, -f64::MAX)),
            GlyphAtlasError::UnsupportedLayout,
            "{field} at -f64::MAX"
        );
    }
}

#[test]
fn the_declared_line_count_must_match_the_lines() {
    for count in [0, 2, u32::MAX] {
        assert_eq!(
            refuse(|atlas| atlas.layout.line_count = count),
            GlyphAtlasError::LayoutLineCountMismatch,
            "{count}"
        );
    }
}

/// The run box a consumer sizes the background from is derived from the lines, so it has to still
/// follow from them.
#[test]
fn the_run_box_must_follow_from_the_lines() {
    assert_eq!(
        refuse(|atlas| atlas.layout.width_px = ADVANCE_PX),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        refuse(|atlas| atlas.layout.height_px = LINE_HEIGHT_PX * 2.0),
        GlyphAtlasError::DerivedFieldMismatch
    );
    for broken in [f64::NAN, -1.0] {
        assert_eq!(
            refuse(|atlas| atlas.layout.height_px = broken),
            GlyphAtlasError::UnsupportedLayout,
            "{broken}"
        );
    }
}

/// Baselines are the whole of vertical layout: the consumer reads them and adds nothing, so they
/// must descend, and they must descend by the line box the metrics declare rather than by whatever
/// a second line-height owner would have applied.
#[test]
fn baselines_must_descend_by_the_declared_line_box() {
    let two_lines = |second_baseline: f64| {
        move |atlas: &mut UncheckedGlyphAtlas| {
            let mut second = line(1, &[1], &[0.0]);
            second.baseline_y_px = second_baseline;
            atlas.layout = layout_of(vec![line(0, &[0], &[0.0]), second]);
        }
    };
    assert_eq!(
        accept(two_lines(BASELINE_PX + LINE_HEIGHT_PX))
            .layout()
            .lines
            .len(),
        2
    );
    for equal_or_above in [BASELINE_PX, BASELINE_PX - 1.0] {
        assert_eq!(
            refuse(two_lines(equal_or_above)),
            GlyphAtlasError::UnorderedLayoutBaselines,
            "{equal_or_above}"
        );
    }
    // Descending, but by twice the line box: exactly what a second owner multiplying the line
    // height would produce.
    assert_eq!(
        refuse(two_lines(BASELINE_PX + LINE_HEIGHT_PX * 2.0)),
        GlyphAtlasError::DerivedFieldMismatch
    );
    // And the first baseline is the face's own, not an arbitrary offset.
    assert_eq!(
        refuse(|atlas| atlas.layout.lines[0].baseline_y_px = BASELINE_PX + 1.0),
        GlyphAtlasError::DerivedFieldMismatch
    );
}

#[test]
fn the_layout_size_limits_are_enforced() {
    let lines = |count: usize| {
        move |atlas: &mut UncheckedGlyphAtlas| {
            atlas.layout = layout_of(
                (0..count)
                    .map(|number| line(u32::try_from(number).expect("a line number"), &[0], &[0.0]))
                    .collect(),
            );
        }
    };
    assert_eq!(
        accept(lines(MAX_LAYOUT_LINES)).layout().lines.len(),
        MAX_LAYOUT_LINES
    );
    assert_eq!(
        refuse(lines(MAX_LAYOUT_LINES + 1)),
        GlyphAtlasError::UnsupportedLayoutSize
    );

    // A run whose cells outnumber the bound, spread over legitimate lines.
    assert_eq!(
        refuse(|atlas| {
            let per_line = MAX_LAYOUT_CELLS / MAX_LAYOUT_LINES + 1;
            atlas.layout = layout_of(
                (0..MAX_LAYOUT_LINES)
                    .map(|number| {
                        line(
                            u32::try_from(number).expect("a line number"),
                            &vec![0_u32; per_line],
                            &vec![0.0_f64; per_line],
                        )
                    })
                    .collect(),
            );
        }),
        GlyphAtlasError::UnsupportedLayoutSize
    );
}

/// The layout's two sequences are the ones that could grow without bound, so they stop at the bound
/// while the descriptor is read rather than after it has been allocated.
#[test]
fn the_layout_sequences_stop_at_their_bound_while_being_read() {
    let mut atlas = valid();
    atlas.layout = layout_of(
        (0..=MAX_LAYOUT_LINES)
            .map(|number| line(u32::try_from(number).expect("a line number"), &[0], &[0.0]))
            .collect(),
    );
    let json = serde_json::to_string(&atlas).expect("oversize wire value");
    let error = serde_json::from_str::<GlyphAtlasDescriptor>(&json).expect_err("oversize lines");
    assert!(error.to_string().contains("more than 64"), "{error}");

    let mut atlas = valid();
    atlas.layout = layout_of(vec![line(
        0,
        &vec![0_u32; MAX_LAYOUT_CELLS + 1],
        &vec![0.0_f64; MAX_LAYOUT_CELLS + 1],
    )]);
    let json = serde_json::to_string(&atlas).expect("oversize wire value");
    let error = serde_json::from_str::<GlyphAtlasDescriptor>(&json).expect_err("oversize cells");
    assert!(error.to_string().contains("more than 4096"), "{error}");
}

/// Letter spacing is signed, and it is the one style value that reaches the layout from two places
/// at once, so the two have to still be the same number.
#[test]
fn letter_spacing_is_signed_bounded_and_carried_in_both_places() {
    for spacing in [MIN_LETTER_SPACING_PX, -0.5, 0.0, MAX_LETTER_SPACING_PX] {
        let descriptor = accept(|atlas| {
            atlas.layout.letter_spacing_px = spacing;
            atlas.metrics.letter_spacing_px = spacing;
        });
        assert_eq!(
            descriptor.metrics().letter_spacing_px.to_bits(),
            spacing.to_bits(),
            "{spacing}"
        );
    }
    for spacing in [MIN_LETTER_SPACING_PX - 0.1, MAX_LETTER_SPACING_PX + 0.1] {
        assert_eq!(
            refuse(|atlas| {
                atlas.layout.letter_spacing_px = spacing;
                atlas.metrics.letter_spacing_px = spacing;
            }),
            GlyphAtlasError::UnsupportedLetterSpacing,
            "{spacing}"
        );
    }
    // A non-finite spacing in the metrics is refused with the rest of the metrics, before the
    // layout is looked at, so this pins the layout's own copy.
    for spacing in [f64::NAN, f64::INFINITY] {
        assert_eq!(
            refuse(|atlas| atlas.layout.letter_spacing_px = spacing),
            GlyphAtlasError::UnsupportedLetterSpacing,
            "{spacing}"
        );
    }
    assert_eq!(
        refuse(|atlas| atlas.layout.letter_spacing_px = 1.0),
        GlyphAtlasError::DerivedFieldMismatch
    );
}

#[test]
fn the_wrap_width_must_be_a_width_the_baker_could_have_wrapped_at() {
    assert_eq!(
        accept(|atlas| atlas.layout.max_width_px = Some(MAX_LAYOUT_WIDTH_PX))
            .layout()
            .max_width_px,
        Some(MAX_LAYOUT_WIDTH_PX)
    );
    for width in [0.0, -1.0, f64::NAN, MAX_LAYOUT_WIDTH_PX + 1.0] {
        assert_eq!(
            refuse(|atlas| atlas.layout.max_width_px = Some(width)),
            GlyphAtlasError::UnsupportedLayoutWidth,
            "{width}"
        );
    }
}

/// Justification moves pen positions, so it may only appear on a layout that was justifying.
#[test]
fn only_a_justified_layout_may_carry_a_justification() {
    let justified = accept(|atlas| {
        atlas.layout.text_align = LayoutTextAlign::Justify;
        atlas.layout.lines[0].justification_px = 4.0;
        atlas.layout.lines[0].ends_paragraph = false;
    });
    assert_eq!(
        justified.layout().lines[0].justification_px.to_bits(),
        4.0_f64.to_bits()
    );

    for align in [
        LayoutTextAlign::Left,
        LayoutTextAlign::Center,
        LayoutTextAlign::Right,
    ] {
        assert_eq!(
            refuse(|atlas| {
                atlas.layout.text_align = align;
                atlas.layout.lines[0].justification_px = 4.0;
            }),
            GlyphAtlasError::DerivedFieldMismatch,
            "{align:?}"
        );
    }
}

/// The half of the verdict this side can re-derive is re-derived, so a descriptor whose evidence
/// and conclusion have come apart is refused rather than believed.
#[test]
fn the_shaping_refusal_is_re_derived_from_the_residuals() {
    assert_eq!(
        refuse(|atlas| atlas.metrics.shaping_residual_px = -0.42),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        refuse(|atlas| atlas.layout.lines[0].shaping_residual_px = 0.25),
        GlyphAtlasError::DerivedFieldMismatch
    );
    // Claiming a refusal with nothing to refuse over is just as wrong as hiding one.
    assert_eq!(
        refuse(|atlas| {
            atlas.layout.refusal.shaping_crosses_clusters = true;
            atlas.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
        }),
        GlyphAtlasError::DerivedFieldMismatch
    );

    let kerned = accept(|atlas| {
        atlas.metrics.shaping_residual_px = -0.42;
        atlas.layout.refusal.shaping_crosses_clusters = true;
        atlas.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    });
    assert_eq!(
        kerned.cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: true,
            direction_needs_bidi: false,
        })
    );
    assert!(!kerned.cell_advance_layout().reproduces());
}

/// The verdict is the disjunction of its own reasons, in both directions.
#[test]
fn the_verdict_must_be_the_disjunction_of_its_reasons() {
    assert_eq!(
        refuse(|atlas| atlas.layout.cell_advance_layout = CellAdvanceVerdict::Refused),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        refuse(|atlas| atlas.layout.refusal.direction_needs_bidi = true),
        GlyphAtlasError::DerivedFieldMismatch
    );
    assert_eq!(
        accept(|_| {}).cell_advance_layout(),
        CellAdvanceLayout::Reproduces
    );
}

/// The ledger case: right-to-left text the baker resolved into visual order is drawn, not refused.
///
/// `directionNeedsBidi` is the baker's word and cannot be re-derived here — the cells are still
/// classified right-to-left, and that classification is exactly what stopped being the answer.
#[test]
fn right_to_left_text_the_baker_reordered_is_accepted() {
    let rtl = |atlas: &mut UncheckedGlyphAtlas| {
        atlas.metrics.base_direction = Direction::Rtl;
        atlas.glyphs[0].direction = Direction::Rtl;
        atlas.glyphs[1].direction = Direction::Rtl;
        // Visual order: the run's last cluster is drawn leftmost.
        atlas.layout.lines[0].glyphs = vec![1, 0];
    };
    let reordered = accept(rtl);
    assert_eq!(
        reordered.cell_advance_layout(),
        CellAdvanceLayout::Reproduces
    );
    assert_eq!(reordered.layout().lines[0].glyphs, vec![1, 0]);

    // And a baker that could not reorder still says so, which still refuses.
    let unresolved = accept(|atlas| {
        rtl(atlas);
        atlas.layout.refusal.direction_needs_bidi = true;
        atlas.layout.cell_advance_layout = CellAdvanceVerdict::Refused;
    });
    assert_eq!(
        unresolved.cell_advance_layout(),
        CellAdvanceLayout::Refused(LayoutRefusal {
            shaping_crosses_clusters: false,
            direction_needs_bidi: true,
        })
    );
}

/// An empty run is a legitimate bake — text that is entirely whitespace — and its layout says so
/// rather than pretending to a line.
#[test]
fn a_run_with_no_lines_is_a_layout_of_no_height() {
    let descriptor = GlyphAtlasDescriptor::try_from(empty()).expect("an inkless bake");
    assert_eq!(descriptor.layout().line_count, 0);
    assert_eq!(descriptor.layout().placed_cells(), 0);
    assert_eq!(descriptor.layout().height_px.to_bits(), 0.0_f64.to_bits());
    assert_eq!(
        descriptor.cell_advance_layout(),
        CellAdvanceLayout::Reproduces
    );
}

/// A blank line inside a run is legitimate too, and carries no cells at all.
#[test]
fn a_blank_line_carries_no_cells() {
    let descriptor = accept(|atlas| {
        atlas.layout = layout_of(vec![
            line(0, &[0], &[0.0]),
            AtlasLine {
                advance_width_px: 0.0,
                measured_width_px: 0.0,
                ..line(1, &[], &[])
            },
            line(2, &[1], &[0.0]),
        ]);
    });
    assert_eq!(descriptor.layout().lines[1].glyphs.len(), 0);
    assert_eq!(descriptor.layout().placed_cells(), 2);
    assert_eq!(descriptor.layout().line_count, 3);
}
