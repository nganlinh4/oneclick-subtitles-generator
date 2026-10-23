use std::collections::BTreeMap;

use osg_infrastructure::storage::Database;
use serde_json::json;

use super::is_main_window_close_request;
use super::main_window::{apply_automation_window_placement, has_valid_main_window_state};
use super::media_runtime::media_server_allowed_origins;
use super::webview_bootstrap::{
    is_safe_setting_key, is_webview_bootstrap_setting_key, settings_initialization_script,
    window_initialization_script,
};
use crate::font_readiness;
use crate::font_readiness::FontReadiness;

#[test]
fn automation_window_stays_renderable_without_entering_the_interactive_desktop() {
    let mut window = tauri::utils::config::WindowConfig {
        center: true,
        maximized: true,
        focus: true,
        ..Default::default()
    };

    apply_automation_window_placement(&mut window, true);

    assert_eq!(window.x, Some(-10_000.0));
    assert_eq!(window.y, Some(0.0));
    assert!(!window.center);
    assert!(!window.maximized);
    assert!(!window.visible);
    assert!(!window.focus);
    assert!(window.skip_taskbar);
    assert_eq!(
        window.prevent_overflow,
        Some(tauri::utils::config::PreventOverflowConfig::Enable(false))
    );
}

#[test]
fn records_only_native_close_requests_for_the_main_window() {
    assert!(is_main_window_close_request("main", true));
    assert!(!is_main_window_close_request("main", false));
    assert!(!is_main_window_close_request("secondary", true));
    assert!(!is_main_window_close_request("", true));
}

#[test]
fn recognizes_a_persisted_main_window_state() {
    assert!(has_valid_main_window_state(&json!({
        "main": {
            "width": 1400,
            "height": 900,
            "maximized": false
        }
    })));
    assert!(has_valid_main_window_state(&json!({
        "main": {
            "width": 1920,
            "height": 1080,
            "maximized": true
        }
    })));
}

#[test]
fn rejects_missing_or_incomplete_window_state() {
    for state in [
        json!({}),
        json!({ "main": {} }),
        json!({ "main": { "width": 0, "height": 900, "maximized": false } }),
        json!({ "main": { "width": 1400, "height": 0, "maximized": false } }),
        json!({ "main": { "width": 1400, "height": 900 } }),
    ] {
        assert!(!has_valid_main_window_state(&state));
    }
}

#[test]
fn release_media_origins_exclude_development_servers() {
    assert_eq!(
        media_server_allowed_origins(false),
        ["https://tauri.localhost", "tauri://localhost"]
    );
}

#[test]
fn development_media_origins_include_both_vite_hosts() {
    assert_eq!(
        media_server_allowed_origins(true),
        [
            "https://tauri.localhost",
            "tauri://localhost",
            "http://localhost:3030",
            "http://127.0.0.1:3030",
        ]
    );
}

#[test]
fn window_initialization_injects_only_in_memory_managed_font_css() {
    let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
    let record = readiness.mark_ready("v22-ui4".to_owned());
    let script = window_initialization_script(
        &BTreeMap::new(),
        Some("@font-face{font-family:'Google Sans';src:url(data:font/woff2;base64,AA==)}"),
        &record,
    )
    .expect("valid script");
    assert!(script.contains("osg-managed-ui-font"));
    assert!(script.contains("data:font/woff2;base64,AA=="));
    assert!(script.contains("readystatechange"));
    assert!(script.contains("DOMContentLoaded"));
    assert!(script.contains(r#""state":"ready""#));
    assert!(script.contains(r#""version":"v22-ui4""#));
    assert!(!script.contains("(document.head || document.documentElement).appendChild"));
    assert!(!script.contains("file://"));
    assert!(!script.contains("C:\\\\"));
}

/// The record must be assignable, because a repair that lands after startup has to replace it.
///
/// The previous bootstrap used `Object.defineProperty` with no writable flag, which is exactly
/// what made a late-installed font permanently unavailable for the session.
#[test]
fn window_initialization_publishes_a_replaceable_readiness_record() {
    let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
    let script = window_initialization_script(&BTreeMap::new(), None, &readiness.snapshot())
        .expect("valid script");
    assert!(script.contains("window.__OSG_FONT_READINESS__ ="));
    assert!(!script.contains("defineProperty"));
    assert!(script.contains(r#""state":"resolving""#));
    // Nothing has installed, so no stylesheet may be claimed.
    assert!(!script.contains("osg-managed-ui-font"));
}

/// A late repair must be able to replace a record that was already published.
///
/// Delivered by evaluating this script rather than by a Tauri event, because the `WebView` is
/// denied `core:event:listen`. The assignment must come before the announcement, or a listener
/// that reads the record on notification reads the previous one.
#[test]
fn a_late_readiness_publication_assigns_before_it_announces() {
    let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
    readiness.mark_refused(font_readiness::FontRefusal::TimedOut);
    let record = readiness.mark_ready("v22-ui4".to_owned());

    let script = super::startup::font_readiness_publish_script(&record).expect("valid script");
    let assignment = script
        .find("window.__OSG_FONT_READINESS__ =")
        .expect("assigns");
    let announcement = script.find("dispatchEvent").expect("announces");
    assert!(
        assignment < announcement,
        "the record must be current before it is announced"
    );
    assert!(script.contains(font_readiness::FONT_READINESS_EVENT));
    assert!(script.contains(r#""state":"ready""#));
    assert!(
        script.contains(r#""epoch":2"#),
        "a late record must carry the advanced epoch"
    );
}

#[test]
fn window_initialization_reports_a_refusal_with_its_typed_reason() {
    let readiness = FontReadiness::new(font_readiness::MANAGED_SUBTITLE_FAMILY);
    let record = readiness.mark_refused(font_readiness::FontRefusal::NoUsableSource);
    let script =
        window_initialization_script(&BTreeMap::new(), None, &record).expect("valid script");
    assert!(script.contains(r#""state":"refused""#));
    assert!(script.contains(r#""reason":"no-usable-source""#));
    assert!(script.contains(r#""retryable":true"#));
}

fn legacy_bootstrap_settings_fixture() -> BTreeMap<String, serde_json::Value> {
    BTreeMap::from([
        ("theme".to_owned(), json!("dark")),
        ("gemini_api_key".to_owned(), json!("never-injected")),
        ("gemini_max_tokens".to_owned(), json!(8192)),
        ("maxTokens".to_owned(), json!(4096)),
        ("tokenCount".to_owned(), json!(1024)),
        (
            "clientSecret".to_owned(),
            json!("never-injected-client-secret"),
        ),
        (
            "client.secret".to_owned(),
            json!("never-injected-dotted-secret"),
        ),
        (
            "client:secret".to_owned(),
            json!("never-injected-colon-secret"),
        ),
        (
            "accessToken".to_owned(),
            json!("never-injected-access-token"),
        ),
        (
            "refreshToken".to_owned(),
            json!("never-injected-refresh-token"),
        ),
        ("privateKey".to_owned(), json!("never-injected-private-key")),
        ("apiKey".to_owned(), json!("never-injected-api-key")),
        ("APIKey".to_owned(), json!("never-injected-acronym-api-key")),
        ("oauthToken".to_owned(), json!("never-injected-oauth-token")),
        (
            "current_file_url".to_owned(),
            json!("http://127.0.0.1:49152/asset/id?token=never-injected"),
        ),
        (
            "gemini_file_clip".to_owned(),
            json!({ "uri": "provider-private" }),
        ),
        (
            "osg.nativeNarrationAlignment.v1".to_owned(),
            json!({ "jobId": "stale-alignment", "request": { "private": true } }),
        ),
        (
            "osg.nativeNarrationJob.v1".to_owned(),
            json!({ "jobId": "stale-narration", "subtitles": ["private"] }),
        ),
        (
            "osg.nativeJobIds.v1".to_owned(),
            json!(["0198a8d7-dbf7-7ee0-a949-f13427fdd78a"]),
        ),
        (
            "user_provided_subtitles".to_owned(),
            json!("project-private"),
        ),
        (
            "original_subtitles_map".to_owned(),
            json!({ "1": { "text": "stale-project-subtitle-map" } }),
        ),
        (
            "gemini.keySelection.v1".to_owned(),
            json!({ "marker": "native-credential-selection" }),
        ),
        (
            "project.subtitleCacheIndex.v1".to_owned(),
            json!({ "marker": "native-project-index" }),
        ),
        (
            "project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d".to_owned(),
            json!({ "marker": "native-project-auxiliary" }),
        ),
        ("invalid key".to_owned(), json!(true)),
    ])
}

#[test]
fn initialization_script_hydrates_only_non_secret_legacy_settings() {
    let settings = legacy_bootstrap_settings_fixture();

    let script = settings_initialization_script(&settings).expect("valid script");

    assert!(script.contains("theme"));
    assert!(script.contains("gemini_max_tokens"));
    assert!(script.contains("maxTokens"));
    assert!(script.contains("tokenCount"));
    assert!(!script.contains("gemini_api_key"));
    assert!(!script.contains("never-injected"));
    for secret_key in [
        "clientSecret",
        "client.secret",
        "client:secret",
        "accessToken",
        "refreshToken",
        "privateKey",
        "apiKey",
        "APIKey",
        "oauthToken",
    ] {
        assert!(!script.contains(secret_key));
    }
    assert!(!script.contains("current_file_url"));
    assert!(!script.contains("gemini_file_clip"));
    assert!(!script.contains("provider-private"));
    assert!(!script.contains("osg.nativeNarrationAlignment.v1"));
    assert!(!script.contains("osg.nativeNarrationJob.v1"));
    assert!(!script.contains("osg.nativeJobIds.v1"));
    assert!(!script.contains("stale-alignment"));
    assert!(!script.contains("stale-narration"));
    assert!(!script.contains("user_provided_subtitles"));
    assert!(!script.contains("project-private"));
    assert!(script.contains("localStorage.removeItem('original_subtitles_map')"));
    assert_eq!(script.matches("original_subtitles_map").count(), 1);
    assert!(!script.contains("stale-project-subtitle-map"));
    assert!(!script.contains("gemini.keySelection.v1"));
    assert!(!script.contains("native-credential-selection"));
    assert!(!script.contains("project.subtitleCacheIndex.v1"));
    assert!(!script.contains("native-project-index"));
    assert!(!script.contains("project.legacyAux.v1."));
    assert!(!script.contains("native-project-auxiliary"));
    assert!(!script.contains("invalid key"));
}

#[test]
fn initialization_script_makes_native_preferences_authoritative_after_a_crash() {
    let script = settings_initialization_script(&BTreeMap::from([(
        "theme".to_owned(),
        json!("committed-native-theme"),
    )]))
    .expect("valid script");

    assert!(script.contains("current_settings_bootstrap_v1"));
    assert!(script.contains("current_native_settings_keys_v1"));
    assert!(script.contains("committed-native-theme"));
    assert!(!script.contains("localStorage.getItem(key) === null"));
    assert_eq!(
        script.matches("localStorage.setItem(key, stored)").count(),
        1
    );
    assert!(script.contains("localStorage.removeItem(marker)"));
}

#[test]
fn initialization_script_removes_only_valid_previously_native_keys() {
    let script = settings_initialization_script(&BTreeMap::new()).expect("valid script");

    assert!(script.contains("Array.isArray(parsed)"));
    assert!(script.contains("/^[A-Za-z0-9._:-]{1,128}$/"));
    assert!(script.contains("!key.startsWith('current_')"));
    assert!(script.contains("if (!currentKeySet.has(key)) localStorage.removeItem(key)"));
    assert!(script.contains("localStorage.setItem(indexKey, JSON.stringify(currentKeys))"));
}

#[test]
fn safe_key_detection_matches_the_database_boundary() {
    assert!(is_safe_setting_key("subtitle.editor:zoom-v2"));
    for safe_key in [
        "gemini_max_tokens",
        "maxTokens",
        "tokenCount",
        "use_cookies_for_download",
        "download_cookie_source",
    ] {
        assert!(is_safe_setting_key(safe_key));
    }
    assert!(!is_safe_setting_key("../../secret"));
    assert!(!is_safe_setting_key("youtube_refresh_token"));
    for secret_key in [
        "clientSecret",
        "client.secret",
        "client:secret",
        "accessToken",
        "refreshToken",
        "privateKey",
        "apiKey",
        "APIKey",
        "oauthToken",
    ] {
        assert!(!is_safe_setting_key(secret_key));
    }
    assert!(!is_safe_setting_key("gemini_active_key_index"));
    assert!(!is_safe_setting_key("osg.nativeNarrationJob.v1"));
    assert!(!is_safe_setting_key("osg.nativeJobIds.v1"));
    assert!(!is_safe_setting_key("current_settings_bootstrap_v1"));
    assert!(!is_safe_setting_key("current_native_settings_keys_v1"));
    assert!(!is_safe_setting_key("user_provided_subtitles"));
    assert!(!is_safe_setting_key("original_subtitles_map"));
    for native_owned_key in [
        "gemini.keySelection.v1",
        "project.subtitleCacheIndex.v1",
        "project.legacyAux.v1.019ffbea-26d5-7800-8e3b-69de8bff2d7d",
    ] {
        assert!(is_safe_setting_key(native_owned_key));
        assert!(!is_webview_bootstrap_setting_key(native_owned_key));
    }
    assert!(is_webview_bootstrap_setting_key("subtitle.editor:zoom-v2"));
}

#[test]
fn saved_preferences_survive_relaunch_and_reach_the_fresh_webview_bootstrap() {
    let directory = tempfile::tempdir().expect("temporary application data");
    let database_path = directory.path().join("db/osg.sqlite3");
    {
        let database = Database::open(&database_path).expect("open settings database");
        database
            .put_settings(
                "app",
                &BTreeMap::from([
                    ("theme".to_owned(), json!("dark")),
                    ("use_cookies_for_download".to_owned(), json!("true")),
                    ("download_cookie_source".to_owned(), json!("firefox")),
                ]),
            )
            .expect("save the settings snapshot");
    }

    let reopened = Database::open(&database_path).expect("reopen settings database");
    let settings = reopened
        .list_settings("app")
        .expect("load settings after relaunch");
    let script = settings_initialization_script(&settings).expect("fresh bootstrap script");

    assert!(script.contains("use_cookies_for_download"));
    assert!(script.contains("download_cookie_source"));
    assert!(script.contains("firefox"));
    assert!(script.contains("theme"));
    assert!(script.contains("dark"));
}
