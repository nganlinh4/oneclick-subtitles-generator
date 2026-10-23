//! Digest, revision, and platform identifiers shared by every delivery catalog.

/// Every catalog declares exactly these platform keys, even when a platform has no release.
pub const PLATFORM_KEYS: &[&str] = &[
    "linux-x86_64",
    "macos-aarch64",
    "macos-x86_64",
    "windows-x86_64",
];

#[must_use]
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", "x86_64") => "macos-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        _ => "unsupported",
    }
}

/// Lowercase hexadecimal SHA-256, the only digest spelling catalogs and receipts accept.
#[must_use]
pub fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && is_lower_hex(value)
}

/// A full 40-character lowercase Git commit, the only immutable source revision accepted.
#[must_use]
pub fn is_git_revision(value: &str) -> bool {
    value.len() == 40 && is_lower_hex(value)
}

/// A release asset's file name as every delivery catalog declares it: 1-200 bytes of ASCII
/// letters, digits, `.`, `-` and `_`, starting with a letter or digit (so never `.`, `..`, or an
/// option-like `-name`). The strictest rule every reviewed catalog asset satisfies.
#[must_use]
pub fn is_asset_name(value: &str) -> bool {
    value.len() <= 200
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn is_lower_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_require_exact_lowercase_hex() {
        assert!(is_sha256_hex(&"a".repeat(64)));
        assert!(!is_sha256_hex(&"A".repeat(64)));
        assert!(!is_sha256_hex(&"a".repeat(63)));
        assert!(is_git_revision(&"0".repeat(40)));
        assert!(!is_git_revision(&"g".repeat(40)));
        assert!(PLATFORM_KEYS.contains(&current_platform()) || current_platform() == "unsupported");
    }

    const CATALOGS: &[&str] = &[
        include_str!("../../osg-engine-packages/delivery/engine-packages.delivery.json"),
        include_str!("../../osg-engine-packages/delivery/f5-models.delivery.json"),
        include_str!("../../osg-engine-packages/delivery/ui-fonts.delivery.json"),
        include_str!("../../osg-engine-packages/delivery/voice-samples.delivery.json"),
        include_str!("../../osg-native-tools/delivery/native-tools.delivery.json"),
        include_str!("../../osg-speech/delivery/speech-packages.delivery.json"),
    ];

    /// Every `"asset": "<name>"` value in a catalog, read without a JSON dependency.
    fn asset_names(catalog: &str) -> Vec<&str> {
        catalog
            .match_indices("\"asset\"")
            .filter_map(|(index, key)| {
                let rest = catalog[index + key.len()..]
                    .trim_start()
                    .strip_prefix(':')?;
                let rest = rest.trim_start().strip_prefix('"')?;
                rest.split('"').next()
            })
            .collect()
    }

    #[test]
    fn every_reviewed_catalog_asset_is_a_valid_asset_name() {
        let names: Vec<&str> = CATALOGS
            .iter()
            .flat_map(|catalog| asset_names(catalog))
            .collect();
        assert!(names.len() >= 70, "the catalogs declare their assets");
        for name in names {
            assert!(is_asset_name(name), "{name}");
        }
    }

    #[test]
    fn asset_names_refuse_traversal_options_and_oversized_values() {
        assert!(is_asset_name("ffmpeg-8.1.2-essentials_build.zip"));
        assert!(is_asset_name(&"a".repeat(200)));
        assert!(!is_asset_name(&"a".repeat(201)));
        for refused in [
            "",
            ".",
            "..",
            ".hidden",
            "-option",
            "dir/file.zip",
            "dir\\file.zip",
            "name+build.zip",
            "space name.zip",
            "unicod\u{e9}.zip",
        ] {
            assert!(!is_asset_name(refused), "{refused:?}");
        }
    }
}
