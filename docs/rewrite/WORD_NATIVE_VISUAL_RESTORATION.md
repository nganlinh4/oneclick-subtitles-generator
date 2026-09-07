# Restore OSG's established Material 3 Expressive UI

User reports that the launched app looks broken and unfamiliar after the word-native rewrite. This is a visual regression repair, NOT permission for another redesign. The previous functional acceptance does not certify visual fidelity. Restore the actual OSG appearance while keeping the working native transcription behavior.

## Reference and scope

Use commit `24b5a440` as the immediate pre-word-native visual reference. Inspect its components/styles using read-only git views or an isolated reference checkout; do not reset the current tree. Existing unchanged OSG components are also primary references. Use older main only where needed to resolve a specific established expressive pattern; do not restore obsolete business logic.

The user's request supersedes earlier creative freedom: keep OSG's typography, expressive shapes, spacing, pill controls, sliders, dropdowns, switches, theme colors, icons and interaction treatments. Do not replace them with browser-native widgets or a generic interpretation of Material Design. Preserve new task choices and transcript capabilities, expressed through the established components.

Initial supervisor inspection found `CreateSubtitlesModal.css` (724 lines), `lyrics/captionGrouping.css` (188), and `lyrics/transcript.css` (311) newly added. Their existence alone is not a defect; inspect whether they duplicate existing controls, use invalid tokens, override unrelated selectors, or assume the wrong theme activation. Comments asserting Material compliance are not evidence. Do not delete by line-count quota.

## Diagnose before changing

- Compare current and reference screenshots at the same theme, window size, zoom and locale. Inspect the whole visible app, not only the new dialog: main editor, timeline/footer, generation modal and each task tab, transcript/captions toolbar, settings, render controls, menus and toast surfaces.
- Check actual stylesheet import order, CSS specificity/global selector leakage, theme classes/attributes, missing token fallbacks, bundled font/icon loading, and current embedded frontend assets. Distinguish global resource/loading failures from component-specific styling changes. Do not assume every symptom comes from one stylesheet.
- Trace new controls to existing shared OSG implementations. Prefer using those components over cloning their CSS. Retain proper accessible keyboard behavior and unobtrusive keyboard focus; avoid mouse-focus boxes, pulse/heartbeat icons, and surprise motion.
- Check dark and light themes and EN/VI/KO. Fix clipped labels, scroll containers, overlay stacking and modal background-scroll lock. Preserve normal fullscreen aspect-ratio/maximization behavior and preview subtitle scaling.

## Repair rules

Reuse the existing design tokens, typography and expressive control primitives. Remove this rewrite's duplicated styling where replaced, scope any genuinely necessary new selectors, and eliminate contradictory override layers rather than appending more overrides.

Do not change transcription scheduling, timing, ownership, storage, model routing or render technology to fix CSS. Preserve the live native generation/relaunch/export path. Do not silently remove features to make the UI look simpler. If a component API must change, adapt its consumers and prove behavior remains intact.

Do not introduce new colors, fonts, design libraries, onboarding, navigation structures or decorative cards. No new design system. New transcript controls should look as if they belonged to this app before the migration.

Use isolated hidden real-app testing and the existing automation harness. Do not interrupt the user's running app or open OS dialogs during investigation. Preserve all user data. No installer/uninstaller operations, destructive git reset, push or publication.

## Required proof before saying fixed

Create one compact screenshot folder with matched reference/current pairs and final repaired screenshots for the affected surfaces. Inspect actual pixels yourself. Provide a short index identifying each mismatch and its root fix. Include expanded menus, modal scroll behavior, and small-window layouts—not only a flattering idle screenshot.

Require visual fidelity to the reference's design language, not pixel-identical layouts where new functional controls legitimately exist. Explain those minimal additions. If reference execution cannot be reproduced safely, use inspected historical styles/components and existing screenshots, and state that limitation; do not claim a comparison you did not perform.

Run focused frontend tests/lint and the relevant UI/build gates. Do not rebaseline visual locks merely to silence differences: inspect and justify each changed surface. Smoke-test that the repaired controls still select Transcribe, submit, show captions and reach export through the real app. Reuse existing evidence/helpers rather than another test framework or reviewer swarm.

Rebuild through the repository's frontend-plus-native managed build entry point after final fixes. Report the exact normal EXE path/hash/source commit. Do not launch or close the user's app without a fresh request; hand it back ready for testing.

## Worker report — update this file

Status: NOT STARTED. Supervisor visual acceptance: NOT REVIEWED.

- Actual root causes (global loading/theme versus local component changes):
- Reference source and screenshot comparison conditions:
- Components reused; duplicated styles removed; files/commits changed:
- Screenshot folder and individually inspected before/after observations:
- Focused gate and real-flow results, including failed attempts:
- Final frontend/native build command, normal EXE path/hash/source commit:
- Remaining deviations or unverified surfaces:

Continue through diagnosis, restoration, screenshot inspection and verification without routine approval pauses. Do not declare the whole UI fixed based on a stylesheet comment, unit-test total or screenshot creation alone.
