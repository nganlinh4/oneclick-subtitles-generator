use std::path::{Path, PathBuf};

/// Spells an absolute path the way a child process expects it.
///
/// Canonical Windows paths carry the `\\?\` extended-length prefix, which Python and other
/// runtimes mishandle; this removes only that prefix (`\\?\UNC\` becomes `\\`). Returns `None` for
/// an empty or relative path, which a worker must never receive.
#[must_use]
pub fn native_process_path(path: &Path) -> Option<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};

        let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        let unc_prefix = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
        if let Some(share) = encoded.strip_prefix(unc_prefix.as_slice()) {
            let mut normalized = r"\\".encode_utf16().collect::<Vec<_>>();
            normalized.extend_from_slice(share);
            return Some(PathBuf::from(OsString::from_wide(&normalized)));
        }
        let extended_prefix = r"\\?\".encode_utf16().collect::<Vec<_>>();
        if let Some(local) = encoded.strip_prefix(extended_prefix.as_slice()) {
            return Some(PathBuf::from(OsString::from_wide(local)));
        }
    }
    Some(path.to_owned())
}

#[cfg(test)]
mod tests {
    use super::native_process_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn empty_and_relative_paths_are_refused() {
        assert_eq!(native_process_path(Path::new("")), None);
        assert_eq!(native_process_path(Path::new("relative")), None);
    }

    #[cfg(not(windows))]
    #[test]
    fn absolute_unix_paths_pass_through_unchanged() {
        assert_eq!(
            native_process_path(Path::new("/opt/osg/model")),
            Some(PathBuf::from("/opt/osg/model"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn only_the_extended_length_prefix_is_removed() {
        for (input, expected) in [
            (r"\\?\C:\managed\model", r"C:\managed\model"),
            (r"\\?\UNC\server\share\model", r"\\server\share\model"),
            (r"C:\managed\model", r"C:\managed\model"),
            (r"\\server\share\model", r"\\server\share\model"),
        ] {
            assert_eq!(
                native_process_path(Path::new(input)),
                Some(PathBuf::from(expected)),
                "{input}"
            );
        }
    }
}
