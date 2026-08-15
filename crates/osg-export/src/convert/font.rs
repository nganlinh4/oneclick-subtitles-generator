//! Which family a persisted `font-family` value actually asks for.
//!
//! The request carries the CSS value the project stored — `'Inter', sans-serif` — while the scene
//! carries one resolved face. Deciding whether those two agree needs the same primary-family
//! extraction the `WebView` performs in `src/services/fontIdentity.js`, so this is a deliberate
//! twin of `parseFontFamilyValue` and nothing more: it splits on commas, trims, strips one
//! surrounding quote pair, drops empty entries, takes the first, and refuses a generic keyword.
//!
//! It resolves nothing and substitutes nothing. A value this module refuses is a value the export
//! refuses, because the alternative — picking some other family — is exactly the silent
//! substitution the migration removes.

/// The largest `font-family` value the render contract accepts, mirrored so this module refuses the
/// same input the contract does even when it is called on its own.
const MAX_FONT_FAMILY_BYTES: usize = 256;

/// The CSS generic families and global keywords, which never name a real face.
///
/// Copied from `GENERIC_FAMILIES` in `src/services/fontIdentity.js`. All ASCII, so an ASCII-only
/// comparison is equivalent to the `WebView`'s Unicode lowercasing for the purpose of matching.
const GENERIC_FAMILIES: [&str; 18] = [
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
    "inherit",
    "initial",
    "revert",
    "revert-layer",
    "unset",
];

/// The one family a persisted `font-family` value can become an identity for.
///
/// Returns `None` when the value carries a control character, is longer than the contract accepts,
/// declares no family at all, or names a generic family. Every one of those is a refusal rather
/// than a fallback.
#[must_use]
pub fn primary_font_family(value: &str) -> Option<&str> {
    if value.len() > MAX_FONT_FAMILY_BYTES || value.chars().any(char::is_control) {
        return None;
    }
    let primary = value
        .split(',')
        .map(|part| strip_quotes(part.trim()).trim())
        .find(|part| !part.is_empty())?;
    if is_generic(primary) {
        return None;
    }
    Some(primary)
}

/// Removes one surrounding quote pair, matching the `WebView`'s `^["'](.*)["']$` exactly — the
/// opening and closing quotes need not be the same character.
fn strip_quotes(value: &str) -> &str {
    let bytes = value.as_bytes();
    let quoted = bytes.len() >= 2
        && matches!(bytes[0], b'"' | b'\'')
        && matches!(bytes[bytes.len() - 1], b'"' | b'\'');
    if quoted {
        // Both ends are single-byte ASCII quotes, so the interior is still a character boundary.
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn is_generic(family: &str) -> bool {
    GENERIC_FAMILIES
        .iter()
        .any(|generic| generic.eq_ignore_ascii_case(family))
}

#[cfg(test)]
mod tests {
    use super::{GENERIC_FAMILIES, primary_font_family};

    #[test]
    fn the_first_declared_family_is_the_one_that_counts() {
        assert_eq!(primary_font_family("'Inter', sans-serif"), Some("Inter"));
        assert_eq!(primary_font_family("\"Noto Sans\""), Some("Noto Sans"));
        assert_eq!(primary_font_family("  Georgia  ,  serif "), Some("Georgia"));
        assert_eq!(primary_font_family("Impact"), Some("Impact"));
    }

    #[test]
    fn an_empty_leading_entry_is_skipped_the_way_the_web_view_skips_it() {
        assert_eq!(primary_font_family(", , Tahoma"), Some("Tahoma"));
        assert_eq!(primary_font_family("'' , Tahoma"), Some("Tahoma"));
    }

    #[test]
    fn a_mismatched_quote_pair_is_stripped_exactly_as_the_web_view_strips_it() {
        // The shipped regex accepts any opening quote with any closing quote, so reproducing it
        // matters more than tidying it: a value the WebView resolved must resolve identically here.
        assert_eq!(primary_font_family("\"Inter'"), Some("Inter"));
        assert_eq!(primary_font_family("'Inter\""), Some("Inter"));
    }

    #[test]
    fn a_generic_family_names_no_face() {
        for generic in GENERIC_FAMILIES {
            assert_eq!(primary_font_family(generic), None, "{generic} resolved");
            assert_eq!(
                primary_font_family(&generic.to_uppercase()),
                None,
                "{generic} resolved when upper-cased"
            );
        }
    }

    #[test]
    fn a_value_the_contract_would_refuse_is_refused_here_too() {
        assert_eq!(primary_font_family(""), None);
        assert_eq!(primary_font_family("   "), None);
        assert_eq!(primary_font_family(",,,"), None);
        assert_eq!(primary_font_family("Inter\0"), None);
        assert_eq!(primary_font_family("Inter\n"), None);
        let over = "x".repeat(257);
        assert_eq!(primary_font_family(&over), None);
        let exact = "x".repeat(256);
        assert_eq!(primary_font_family(&exact), Some(exact.as_str()));
    }

    #[test]
    fn a_multibyte_family_survives_the_quote_strip() {
        assert_eq!(
            primary_font_family("'맑은 고딕', sans-serif"),
            Some("맑은 고딕")
        );
        assert_eq!(primary_font_family("한"), Some("한"));
    }
}
