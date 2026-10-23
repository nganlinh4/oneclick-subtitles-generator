use super::harness_env::{
    automation_browser_arguments, validate_harness_environment, validate_webdriver_environment,
};
use super::placement::{PixelRect, offscreen_placement, virtual_desktop_bounds};
use super::run_root::{ManagedStagingEnvironment, validate_isolated_directory};

struct ManagedHarnessFixture {
    _enclosing: tempfile::TempDir,
    run: std::path::PathBuf,
    webview: std::path::PathBuf,
    staging: ManagedStagingEnvironment,
}

fn managed_harness_fixture() -> ManagedHarnessFixture {
    let enclosing = tempfile::tempdir().expect("managed cache fixture");
    let cache_root = enclosing.path().join("cache");
    let staging_root = cache_root.join("staging");
    let run = staging_root.join("osg-e2e-run-fixture");
    std::fs::create_dir_all(&run).expect("managed run root");
    for child in [
        "data", "cache", "logs", "webview", "evidence", "input", "output",
    ] {
        std::fs::create_dir(run.join(child)).expect("private run directory");
    }
    let root_id = "1".repeat(32);
    let lease_id = "2".repeat(32);
    let authorization = "3".repeat(64);
    let process_created_utc = "2026-08-26T01:02:03.0000000Z";
    std::fs::write(
        cache_root.join(".osg-development-cache.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "owner": "oneclick-subtitles-generator",
            "cacheKind": "development-cache",
            "rootId": root_id,
        }))
        .expect("root marker JSON"),
    )
    .expect("root marker");
    std::fs::write(
        staging_root.join(".osg-cache-entry.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "owner": "oneclick-subtitles-generator",
            "rootId": root_id,
            "lane": "staging",
        }))
        .expect("entry marker JSON"),
    )
    .expect("entry marker");
    std::fs::write(
        staging_root.join(".osg-cache-lease"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "owner": "oneclick-subtitles-generator",
            "rootId": root_id,
            "laneGroup": "staging",
            "leaseId": lease_id,
            "processId": 4242,
            "processCreatedUtc": process_created_utc,
        }))
        .expect("lease marker JSON"),
    )
    .expect("lease marker");
    let canonical_cache = cache_root.canonicalize().expect("canonical cache");
    let canonical_staging = staging_root.canonicalize().expect("canonical staging");
    std::fs::write(
        run.join(".osg-e2e-staging-parent"),
        format!("{}\n", canonical_staging.display()),
    )
    .expect("parent marker");
    std::fs::write(run.join(".osg-e2e-authority"), &authorization).expect("run authority");
    std::fs::write(
        run.join(".osg-e2e-staging-authority.json"),
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "managed": true,
            "owner": "oneclick-subtitles-generator",
            "rootId": root_id,
            "cacheRoot": canonical_cache,
            "stagingRoot": canonical_staging,
            "leaseId": lease_id,
            "leaseOwnerProcessId": 4242,
            "leaseOwnerProcessCreatedUtc": process_created_utc,
        }))
        .expect("run staging authority JSON"),
    )
    .expect("run staging authority");
    ManagedHarnessFixture {
        webview: run.join("webview"),
        run,
        staging: ManagedStagingEnvironment {
            cache_root,
            cache_root_id: root_id,
            staging_root,
            lease_id,
            lease_owner_process_id: 4242,
            lease_owner_process_created_utc: process_created_utc.to_owned(),
            run_root_authorization: authorization,
        },
        _enclosing: enclosing,
    }
}

#[test]
fn unions_the_complete_multi_monitor_virtual_desktop() {
    let bounds = virtual_desktop_bounds([
        (0, 0, 1920, 1080),
        (-2560, -240, 2560, 1440),
        (1920, 120, 3840, 2160),
    ])
    .expect("the fixtures contain usable monitors");

    assert_eq!(
        bounds,
        PixelRect {
            left: -2560,
            top: -240,
            right: 5760,
            bottom: 2280,
        }
    );
}

#[test]
fn moves_left_of_a_monitor_that_already_occupies_the_old_fixed_coordinate() {
    let bounds = virtual_desktop_bounds([(-12_000, 0, 16_000, 2160)])
        .expect("the fixture is a usable virtual desktop");
    let placement = offscreen_placement(bounds, 1416).expect("a safe placement exists");

    assert_eq!(placement.x, -13_480);
    assert_eq!(placement.y, 0);
    assert!(i64::from(placement.x) + 1416 < bounds.left);
}

#[test]
fn keeps_conventional_desktops_behind_the_harness_safety_edge() {
    let bounds = virtual_desktop_bounds([(0, 0, 1920, 1080)])
        .expect("the fixture is a usable virtual desktop");
    let placement = offscreen_placement(bounds, 1416).expect("a safe placement exists");

    assert_eq!(placement.x, -11_480);
    assert!(i64::from(placement.x) + 1416 < -10_000);
}

#[test]
fn refuses_missing_monitors_and_impossible_coordinates() {
    assert_eq!(virtual_desktop_bounds([]), None);
    let extreme = PixelRect {
        left: i64::from(i32::MIN),
        top: 0,
        right: i64::from(i32::MIN) + 1,
        bottom: 1,
    };
    assert!(offscreen_placement(extreme, 1416).is_err());
}

#[test]
fn harness_environment_is_exactly_bounded_to_one_managed_staging_lease() {
    let fixture = managed_harness_fixture();

    validate_harness_environment(
        &fixture.run,
        &fixture.run,
        &fixture.webview,
        true,
        false,
        &fixture.staging,
    )
    .expect("the harness shape is valid");

    let outside = tempfile::tempdir().expect("outside root");
    assert!(
        validate_harness_environment(
            &fixture.run,
            outside.path(),
            &fixture.webview,
            true,
            false,
            &fixture.staging,
        )
        .is_err()
    );
    assert!(
        validate_harness_environment(
            &fixture.run,
            &fixture.run,
            &fixture.webview,
            false,
            false,
            &fixture.staging,
        )
        .is_err()
    );
    assert!(
        validate_harness_environment(
            &fixture.run,
            &fixture.run,
            &fixture.webview,
            true,
            true,
            &fixture.staging,
        )
        .is_err()
    );

    let mut wrong_lease = managed_harness_fixture();
    wrong_lease.staging.lease_id = "4".repeat(32);
    assert!(
        validate_harness_environment(
            &wrong_lease.run,
            &wrong_lease.run,
            &wrong_lease.webview,
            true,
            false,
            &wrong_lease.staging,
        )
        .is_err()
    );
}

#[test]
fn harness_environment_rejects_a_live_or_redirected_profile() {
    let fixture = managed_harness_fixture();
    let enclosing = tempfile::tempdir().expect("non-harness root");
    let root = enclosing.path().join("osg-e2e-lookalike");
    let webview = root.join("webview");
    std::fs::create_dir_all(&webview).expect("lookalike profile");
    assert!(
        validate_harness_environment(&root, &root, &webview, true, false, &fixture.staging,)
            .is_err()
    );

    assert!(
        validate_harness_environment(
            &fixture.run,
            &fixture.run,
            &webview,
            true,
            false,
            &fixture.staging,
        )
        .is_err()
    );

    let redirected = tempfile::tempdir().expect("redirected data target");
    assert!(
        validate_isolated_directory(
            &fixture.run.canonicalize().expect("canonical run"),
            "data",
            &redirected.path().canonicalize().expect("redirect target"),
            true,
        )
        .is_err()
    );
}

#[test]
fn automation_owns_a_closed_browser_argument_set() {
    assert_eq!(
        automation_browser_arguments(),
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --mute-audio"
    );
}

#[test]
fn webdriver_environment_refuses_fixed_ports_and_unidentified_launches() {
    let identity = "a".repeat(64);
    let authorization = "b".repeat(64);
    validate_webdriver_environment(
        Some("true"),
        Some("55123"),
        Some(&identity),
        Some(&authorization),
    )
    .expect("the guarded binding shape is valid");
    assert!(
        validate_webdriver_environment(
            Some("true"),
            Some("4445"),
            Some(&identity),
            Some(&authorization),
        )
        .is_err()
    );
    assert!(
        validate_webdriver_environment(
            Some("true"),
            Some("55123"),
            Some("ABC"),
            Some(&authorization),
        )
        .is_err()
    );
    assert!(
        validate_webdriver_environment(None, Some("55123"), Some(&identity), Some(&authorization),)
            .is_err()
    );
    assert!(
        validate_webdriver_environment(
            Some("true"),
            Some("55123"),
            Some(&identity),
            Some(&identity),
        )
        .is_err()
    );
}
