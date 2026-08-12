#![cfg(feature = "ci-updater-fixture")]

use std::ffi::OsString;
use std::sync::OnceLock;

const DEBUG_PORT_ARGUMENT_PREFIX: &str = "--osg-ci-updater-debug-port=";
const WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";
static CONFIGURATION: OnceLock<Configuration> = OnceLock::new();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct Configuration {
    debug_port: Option<u16>,
}

impl Configuration {
    fn from_process_arguments() -> Result<Self, &'static str> {
        Self::from_arguments(std::env::args_os().skip(1))
    }

    fn from_arguments(arguments: impl IntoIterator<Item = OsString>) -> Result<Self, &'static str> {
        let arguments = arguments.into_iter().collect::<Vec<_>>();
        if arguments.is_empty() {
            return Ok(Self { debug_port: None });
        }
        if arguments.len() != 1 {
            return Err("exactly zero or one CI updater fixture argument is allowed");
        }
        let argument = arguments[0]
            .to_str()
            .ok_or("the CI updater fixture argument must be valid Unicode")?;
        let value = argument
            .strip_prefix(DEBUG_PORT_ARGUMENT_PREFIX)
            .ok_or("the CI updater fixture argument name is invalid")?;
        if value.len() < 4
            || value.len() > 5
            || !value.bytes().all(|byte| byte.is_ascii_digit())
            || value.starts_with('0')
        {
            return Err("the CI updater fixture port must use canonical decimal digits");
        }
        let debug_port = value
            .parse::<u16>()
            .map_err(|_| "the CI updater fixture port is out of range")?;
        if debug_port < 1024 {
            return Err("the CI updater fixture port must be unprivileged");
        }
        Ok(Self {
            debug_port: Some(debug_port),
        })
    }

    pub(super) fn browser_arguments(self) -> Option<String> {
        self.debug_port.map(|port| {
            format!("{WEBVIEW2_DEFAULT_BROWSER_ARGUMENTS} --remote-debugging-port={port}")
        })
    }

    pub(super) const fn enables_webview_debugging(self) -> bool {
        self.debug_port.is_some()
    }
}

pub(super) fn initialize_from_process_arguments() -> Result<(), &'static str> {
    let configuration = Configuration::from_process_arguments()?;
    CONFIGURATION
        .set(configuration)
        .map_err(|_| "the CI updater fixture was initialized more than once")
}

pub(super) fn configuration() -> Configuration {
    *CONFIGURATION
        .get()
        .expect("the CI updater fixture must be initialized before Tauri")
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::{Configuration, DEBUG_PORT_ARGUMENT_PREFIX};

    fn parse(arguments: &[&str]) -> Result<Configuration, &'static str> {
        Configuration::from_arguments(arguments.iter().map(OsString::from))
    }

    #[test]
    fn accepts_no_fixture_argument_or_one_canonical_unprivileged_port() {
        assert_eq!(parse(&[]), Ok(Configuration { debug_port: None }));
        for port in [1024_u16, 49_152, 65_535] {
            let argument = format!("{DEBUG_PORT_ARGUMENT_PREFIX}{port}");
            let configuration =
                Configuration::from_arguments([OsString::from(argument)]).expect("canonical port");
            assert_eq!(configuration.debug_port, Some(port));
            let browser_arguments = configuration
                .browser_arguments()
                .expect("browser arguments");
            assert!(browser_arguments.ends_with(&format!(" --remote-debugging-port={port}")));
            assert_eq!(
                browser_arguments
                    .matches("--remote-debugging-port=")
                    .count(),
                1
            );
            assert!(configuration.enables_webview_debugging());
        }
    }

    #[test]
    fn rejects_duplicate_unknown_malformed_privileged_and_out_of_range_arguments() {
        for arguments in [
            vec![
                "--osg-ci-updater-debug-port=1024",
                "--osg-ci-updater-debug-port=1024",
            ],
            vec!["--unknown=49152"],
            vec!["--osg-ci-updater-debug-port"],
            vec!["--osg-ci-updater-debug-port="],
            vec!["--osg-ci-updater-debug-port=1023"],
            vec!["--osg-ci-updater-debug-port=01024"],
            vec!["--osg-ci-updater-debug-port=+1024"],
            vec!["--osg-ci-updater-debug-port=65536"],
            vec!["--osg-ci-updater-debug-port=49152 "],
        ] {
            assert!(
                parse(&arguments).is_err(),
                "unexpectedly accepted {arguments:?}"
            );
        }
    }
}
