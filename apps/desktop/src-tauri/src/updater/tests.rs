use base64::{Engine as _, engine::general_purpose::STANDARD};
use time::macros::datetime;

use super::{
    AppUpdateEvent, AppUpdateRuntime, MAX_RELEASE_NOTES_UTF16_UNITS, UPDATE_SIGNING_PUBLIC_KEY,
    UpdateChannelState, bounded_text, format_published_at, has_configured_signing_key,
    is_bounded_version, is_valid_signing_key, update_channel_state,
};

/// The public key printed in Tauri's own updater documentation.
///
/// It is a structurally perfect minisign key, which is the entire problem: its private half is
/// published alongside it, so anything it verifies can be signed by anyone who has read the
/// docs. It is used below both as the positive fixture for structural validation and as the
/// thing the shipped key must never be.
const PUBLISHED_EXAMPLE_KEY: &str = concat!(
    "untrusted comment: minisign public key 17620F91860D0F62\n",
    "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n",
);

#[test]
fn signing_key_validation_is_strict_and_never_accepts_the_placeholder() {
    assert!(!is_valid_signing_key(""));
    assert!(!is_valid_signing_key("UNCONFIGURED"));
    assert!(!is_valid_signing_key(&"A".repeat(44)));
    assert!(!is_valid_signing_key(
        &STANDARD.encode("not a minisign key")
    ));
    assert!(is_valid_signing_key(
        &STANDARD.encode(PUBLISHED_EXAMPLE_KEY)
    ));
    assert!(!is_valid_signing_key(
        &STANDARD.encode(format!("{PUBLISHED_EXAMPLE_KEY}extra\n"))
    ));
}

/// The three channel states mean three different things and must not be collapsed.
///
/// `Disabled` and `Unconfigured` both return `configured: false` to the editor, which is why
/// their DIAGNOSTIC words have to differ: one records a build that was never meant to update,
/// the other a build that was meant to and cannot verify what it would download. Reporting the
/// second when the first is true is how "the updater is broken" gets into a bug report about a
/// build that is behaving exactly as designed.
#[test]
fn the_quiescent_outcomes_are_distinct_and_only_enabled_may_reach_the_network() {
    assert_eq!(
        UpdateChannelState::Disabled.quiescent_outcome(),
        Some("disabled")
    );
    assert_eq!(
        UpdateChannelState::Unconfigured.quiescent_outcome(),
        Some("unconfigured")
    );
    // `Enabled` deliberately has no pre-decided outcome: its result is whatever the check
    // returns, and a word here would let a caller report one before there is one.
    assert_eq!(UpdateChannelState::Enabled.quiescent_outcome(), None);

    assert!(UpdateChannelState::Enabled.may_check());
    assert!(!UpdateChannelState::Disabled.may_check());
    assert!(!UpdateChannelState::Unconfigured.may_check());

    // Every state either names a quiescent outcome or may check, never both and never neither.
    for state in [
        UpdateChannelState::Disabled,
        UpdateChannelState::Unconfigured,
        UpdateChannelState::Enabled,
    ] {
        assert_eq!(
            state.quiescent_outcome().is_none(),
            state.may_check(),
            "{state:?} must either stop before the network or be allowed onto it"
        );
    }
}

/// This build's channel is the one its features say it is.
///
/// Written as a cfg fork rather than a single expectation so it is meaningful in BOTH builds:
/// an ordinary or production build must be `Enabled` because the shipped key is real, and the
/// local-test build must be `Disabled` even though that same key is still compiled in. The
/// second half is the load-bearing one — it proves the feature wins over a valid key rather
/// than depending on the key being absent, which is the mistake the handoff warns against.
#[test]
fn the_compiled_channel_matches_this_builds_features() {
    if cfg!(any(
        feature = "unsigned-local-build",
        feature = "e2e-automation"
    )) {
        assert_eq!(update_channel_state(), UpdateChannelState::Disabled);
        assert!(
            has_configured_signing_key(),
            "the local-test channel must be disabled by its FEATURE, not by a missing key"
        );
    } else {
        assert_eq!(update_channel_state(), UpdateChannelState::Enabled);
        assert!(update_channel_state().may_check());
    }
}

#[test]
fn the_shipped_key_is_configured_so_updates_are_actually_verified() {
    // An unconfigured or malformed key makes `updater_plugin` pass an empty pubkey, and the
    // plugin's unconditional `verify_signature` then fails to decode it, so every update is
    // refused. That is the safe direction, but it is silent: the app would simply stop being
    // updatable and nothing would say why. Assert the shipped state deliberately.
    assert!(
        has_configured_signing_key(),
        "updater-public-key.txt does not contain a usable minisign public key, so the app \
             cannot install any update"
    );
}

#[test]
fn the_shipped_key_is_not_a_published_example_key() {
    // Structural validity is not trust. A key copied from documentation or a tutorial passes
    // every check in `is_valid_signing_key` while letting anyone who has read that page sign an
    // update this app would install and execute.
    let shipped = UPDATE_SIGNING_PUBLIC_KEY.trim();
    let decoded = STANDARD
        .decode(shipped)
        .expect("the shipped key must be base64");
    let envelope = String::from_utf8(decoded).expect("the shipped key must be UTF-8");

    assert_ne!(
        envelope, PUBLISHED_EXAMPLE_KEY,
        "the shipped updater key is the one published in Tauri's documentation, whose private \
             half is public"
    );
    assert_ne!(
        shipped,
        STANDARD.encode(PUBLISHED_EXAMPLE_KEY),
        "the shipped updater key is the one published in Tauri's documentation, whose private \
             half is public"
    );

    // The key body, not the comment line, is what actually verifies signatures — a renamed
    // comment above a published key body would still be a published key.
    let shipped_body = envelope
        .lines()
        .nth(1)
        .expect("a minisign public key has a body line");
    let example_body = PUBLISHED_EXAMPLE_KEY
        .lines()
        .nth(1)
        .expect("a minisign public key has a body line");
    assert_ne!(
        shipped_body, example_body,
        "the shipped updater key body is a published example key"
    );
}

/// A disposable key generated only to prove verification actually rejects things.
///
/// Its private half was never committed and is not needed again: the signature below is
/// checked in, not regenerated. Nothing in the product trusts this key.
const THROWAWAY_TEST_KEY: &str = concat!(
    "untrusted comment: minisign public key: F315DA75492BFAD3\n",
    "RWTT+itJddoV84JJ57tapwhHxaxQd5w/npk+gUJwsXDgblqMvajULIfC\n",
);

/// `THROWAWAY_TEST_KEY`'s signature over exactly [`SIGNED_PAYLOAD`].
const THROWAWAY_TEST_SIGNATURE: &str = concat!(
    "untrusted comment: signature from tauri secret key\n",
    "RUTT+itJddoV85kvq9xTWpNXY0nDqIkIWiScXgzwpaDjX7KbPCixXTPj+4tZ5P+a5QphyzUvCuTbmBB9ghz1VpjXr/FutoMrTwU=\n",
    "trusted comment: timestamp:1786819293\tfile:payload.bin\n",
    "tW2Y8erUAvQ0L3dWDvdAR+9Q60JhnvBziAWEFxZu2G2PlKxIVW9f7Q9FDGtJAouXsInr3Jzsi/oQ934l3DiUCQ==\n",
);

const SIGNED_PAYLOAD: &[u8] = b"osg-updater-tamper-fixture-v1";

/// The plugin's own check, reproduced so this test fails if that behaviour ever changes.
///
/// `tauri_plugin_updater` calls its private `verify_signature` unconditionally on every
/// downloaded artifact. We cannot call it directly, so we exercise the same two primitives it
/// uses, in the same order, against the same crate version.
fn plugin_style_verify(payload: &[u8], signature: &str, public_key: &str) -> bool {
    use minisign_verify::{PublicKey, Signature};

    let Ok(key) = PublicKey::decode(public_key) else {
        return false;
    };
    let Ok(signature) = Signature::decode(signature) else {
        return false;
    };
    key.verify(payload, &signature, true).is_ok()
}

#[test]
fn an_untampered_artifact_verifies() {
    // The control. Without this passing, the rejection tests below would prove nothing — they
    // would pass even if verification rejected everything unconditionally.
    assert!(plugin_style_verify(
        SIGNED_PAYLOAD,
        THROWAWAY_TEST_SIGNATURE,
        THROWAWAY_TEST_KEY
    ));
}

#[test]
fn a_tampered_artifact_is_refused() {
    // The case that matters. An attacker who can modify the download but not the signature must
    // not be able to get code executed, and every single byte must be covered — a signature
    // over only a prefix or a length would pass the control test above while leaving the tail
    // of an installer freely rewritable.
    for index in [0, SIGNED_PAYLOAD.len() / 2, SIGNED_PAYLOAD.len() - 1] {
        let mut tampered = SIGNED_PAYLOAD.to_vec();
        tampered[index] ^= 0x01;
        assert!(
            !plugin_style_verify(&tampered, THROWAWAY_TEST_SIGNATURE, THROWAWAY_TEST_KEY),
            "a flipped bit at byte {index} was accepted"
        );
    }

    // Truncation and extension are modifications too.
    assert!(!plugin_style_verify(
        &SIGNED_PAYLOAD[..SIGNED_PAYLOAD.len() - 1],
        THROWAWAY_TEST_SIGNATURE,
        THROWAWAY_TEST_KEY
    ));
    assert!(!plugin_style_verify(
        &[SIGNED_PAYLOAD, b"trailing"].concat(),
        THROWAWAY_TEST_SIGNATURE,
        THROWAWAY_TEST_KEY
    ));
    assert!(!plugin_style_verify(
        b"",
        THROWAWAY_TEST_SIGNATURE,
        THROWAWAY_TEST_KEY
    ));
}

#[test]
fn a_malformed_or_forged_signature_is_refused() {
    for signature in [
        "",
        "not base64 at all",
        &STANDARD.encode("untrusted comment: nope\n"),
        &THROWAWAY_TEST_SIGNATURE.replace("RUTT", "RUTU"),
    ] {
        assert!(
            !plugin_style_verify(SIGNED_PAYLOAD, signature, THROWAWAY_TEST_KEY),
            "a malformed signature was accepted: {signature:?}"
        );
    }
}

#[test]
fn a_valid_signature_from_the_wrong_key_is_refused() {
    // This is what protects users if the signing key is ever rotated or compromised: a
    // perfectly valid signature made by any other key must still be refused by a build that
    // trusts only the key baked into it.
    let shipped = String::from_utf8(
        STANDARD
            .decode(UPDATE_SIGNING_PUBLIC_KEY.trim())
            .expect("the shipped key must be base64"),
    )
    .expect("the shipped key must be UTF-8");

    assert!(!plugin_style_verify(
        SIGNED_PAYLOAD,
        THROWAWAY_TEST_SIGNATURE,
        &shipped
    ));
    assert!(!plugin_style_verify(
        SIGNED_PAYLOAD,
        THROWAWAY_TEST_SIGNATURE,
        PUBLISHED_EXAMPLE_KEY
    ));
}

#[test]
fn release_notes_match_the_frontend_utf16_bound_without_splitting_unicode() {
    let notes = format!(
        "{}🦀overflow",
        "a".repeat(MAX_RELEASE_NOTES_UTF16_UNITS - 2)
    );
    let bounded = bounded_text(&notes, MAX_RELEASE_NOTES_UTF16_UNITS);

    assert_eq!(
        bounded.encode_utf16().count(),
        MAX_RELEASE_NOTES_UTF16_UNITS
    );
    assert!(bounded.ends_with('🦀'));
    assert!(!bounded.contains("overflow"));
}

#[test]
fn published_dates_are_emitted_as_frontend_compatible_rfc3339() {
    assert_eq!(
        format_published_at(datetime!(2026-08-12 12:36:11.123456789 UTC)).unwrap(),
        "2026-08-12T12:36:11.123456789Z"
    );
}

#[test]
fn progress_events_use_the_exact_camel_case_webview_contract() {
    assert_eq!(
        serde_json::to_value(AppUpdateEvent::Progress {
            downloaded_bytes: 25,
            total_bytes: Some(100),
            basis_points: Some(2_500),
        })
        .unwrap(),
        serde_json::json!({
            "event": "progress",
            "downloadedBytes": 25,
            "totalBytes": 100,
            "basisPoints": 2_500,
        })
    );
}

#[test]
fn update_runtime_serializes_operations_and_cancels_only_the_exact_version() {
    let runtime = AppUpdateRuntime::default();
    let cancellation = runtime.begin("1.0.1").unwrap();
    assert!(runtime.begin("1.0.2").is_err());
    assert!(!runtime.cancel("1.0.2").unwrap());
    assert!(!cancellation.is_cancelled());
    assert!(runtime.cancel("1.0.1").unwrap());
    assert!(cancellation.is_cancelled());
    runtime.finish("1.0.1").unwrap();
    assert!(runtime.begin("1.0.2").is_ok());
}

#[test]
fn expected_versions_are_bounded_before_the_network_is_touched() {
    assert!(is_bounded_version("1.0.0-rc.1"));
    assert!(!is_bounded_version(""));
    assert!(!is_bounded_version("../../installer.exe"));
    assert!(!is_bounded_version(&"1".repeat(65)));
}
