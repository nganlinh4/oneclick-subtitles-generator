//! Ignored live lifecycles against the real reviewed upstream releases.

use std::process::Command;

use super::*;

#[test]
#[ignore = "downloads, executes, and removes the current official yt-dlp release"]
fn live_ytdlp_installs_executes_reuses_and_removes() {
    live_tool_lifecycle(
        NativeToolId::YtDlp,
        &[(ExecutableRole::YtDlp, &["--version"], true)],
    );
}

#[test]
#[ignore = "downloads, executes, and removes the reviewed Deno release"]
fn live_deno_installs_executes_reuses_and_removes() {
    live_tool_lifecycle(
        NativeToolId::Deno,
        &[(ExecutableRole::Deno, &["--version"], false)],
    );
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "downloads, executes, and removes the reviewed Windows FFmpeg release"]
fn live_media_tools_install_execute_reuse_and_remove() {
    live_tool_lifecycle(
        NativeToolId::MediaTools,
        &[
            (ExecutableRole::Ffmpeg, &["-version"], false),
            (ExecutableRole::Ffprobe, &["-version"], false),
        ],
    );
}

fn live_tool_lifecycle(tool: NativeToolId, commands: &[(ExecutableRole, &[&str], bool)]) {
    let temp = tempfile::tempdir().unwrap();
    let coordinator = Arc::new(TestCoordinator::default());
    let manager = NativeToolManager::new(temp.path(), coordinator.clone()).unwrap();
    let cancellation = CancellationToken::default();
    // A second real fetch after removal covers hot reinstall and connection reuse, not
    // merely the already-installed fast path that made the first lifecycle look complete.
    for round in 0..2 {
        let progress = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&progress);
        let installed = manager
            .install(tool, &cancellation, &move |value| {
                observed.lock().unwrap().push(value);
            })
            .unwrap();
        assert_eq!(installed.state, NativeToolState::Installed);
        assert!(!progress.lock().unwrap().is_empty());

        let lease = manager.resolve(tool, &cancellation).unwrap();
        for (role, arguments, exact_version) in commands {
            let output = Command::new(lease.executable(*role).unwrap())
                .args(*arguments)
                .output()
                .unwrap();
            assert!(output.status.success());
            let stdout = String::from_utf8(output.stdout).unwrap();
            let stderr = String::from_utf8(output.stderr).unwrap();
            let version_output = format!("{stdout}\n{stderr}");
            if *exact_version {
                assert_eq!(version_output.trim(), lease.version());
            } else {
                assert!(version_output.contains(lease.version()));
                assert!(version_output.to_ascii_lowercase().contains(role.as_str()));
            }
        }
        drop(lease);

        progress.lock().unwrap().clear();
        let observed = Arc::clone(&progress);
        assert_eq!(
            manager
                .install(tool, &cancellation, &move |value| {
                    observed.lock().unwrap().push(value);
                })
                .unwrap()
                .state,
            NativeToolState::Installed
        );
        assert!(
            progress.lock().unwrap().is_empty(),
            "a verified current tool install must be reused without another download"
        );
        assert_eq!(
            manager.remove(tool, &cancellation, &|_| {}).unwrap(),
            RemovalOutcome::Removed
        );
        assert_eq!(manager.status(tool).state, NativeToolState::Missing);
        assert_eq!(coordinator.0.load(Ordering::Relaxed), 2 * (round + 1));
    }
}
