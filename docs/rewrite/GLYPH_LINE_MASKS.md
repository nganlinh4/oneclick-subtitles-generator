# Subtitle glyph representation: line masks and typewriter reveal

STATUS. The line-mask migration is being implemented. The ordinal reveal plane described below is the
accepted design for the typewriter effect and is NOT implemented yet; until it is, a cell carries no
reveal plane and the typewriter degrades to a whole-line reveal, which is the capability-absent path
this document already defines.

WHY THIS DOCUMENT EXISTS. A cell used to be a grapheme cluster, and a line was drawn by accumulating
per-cluster advances. That required the width of a run to equal the sum of its parts, which kerning,
ligatures and contextual shaping make false, so ordinary text was refused whenever two independent
measurements failed to agree to a ten-thousandth of a pixel. The replacement is one authoritative
shaped raster per line: the mask, its ink box and its advance come from a single operation and
therefore cannot disagree.

The typewriter effect is the one consumer that needs sub-line granularity. A left-to-right
rectangular clip over a finished line is not acceptable: it reveals in the wrong order for
right-to-left and mixed-direction text, and it can cut a ligature or a joined form in half. The
design below was chosen from three candidates after adversarial review through right-to-left,
joined-glyph and bounds lenses; four of the nine verdicts were fatal and killed two candidates
outright.

---

# Chosen representation: **Ordinal Reveal Plane, derived by component-certified logical attribution**

I am not shipping any of the three as proposed. I keep design 3's *wire and GPU* representation (a per‑pixel logical ordinal packed into the RGB bytes the alpha mask already allocates) because it is the only one of the three that costs zero extra cells, zero extra atlas bytes and zero extra quads, and in which a left‑to‑right rect clip is structurally inexpressible. I throw away design 3's *derivation* entirely — the prefix ladder is what the RTL and bounds verdicts killed (left‑anchored prefixes, `unitCount` collapsing to 1 on every Hebrew line, O(units) rasterizations) and it is also what makes design 1 unshippable.

The derivation instead comes from design 2's insight — the shipped raster is the referee — but with the referee fixed. Design 2's certifier proved a *covering* (every inked column owned by exactly one interval), which any covering satisfies, including one that shears a ligature. I replace intervals-and-gaps with **8‑connected components of the shipped alpha plane**. A component is atomic by definition; there is no boundary column, no "strictly between", no `x0 >= x1` with equality permitted, and therefore no reading of the algorithm under which a joined glyph can be cut. Attribution errors can only *delay* a component, never split one and never show it early.

Net: **one raster per shaped line, one cell, one quad, zero extra atlas bytes, two linear passes over pixels the baker already reads back.**

---

## 1. The staged descriptor

All changes are additive to the one‑mask‑per‑line wire shape. Files: `src/platform/glyphAtlasStaging.js`, `crates/osg-scene/src/glyph/{wire,layout,limits,bounded,validate,validate_layout}.rs`.

### 1a. Pixel layout of an atlas cell (`Rgba8Unorm`, unchanged format)

| channel | meaning | today |
|---|---|---|
| `A` | coverage. The single authoritative line rasterization. The **only** channel any coverage path samples. | unchanged |
| `R` | reveal ordinal, low byte | was `255` (white fill), ignored |
| `G` | reveal ordinal, high byte | was `255`, ignored |
| `B` | `0`, reserved | was `255`, ignored |

`ordinal = round(R*255) + round(G*255)*256`, range `0 ..= unitCount-1`, 16‑bit. Two bytes rather than design 3's one, which deletes its `MAX_REVEAL_UNITS = 256` cap and the whole `coarseStride` machinery — the coarsening only existed to bound a bake cost this derivation does not have.

Verified safe against the current shader: every coverage read in `crates/osg-compositor/src/shaders/subtitle.wgsl` is `textureSampleLevel(...).a` or `cell_alpha(...)` which returns `.a`. Nothing reads RGB today.

### 1b. New field on the atlas cell (`AtlasGlyph` / `wire.rs`)

```
reveal: null | {
  unitCount:   u32,          // 1 ..= MAX_REVEAL_UNITS_PER_LINE (4096)
  stops:       base64<u16 LE>,   // exactly unitCount entries, STRICTLY increasing
  granularity: 'grapheme' | 'line',
  mergedAtoms: u32,          // graphemes minus unitCount; data, never an error
}
```

* `stops[k]` = cumulative UTF‑16 length, **of this line's own post‑transform source text**, through the last logical grapheme of atom `k`.
* `stops[unitCount-1]` is always the line's full UTF‑16 length. This is the closing tie (§1c).
* `reveal` is `null` for any cell no typewriter cue draws. Non‑typewriter documents pay nothing and change in no byte.
* Cell‑scoped, not line‑scoped, so two cues with identical line text/direction/word‑spacing dedupe raster *and* stops.
* base64‑packed u16 purely for `maxMetadataBytes`.

### 1c. New fields on `AtlasLine` (`layout.rs`)

```
revealUnitsBefore: u32,   // running sum of preceding lines' revealUnitsTotal in this run
revealUnitsTotal:  u32,   // this line's own UTF-16 length, including trailing hanging spaces
```

Blank/whitespace lines carry their units so a blank still costs the typewriter its turn, exactly as `revealed_cells` does today.

### 1d. Bounds and validators

New in `limits.rs`, mirrored in `glyphAtlas.js`:

```
MAX_REVEAL_UNITS_PER_LINE: usize = 4_096;    // same number as MAX_LAYOUT_CELLS
MAX_REVEAL_UNITS_PER_PAGE: usize = 65_536;   // metadata guard only (see §5, it is not a capacity claim)
```

Checked on **both** sides (`glyphAtlasStaging.js::validateReveal`, `validate.rs`):

1. `stops.len() == unitCount`, `1 <= unitCount <= MAX_REVEAL_UNITS_PER_LINE`.
2. `stops` strictly increasing, every entry `> 0`.
3. Σ`unitCount` over the page's cells `<= MAX_REVEAL_UNITS_PER_PAGE`.
4. `revealUnitsBefore[i] == Σ revealUnitsTotal[0..i]` — Rust re‑derives this, it is a real check.
5. **The closing tie:** for every line `l`, `masks[l.mask].reveal.stops.last() == l.revealUnitsTotal`. This is *not* tautological: it binds the atomization baked into the pixels to the line's own text length, and it is the reason a cell can be shared only by lines that really are the same line.
6. A run whose style is `Typewriter` and whose cells carry `reveal: null` is **not** refused — it draws whole lines (`granularity: 'line'` semantics), because refusing an ordinary cue for a platform capability gap is worse than a coarse animation. Whether that happened is visible in the descriptor.

An out‑of‑range ordinal byte is deliberately **not** scanned per pixel. The shader test is `ordinal <= threshold`; an out‑of‑range ordinal can only ever *hide* ink, never reveal it early. The failure direction is closed, so pixel bytes are trusted exactly as much as the alpha bytes already are.

---

## 2. What the WebView bake does

New module `src/platform/glyphAtlasReveal.js` (~300 lines), invoked from `glyphAtlasPage.js::rasterize` only when the bake request carries `reveal: true`. Everything before it is the plain one‑mask‑per‑line bake.

**Step 0 — capability probe.** `supportsSubstringInkBounds()`: `typeof ctx.measureText('ab').getActualBoundingBox === 'function'`. Injected test surfaces must answer it. False ⇒ every cell gets `unitCount: 1`, `stops: [lineUtf16Len]`, `granularity: 'line'`, all ordinals 0; the typewriter reveals line by line. This is a **degradation, not a refusal**, and it is folded into `contentHash` so preview and export cannot disagree about it. (The pipeline already depends on Chromium‑class canvas: `ctx.letterSpacing` / `ctx.wordSpacing` in `glyphAtlasSurface.js::pin`. This adds no new class of dependency.)

**Step 1 — one shaping, one raster.** Pin the surface with the LINE's own bundle: `cssFont`, `letterSpacing = layout.letterSpacingPx`, `wordSpacing = line.justificationPx`, `direction = resolved paragraph direction`, `fontKerning: 'normal'`, `textBaseline: 'alphabetic'`. One `measureText(lineText)` → `metrics`. One `fillText(lineText, pen, baseline)` into the packed page. **This is the only rasterization. There is no ladder, no scratch canvas, no second draw.**

**Step 2 — proposer boxes, from that same `metrics`.** For each grapheme cluster `i` with UTF‑16 range `[s,e)` in `lineText`, query `metrics.getActualBoundingBox(s, e)` → `box(i)`, snapped to integer cell‑local pixels. These are slices of one `ShapeResult`; the engine shaped once and is answering about that shaping. **No prefix is ever measured, no substring is ever re‑shaped, no advance is ever compared for equality.**

**Step 3 — connected components of the shipped alpha.** After the page's single `getImageData` readback (the one `rasterize` already performs), for each line cell run an 8‑connected flood fill over `{p in cellRect : alpha(p) != 0}`, **restricted to the cell's own rect** so a neighbour on the same shelf cannot join. Ink test is exactly `alpha != 0` — no tolerance, because any tolerance above zero clips real antialiased ink and there is no principled value above it.

**Step 4 — hosting (attribution).** For each grapheme `i`, `host(i) = argmax_C |C ∩ box(i)|` (ties → the component with the smaller top‑left, deterministic). For each component `C`:

```
t(C) = max{ i : host(i) == C }            if C hosts at least one grapheme
t(C) = max{ i : C ∩ box(i) != empty }     otherwise (stray ink: colour-glyph
                                          overhang, an i-dot, a split matra)
t(C) = G-1                                if it hosts nothing and touches no box
```

The *hosting* rule rather than raw box intersection is what keeps ordinary kerned Latin from coarsening: `A` and `V` in "AVA" have overlapping ink boxes but each grapheme is hosted by its own blob, so they stay separate atoms. Intersection alone would have merged them, which is the coarsening design 2 was correctly punished for. The fallbacks are all *fail‑late*: unclaimed ink is shown at the end, never early.

**Step 5 — atomization.** `f(i) = t(host(i))` for inked graphemes (note `f(i) >= i` by construction), `f(i) = i` for inkless ones (spaces). `F(i) = max(f(i), F(i-1))`, `F(-1) = -1`. Atoms are the maximal runs of constant `F`; atom `k` spans logical range `[a_k, b_k]`, `unitCount = U` = number of atoms, `mergedAtoms = G - U`.

**Step 6 — write the plane.** For component `C`, `ordinal(C) = k` where `b_{k-1} < t(C) <= b_k`. Write `R/G` for every pixel of `C` in the page buffer, in place. Uninked pixels get ordinal 0 (never sampled: coverage is alpha, which is zero there). `B = 0`.

**Step 7 — stops.** `stops[k] = ` cumulative UTF‑16 length of clusters `0 ..= b_k`. Strictly increasing because every atom holds at least one cluster and every cluster is at least one UTF‑16 unit.

**Step 8 — cross‑check.** Partition the line by bidi level run (`analyzeRunBidi`). Within each level run, component ordinals must be x‑monotone in that level's direction (ascending for even level, descending for odd), modulo components shared across atoms. A violation means the box source and the logical index have come apart; that line degrades to `unitCount: 1, granularity: 'line'` — it does **not** refuse, and it does not silently keep a wrong order. **`glyphAtlasBidi.js` keeps its existing refusals for explicit embedding/isolate controls.** Design 2 proposed retiring them; the verdict showed that retiring them invalidates exactly this cross‑check, because `analyzeRunBidi` has no X10 isolate model and no N0 bracket pairing. They stay.

**Step 9 — identity.** `canonicalize` in `glyphAtlasPage.js` folds `unitCount`, `stops`, `granularity`, `mergedAtoms` into the hash text; `fnv1a32` already folds every pixel byte, so the R/G plane is inside `contentHash` automatically.

**Worked example, "office" (Georgia, `liga` on, one `ffi` glyph).** Graphemes o,f,f,i,c,e. One component per letter except the ffi, which is a single connected blob. Hosting: `host(f1)=host(f2)=host(i)=C_ffi`, so `t(C_ffi)=3`. `f = [0,3,3,3,4,5]`, `F = [0,3,3,3,4,5]`, atoms `[0..0][1..3][4..4][5..5]`, `U=4`, `stops=[1,4,5,6]`, `mergedAtoms=2`. At `revealed=3` the shader threshold is `partition_point(stops, s<=3) - 1 = 0`: only "o" is on screen. At `revealed=4` the entire ffi appears at once. There is **no threshold at which any subset of the ffi's pixels is painted**. The delay is visible and correct; a cut is not expressible.

### Deletions this enables

`resolveContextualCells`, `spellingsOf`, `runAdvances`, `CONTEXT_JOINER` and the candidate‑advance equality in `glyphAtlasCells.js`; `shapingResidualPx`, `cellAdvanceLayout`, `LayoutRefusal.shapingCrossesClusters` and the `glyphAtlasCells.js` second‑chance cell set; `cluster_utf16_len`, `typed_cluster` and `CONTEXT_JOINER` in `typewriter.rs` (the counting rule now lives once, on the side that owns segmentation).

---

## 3. What Rust does per frame

**`crates/osg-compositor/src/typewriter.rs`** — the module keeps its UTF‑16 doctrine and changes its output type:

```rust
pub(crate) enum LineReveal { Hidden, Upto(u16), Full }

pub(crate) fn line_reveals(atlas, run, progress) -> Vec<LineReveal> {
    let total = run.lines().iter().map(|l| l.reveal_units_total() as usize).sum();
    let revealed = typewriter_utf16_length(total, progress);   // unchanged, still raw progress
    run.lines().iter().map(|line| {
        let local = revealed.saturating_sub(line.reveal_units_before() as usize);
        if local == 0 { return LineReveal::Hidden; }
        if local >= line.reveal_units_total() as usize { return LineReveal::Full; }
        match cell(line).reveal {
            None => LineReveal::Hidden,                  // no plane => whole-line pop
            Some(r) => match r.stops.partition_point(|s| (*s as usize) <= local) {
                0 => LineReveal::Hidden,
                k => LineReveal::Upto((k - 1) as u16),
            },
        }
    }).collect()
}
```

Note there is **no x‑based fast path anywhere**. Design 2's fatal RTL bug was `atoms.last().units_through <= u`, which on an RTL line reads the *first logical* grapheme's threshold and pops the whole line on tick one. Here `Full` is decided from logical cumulative counts only, and `Full` is provably identical to `Upto(U-1)` (every inked pixel has ordinal `<= U-1`) — asserted by test, not by argument.

**`glyphs.rs::emit_glyphs`** — `GlyphPass.revealed: Option<usize>` becomes `reveal: Option<&'scene [LineReveal]>`. Per line: `Hidden` ⇒ **`continue`**, not `return` (a later line is handled by its own verdict); `Full` ⇒ today's `KIND_GLYPH`/`KIND_STROKE`, byte‑identical path; `Upto(t)` ⇒ `KIND_GLYPH_TYPED`/`KIND_STROKE_TYPED` with `shape.radius = f64::from(t)`. All three walks (fill, stroke, shadow mask) share the `GlyphPass`, so a partly typed cue still casts a partly typed shadow and wears a partly typed stroke. `line_left`, `block_left`, `run_align`, `line_widths` are untouched and placement always uses the **full** line's `advance_width_px` — nothing reflows, and revealed ink sits pixel‑exactly where it will sit when finished, because it *is* the finished pixel.

**`geometry.rs`** — `KIND_GLYPH_TYPED: f64 = 5.0`, `KIND_STROKE_TYPED: f64 = 6.0`. New kinds rather than a flag on the old ones, so a non‑typing frame goes down a byte‑identical code path. The threshold rides in `Quad.shape.radius`, which reaches the shader as `params.x` and is zero and unread for every glyph and stroke quad today. `VERTEX_FLOATS` stays 20.

**`shaders/subtitle.wgsl`** — the `else` chain becomes explicit (`<4.5` glow, `<5.5` typed glyph, else typed stroke), plus:

```wgsl
fn ordinal_at(uv: vec2<f32>) -> f32 {
  let dims  = vec2<f32>(textureDimensions(atlas_texture, 0));
  let texel = vec2<i32>(clamp(floor(uv * dims), vec2<f32>(0.0), dims - vec2<f32>(1.0)));
  let px    = textureLoad(atlas_texture, texel, 0);
  return round(px.r * 255.0) + round(px.g * 255.0) * 256.0;
}

// Manual bilinear over the 2x2 neighbourhood with each tap gated by its own ordinal.
// Exact at the frontier: an unrevealed component contributes nothing to a filtered sample.
fn typed_coverage(uv: vec2<f32>, cell: vec4<f32>, threshold: f32) -> f32 { /* 4 textureLoad */ }
```

`textureLoad`, never `textureSampleLevel`, for the ordinal — bilinear would average ordinal 3 and ordinal 40 into 21 and produce a frontier that is simply wrong. `KIND_GLYPH_TYPED` uses `typed_coverage` (4 loads, replacing 1 sample). `KIND_STROKE_TYPED` gates each of the 25 ring taps with a nearest `ordinal_at` test on the plain filtered `cell_alpha` (25 samples + 25 loads while typing, unchanged otherwise) — sub‑texel exactness is not worth 100 loads inside a stroke band. The texture format must stay `Rgba8Unorm`, never `Rgba8UnormSrgb`, and must never gain mipmaps; both pinned by test.

**`plan.rs:271`** — `reveal: (style.animation() == Typewriter && active.phase == FadingIn).then(|| line_reveals(atlas, run, active.progress))`. Unchanged in spirit.

**`run.rs`** — `CueLine` carries `mask: u32`, `pen_x_px: f64`, `reveal_units_before`, `reveal_units_total`; `CueRun::validate` re‑derives the running sum and checks the closing tie, so a bad scene is refused before a frame exists.

---

## 4. How preview and export stay identical

* One bake module, one descriptor, one `contentHash`. The ordinal plane lives **inside** the cell pixels, which `fnv1a32` already folds, and its metadata is inside `canonicalize`. There is no second reveal model on either side and neither side re‑bakes.
* Rust derives the threshold from `typewriter_utf16_length(total, progress)` alone — a pure function of `(total_units, progress)` — plus `partition_point` over staged `stops`. No shaping, no measurement, no clock.
* The capability probe and every degradation (`granularity: 'line'`, a cross‑check failure on one line) are properties of the WebView process that runs **both** paths, and all of them are folded into `contentHash`. Preview and export therefore cannot disagree about whether the feature is available — which is precisely the asymmetry that made design 1's fallback story incoherent.
* Paging is made byte‑aware (§5) so export stages exactly the pages preview would. Cell **indices** are the only thing a page remaps, and `glyphAtlasPage.js::remapRun` already proves that is exact.
* Acceptance test: bake once, stage once, render the preview frame at time `t` and the export frame at time `t`, compare byte for byte, for `t` spanning every atom boundary of a typewriter cue.

---

## 5. Legitimate typed refusals

Every one of these is a real bound or a real unavailability, and none is reachable by ordinary kerning, ligatures, cursive joining or bidi reordering — those produce **merges**, reported as `mergedAtoms`.

| code | when | actionable message |
|---|---|---|
| `glyphAtlasSpacingUnsupported` | the surface has no `letterSpacing`/`wordSpacing`, so the raster would not be the line that ships | the WebView cannot bake this face |
| `glyphAtlasLineTooWide` | one line's ink box exceeds `MAX_ATLAS_DIMENSION_PX` on either axis. **New with line masks**, and unavoidable: per‑cluster cells never had it | enable word wrap or reduce the font size |
| `glyphAtlasPageBudget` | **new, and required.** `partitionRunsIntoPages` today closes a page only when `packAtlas` returns `null` — a *dimension* test — and never consults `maxPayloadBytes`. Under one‑mask‑per‑line that gap is the normal path: the baker emits 64 MiB pages the stager then rejects with an unactionable `glyphAtlasStagingPayloadTooLarge` **after** the whole raster pass. Fix: close a page when `packed.widthPx * packed.heightPx * 4 + FRAME_HEADER_BYTES + metadataReserve > maxPayloadBytes`, and refuse typed only when a **single** line cell alone cannot fit | reduce the font size |
| `glyphAtlasPixelBudget` / `glyphAtlasTooManyPages` | document exceeds 256 MiB / 32 pages | unchanged |
| `glyphAtlasSurfaceUnavailable` | readback returned the wrong size | unchanged |

**Not refusals, by decision:** no substring‑ink‑box API (⇒ `granularity: 'line'`); a cross‑check violation on one line (⇒ that line becomes one atom); a typewriter run whose cells carry `reveal: null` (⇒ whole lines pop). Each is recorded in the descriptor and surfaced in diagnostics as `revealGranularity` / `mergedAtoms` / `atomsPerLine`, so silent coarsening is observable rather than mysterious.

The reveal itself **adds no refusal and no byte**. Every bound above is a property of one‑mask‑per‑line, inherited from the migration; I own stating them because the reveal must live inside them, not because it moves them.

---

## 6. Mutation test

**Target mutation:** replace `KIND_GLYPH_TYPED`'s coverage test `ordinal_at(uv) <= params.x` with a left‑edge rectangular clip of the full line mask — i.e. `uv.x < cell.x + (cell.z - cell.x) * revealedFraction` — keeping everything else.

### Primary test (synthetic, no font, deterministic): `reveal_rtl_is_a_right_edge_suffix`

`crates/osg-compositor/tests/typewriter_reveal.rs`. Build a `GlyphAtlasDescriptor` by hand — one 40×10 cell, alpha 255 across all 40 columns, ordinals **descending with x**: columns 30–39 → 0, 20–29 → 1, 10–19 → 2, 0–9 → 3. `stops = [1,2,3,4]`, one line, `revealUnitsBefore = 0`, `revealUnitsTotal = 4`, `textAlign: Right`, style `Typewriter`, `progress = 0.3` ⇒ `typewriter_utf16_length(4, 0.3) = 1` ⇒ threshold 0.

**Assert:** the composited frame has non‑zero alpha only in the **rightmost** quarter of the line box, and exactly zero alpha in the left three quarters.

**With the mutation:** the clip paints the leftmost quarter (ordinal 3, the *last* logical grapheme) and leaves the right quarter empty. The test fails on both halves of the assertion — it is not a near miss.

### Strongest test (real bake, mixed bidi): `reveal_mixed_bidi_is_non_contiguous`

Input text, named exactly: **`אבג 12`** — Hebrew alef/bet/gimel, space, Latin digits one/two — as a single typewriter cue with `rtlSupport` on. UAX #9 gives Hebrew level 1 and the EN digits level 2; L2 reverses the digit run and then the whole line, so the visual left‑to‑right picture is `1 2 ␠ ג ב א`. Logical cumulative UTF‑16: א→1, ב→2, ג→3, ␠→4, 1→5, 2→6.

Render at `progress = 5/6` ⇒ `revealed = 5`: א, ב, ג and `1` are due; `2` is not.

**Assert:** scanning the line box left to right, the painted columns form **three bands — painted, dark, painted**: the `1` glyph at the far left is on, the `2` glyph immediately to its right is off, and the Hebrew `גבא` at the right is on. Concretely, `∃ x1 < x2 < x3` with alpha > 0 at `x1` and `x3` and alpha == 0 at `x2`, and the dark band lies strictly between two painted bands.

**With the mutation:** a rectangular clip from *either* edge produces a single contiguous painted band. It cannot produce a hole, for any threshold, ever. The assertion is unsatisfiable under the mutant.

### Supporting tests (each also fails under the mutation)

* `ligature_is_never_partially_painted` — bake `office` through the injected test surface (`glyphAtlasTestFont.js`) whose `drawGlyph` paints `ffi` as one connected blob and whose proposer returns three identical boxes. Sweep every threshold `0..U-1` and assert the painted column set inside the ligature's x‑range is **either empty or complete** at every threshold, and that `stops == [1,4,5,6]`, `unitCount == 4`, `mergedAtoms == 2`. The clip paints roughly two thirds of the ligature at `revealed = 3`.
* `full_equals_last_threshold` — `LineReveal::Full` and `LineReveal::Upto(U-1)` produce byte‑identical frames.
* `non_typewriter_never_reads_the_plane` — a non‑typewriter cue emits only `KIND_GLYPH`/`KIND_STROKE` and its frame is byte‑identical to the pre‑change golden.
* `atlas_format_is_unorm_and_unmipped` — pins `Rgba8Unorm`, `mip_level_count == 1`.
* `stops_tie_to_line_length` — a descriptor whose `stops.last() != revealUnitsTotal` is refused at `CueRun::validate`.

---

## 7. Residual risk, stated plainly

1. **Geometry is proved; identity is trusted.** The raster proves that no glyph is cut and that every pixel shown is the finished line's own pixel at its own alpha. It does **not** prove that component `C`'s ink belongs to graphemes hosted by `C`. A proposer with an off‑by‑one, or one reporting in visual order while we index logically, yields a perfectly valid plane with a wrong reveal order. The within‑level‑run monotonicity cross‑check catches gross cases; a reversal internal to a reordering script is undetectable from Canvas. This is the irreducible dishonesty of any Canvas‑based approach and it must be recorded in `glyphAtlasReveal.js`'s header, not discovered later.
2. **Chromium‑only.** Grapheme granularity needs per‑substring ink boxes on the same `TextMetrics`. WebView2 has them; WKWebView and WebKitGTK do not. Those targets get line‑at‑a‑time typing, probed and reported, never refused.
3. **Connected scripts coarsen to words.** Arabic, Nastaliq, Devanagari with a continuous shirorekha: the ink genuinely is one blob, so a joined word is one atom. Typing becomes word‑at‑a‑time. The shipped DOM renderer achieved letter‑by‑letter there only by re‑shaping each prefix, which the ladder verdicts showed also *un‑types* (Kannada `ಕ್ಕ` shrinks 2.57 px on its final step; Sinhala `ක්‍ෂ` loses 19 px of ascent). Word‑atomic is the truthful degradation, not a regression from something correct.
4. **Tight tracking, script faces, small atlas sizes.** Any two glyphs whose antialiasing bridges a single pixel become one component. Hosting keeps ordinary kerned Latin ("AVA", "To") separate, but a brush face or a 12 px atlas will merge aggressively. Observable only via `mergedAtoms`; refusing would violate the never‑refuse‑for‑shaping rule.
5. **The RGB channels stop being meaningless.** Any future stage that premultiplies the atlas, converts it to sRGB, generates mipmaps, or "optimises" it by assuming RGB is constant white will corrupt the reveal while leaving coverage perfect — a texture‑pipeline bug that presents as a typewriter bug.
6. **Ordinal quantizes to the atlas grid.** At heavy downscale (512 px face composited at 16 px) the frontier resolves to one atlas texel, sub‑pixel on screen but not resolution‑independent the way coverage is.
7. **Stroke fetch count roughly doubles while typing** (25 samples + 25 loads). Bounded, coherent, zero when not typing.
8. **Per‑line masks genuinely shrink the document ceiling.** At a 64 px atlas face a two‑line cue costs ~800 KB against 256 MiB; the per‑cluster atlas it replaces deduped a Latin film into ~1.3 MB. The reveal adds **zero** to this, but it lands on whoever implements it, and §5's byte‑aware page close is mandatory rather than optional — without it the failure arrives as an unactionable IPC error after the entire raster pass.
9. **Reveal counts are no longer auditable against characters on the native side.** With `cluster` text off the wire, Rust range‑checks `stops` and re‑derives the running sum and the closing tie, but cannot verify an atomization against text. That is a deliberate trade for a smaller payload and for keeping subtitle text off IPC; it means a mutation that scrambles the plane must be caught by a **pixel** test, never by a validator test — which is exactly what §6 is for.
10. **Divergence from the shipped renderer is preserved, not fixed.** Units are graphemes of the final transformed text; the shipped renderer counted UTF‑16 of the raw string. Astral clusters, hard breaks and length‑changing case transforms still differ, inherited from today's `typewriter.rs`.
