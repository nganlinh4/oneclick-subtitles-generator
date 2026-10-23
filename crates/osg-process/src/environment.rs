//! The environment a child process starts with.
//!
//! Children never inherit the app's environment wholesale: it can carry credentials, automation
//! authority, or interpreter injection (`PYTHONPATH`, `PYTHONHOME`). [`isolate`] clears it and
//! copies back only the named variables the operating system and the tool runtimes genuinely need.
//! Callers then add their own fixed values with `Command::env`.

use std::process::Command;

/// Needed by every child: Windows process start-up (Winsock, crypto, and DLL loading read
/// `SystemRoot`), temp directories, user profile and app-data locations, and the Unix equivalents.
pub const ESSENTIAL: &[&str] = &[
    // Windows
    "SystemRoot",
    "SystemDrive",
    "windir",
    "ComSpec",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERNAME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "CommonProgramFiles",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "OS",
    // Unix
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    // Linux desktop keyrings, which yt-dlp needs to decrypt browser cookies.
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_CURRENT_DESKTOP",
    "DESKTOP_SESSION",
];

/// For children that reach the network: the user's proxy and certificate configuration.
pub const NETWORK: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

/// For model workers: which GPU to use and how its allocator behaves.
pub const GPU: &[&str] = &["CUDA_VISIBLE_DEVICES", "PYTORCH_CUDA_ALLOC_CONF"];

/// Clears `command`'s environment and copies back only [`ESSENTIAL`] plus every name in `extra`
/// that is set in this process.
pub fn isolate(command: &mut Command, extra: &[&[&str]]) {
    command.env_clear();
    for name in allowlist(extra) {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

/// Every variable name [`isolate`] may copy for the given extra groups.
pub fn allowlist<'a>(extra: &'a [&'a [&'a str]]) -> impl Iterator<Item = &'a str> {
    ESSENTIAL
        .iter()
        .chain(extra.iter().flat_map(|group| group.iter()))
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    const PROBE: &str = "OSG_PROCESS_ENVIRONMENT_PROBE";
    const ADDITION: &str = "OSG_PROCESS_EXPLICIT_ADDITION";

    fn normalized(name: &str) -> String {
        if cfg!(windows) {
            name.to_ascii_uppercase()
        } else {
            name.to_owned()
        }
    }

    /// Runs only inside the child started by the test below and reports its environment.
    #[test]
    fn print_environment_probe() {
        if std::env::var_os(PROBE).is_none() {
            return;
        }
        for (name, _) in std::env::vars_os() {
            println!("ENV\t{}", name.to_string_lossy());
        }
    }

    #[test]
    fn a_spawned_child_sees_exactly_the_allowlist_plus_explicit_additions() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "environment::tests::print_environment_probe",
            "--nocapture",
            "--test-threads=1",
        ]);
        isolate(&mut command, &[NETWORK, GPU]);
        command.env(PROBE, "1").env(ADDITION, "value");
        let output = command.output().unwrap();
        assert!(output.status.success());

        let observed = String::from_utf8_lossy(&output.stdout)
            .lines()
            // libtest prints the test name on the same line as the first output line.
            .filter_map(|line| line.split_once("ENV\t").map(|(_, name)| name))
            .map(normalized)
            .collect::<BTreeSet<_>>();
        let expected = allowlist(&[NETWORK, GPU])
            .filter(|name| std::env::var_os(name).is_some())
            .chain([PROBE, ADDITION])
            .map(normalized)
            .collect::<BTreeSet<_>>();
        assert_eq!(observed, expected);
        // Cargo sets these for every test process, so the parent environment really was cleared.
        assert!(std::env::var_os("CARGO_PKG_NAME").is_some());
        assert!(!observed.contains(&normalized("CARGO_PKG_NAME")));
    }

    #[test]
    fn the_allowlist_carries_no_credentials_automation_authority_or_interpreter_injection() {
        for name in allowlist(&[NETWORK, GPU]) {
            let upper = name.to_ascii_uppercase();
            assert!(
                ![
                    "KEY",
                    "TOKEN",
                    "SECRET",
                    "PASSWORD",
                    "OSG_",
                    "WDIO",
                    "WEBDRIVER",
                    "TAURI"
                ]
                .iter()
                .any(|fragment| upper.contains(fragment)),
                "{name}"
            );
            assert!(!upper.starts_with("PYTHON"), "{name}");
        }
    }
}
