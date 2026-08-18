/**
 * The one default subtitle font, named once.
 *
 * WHY THIS FILE EXISTS. There were two defaults. The editor's saved-settings default was
 * `Google Sans, sans-serif`, and the render/export customization default was `'Arial', sans-serif`.
 * They disagreed, and the editor's half did not resolve at all, so a fresh installation showed
 * "subtitle preview unavailable" permanently while an export of the same project would have drawn a
 * different face than the preview promised.
 *
 * WHY THE MANAGED FAMILY AND NOT ARIAL. The application installs and hash-verifies the Google Sans
 * Flex package at startup before the WebView is shown, and refuses to report readiness if that fails,
 * so the family is available to preview and export as exact bytes on a clean offline install. Arial
 * is a system face whose bytes are whatever the machine happens to have. Choosing the verified
 * package is what makes "preview and export resolve the same bytes" true rather than probable.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not silently degrade to a system face when the package
 * is missing. A missing package is a real, reportable capability failure with an install action, not
 * a different-looking subtitle nobody was told about.
 *
 * This module is a LEAF on purpose: the shared customization defaults and the font services both
 * import it, and giving it any import of its own would create the cycle it exists to avoid.
 */

/** The family name as the managed package declares it. Must equal `MANAGED_FONT_PACKAGE.family`. */
export const DEFAULT_SUBTITLE_FONT_NAME = 'Google Sans';

/** The CSS stack stored in settings, customization, presets and render requests. */
export const DEFAULT_SUBTITLE_FONT_FAMILY = `'${DEFAULT_SUBTITLE_FONT_NAME}', sans-serif`;

/**
 * The editor's pre-fix default, kept only so migration can recognise it.
 *
 * It names the same family in an unquoted stack. It is not "wrong" and needs no rewriting now that
 * the family resolves — this constant exists so a reader who greps the old string finds the reason
 * rather than concluding it was lost.
 */
export const LEGACY_IMPLICIT_SUBTITLE_FONT_FAMILY = 'Google Sans, sans-serif';
