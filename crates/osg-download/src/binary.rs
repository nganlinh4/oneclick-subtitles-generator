use crate::{DownloadError, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryOrigin {
    Configured,
    Bundled,
    SystemPath,
}

#[derive(Clone)]
pub struct ResolvedYtDlp {
    pub(crate) path: PathBuf,
    origin: BinaryOrigin,
}

/// Native-only capability for the Deno runtime used by `yt-dlp`'s `YouTube`
/// challenge solver. The executable path is never serializable or logged.
#[derive(Clone)]
pub struct ResolvedJsRuntime {
    pub(crate) path: PathBuf,
    origin: BinaryOrigin,
}

impl ResolvedJsRuntime {
    #[must_use]
    pub fn origin(&self) -> BinaryOrigin {
        self.origin
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for ResolvedJsRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedJsRuntime")
            .field("origin", &self.origin)
            .field("path", &"<redacted>")
            .finish()
    }
}

impl ResolvedYtDlp {
    #[must_use]
    pub fn origin(&self) -> BinaryOrigin {
        self.origin
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for ResolvedYtDlp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedYtDlp")
            .field("origin", &self.origin)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct YtDlpSearch {
    configured: Option<PathBuf>,
    bundled_roots: Vec<PathBuf>,
    allow_system_path: bool,
}

impl fmt::Debug for YtDlpSearch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("YtDlpSearch")
            .field("configured", &self.configured.is_some())
            .field("bundled_root_count", &self.bundled_roots.len())
            .field("allow_system_path", &self.allow_system_path)
            .finish()
    }
}

impl YtDlpSearch {
    #[must_use]
    pub fn configured(mut self, path: impl Into<PathBuf>) -> Self {
        self.configured = Some(path.into());
        self
    }

    #[must_use]
    pub fn bundled_root(mut self, path: impl Into<PathBuf>) -> Self {
        self.bundled_roots.push(path.into());
        self
    }

    #[must_use]
    pub fn allow_system_path(mut self, allow: bool) -> Self {
        self.allow_system_path = allow;
        self
    }
}

#[derive(Clone, Debug)]
pub struct YtDlpResolver {
    search: YtDlpSearch,
}

#[derive(Clone, Default)]
pub struct JsRuntimeSearch {
    configured: Option<PathBuf>,
    bundled_roots: Vec<PathBuf>,
    allow_system_path: bool,
}

impl fmt::Debug for JsRuntimeSearch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("JsRuntimeSearch")
            .field("configured", &self.configured.is_some())
            .field("bundled_root_count", &self.bundled_roots.len())
            .field("allow_system_path", &self.allow_system_path)
            .finish()
    }
}

impl JsRuntimeSearch {
    #[must_use]
    pub fn configured(mut self, path: impl Into<PathBuf>) -> Self {
        self.configured = Some(path.into());
        self
    }

    #[must_use]
    pub fn bundled_root(mut self, path: impl Into<PathBuf>) -> Self {
        self.bundled_roots.push(path.into());
        self
    }

    #[must_use]
    pub fn allow_system_path(mut self, allow: bool) -> Self {
        self.allow_system_path = allow;
        self
    }
}

#[derive(Clone, Debug)]
pub struct JsRuntimeResolver {
    search: JsRuntimeSearch,
}

impl JsRuntimeResolver {
    #[must_use]
    pub fn new(search: JsRuntimeSearch) -> Self {
        Self { search }
    }

    pub fn resolve(&self) -> Result<ResolvedJsRuntime> {
        if let Some(path) = &self.search.configured {
            return resolve_js_candidate(path, BinaryOrigin::Configured, None);
        }

        let mut visited = HashSet::new();
        for root in &self.search.bundled_roots {
            for candidate in js_bundled_candidates(root) {
                if !visited.insert(candidate.clone()) || !candidate.is_file() {
                    continue;
                }
                if let Ok(runtime) =
                    resolve_js_candidate(&candidate, BinaryOrigin::Bundled, Some(root))
                {
                    return Ok(runtime);
                }
            }
        }

        if self.search.allow_system_path
            && let Some(candidate) = find_executable_on_path(js_executable_name())
        {
            return resolve_js_candidate(&candidate, BinaryOrigin::SystemPath, None);
        }
        Err(DownloadError::JavaScriptRuntimeNotFound)
    }
}

impl YtDlpResolver {
    #[must_use]
    pub fn new(search: YtDlpSearch) -> Self {
        Self { search }
    }

    pub fn resolve(&self) -> Result<ResolvedYtDlp> {
        if let Some(path) = &self.search.configured {
            return resolve_candidate(path, BinaryOrigin::Configured, None);
        }

        let mut visited = HashSet::new();
        for root in &self.search.bundled_roots {
            for candidate in bundled_candidates(root) {
                if !visited.insert(candidate.clone()) || !candidate.is_file() {
                    continue;
                }
                if let Ok(binary) = resolve_candidate(&candidate, BinaryOrigin::Bundled, Some(root))
                {
                    return Ok(binary);
                }
            }
        }

        if self.search.allow_system_path
            && let Some(candidate) = find_on_path()
        {
            return resolve_candidate(&candidate, BinaryOrigin::SystemPath, None);
        }
        Err(DownloadError::BinaryNotFound)
    }
}

fn resolve_candidate(
    path: &Path,
    origin: BinaryOrigin,
    bundled_root: Option<&Path>,
) -> Result<ResolvedYtDlp> {
    if !path.is_absolute() {
        return Err(DownloadError::InvalidBinary("path must be absolute"));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| DownloadError::InvalidBinary("file unavailable"))?;
    if !canonical.is_file() || !is_executable(&canonical) {
        return Err(DownloadError::InvalidBinary("not an executable file"));
    }
    if let Some(root) = bundled_root {
        let root = std::fs::canonicalize(root)
            .map_err(|_| DownloadError::InvalidBinary("bundle root unavailable"))?;
        if !canonical.starts_with(root) {
            return Err(DownloadError::InvalidBinary(
                "bundle symlink escapes its approved root",
            ));
        }
    }
    Ok(ResolvedYtDlp {
        path: canonical,
        origin,
    })
}

fn bundled_candidates(root: &Path) -> Vec<PathBuf> {
    let executable = executable_name();
    let scripts = if cfg!(windows) { "Scripts" } else { "bin" };
    vec![
        root.join(executable),
        root.join("bin").join(executable),
        root.join("resources").join(executable),
        root.join("resources").join("bin").join(executable),
        root.join(".venv").join(scripts).join(executable),
        root.join("python-venv")
            .join("venv")
            .join(scripts)
            .join(executable),
        root.join("bin")
            .join("python-wheelhouse")
            .join("venv")
            .join(scripts)
            .join(executable),
    ]
}

fn find_on_path() -> Option<PathBuf> {
    find_executable_on_path(executable_name())
}

fn find_executable_on_path(executable: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|directory| directory.join(executable))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
}

fn executable_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
}

fn resolve_js_candidate(
    path: &Path,
    origin: BinaryOrigin,
    bundled_root: Option<&Path>,
) -> Result<ResolvedJsRuntime> {
    if !path.is_absolute() {
        return Err(DownloadError::InvalidJavaScriptRuntime(
            "path must be absolute",
        ));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| DownloadError::InvalidJavaScriptRuntime("file unavailable"))?;
    if !canonical.is_file() || !is_executable(&canonical) {
        return Err(DownloadError::InvalidJavaScriptRuntime(
            "not an executable file",
        ));
    }
    if let Some(root) = bundled_root {
        let root = std::fs::canonicalize(root)
            .map_err(|_| DownloadError::InvalidJavaScriptRuntime("bundle root unavailable"))?;
        if !canonical.starts_with(root) {
            return Err(DownloadError::InvalidJavaScriptRuntime(
                "bundle symlink escapes its approved root",
            ));
        }
    }
    Ok(ResolvedJsRuntime {
        path: canonical,
        origin,
    })
}

fn js_bundled_candidates(root: &Path) -> Vec<PathBuf> {
    let executable = js_executable_name();
    vec![
        root.join(executable),
        root.join("bin").join(executable),
        root.join("resources").join(executable),
        root.join("resources").join("bin").join(executable),
    ]
}

fn js_executable_name() -> &'static str {
    if cfg!(windows) { "deno.exe" } else { "deno" }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_configured_path_is_rejected() {
        let error = YtDlpResolver::new(YtDlpSearch::default().configured("yt-dlp"))
            .resolve()
            .unwrap_err();
        assert!(matches!(error, DownloadError::InvalidBinary(_)));
    }

    #[test]
    fn debug_redacts_binary_path() {
        let binary = ResolvedYtDlp {
            path: PathBuf::from("C:/secret/yt-dlp.exe"),
            origin: BinaryOrigin::Configured,
        };
        let debug = format!("{binary:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn search_debug_redacts_configured_and_bundle_paths() {
        let search = YtDlpSearch::default()
            .configured("C:/secret/configured/yt-dlp.exe")
            .bundled_root("C:/secret/bundle");
        let debug = format!("{search:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("bundled_root_count: 1"));
    }

    #[test]
    fn javascript_runtime_search_and_debug_are_path_redacted() {
        let search = JsRuntimeSearch::default()
            .configured("C:/secret/configured/deno.exe")
            .bundled_root("C:/secret/bundle");
        let debug = format!("{search:?}");
        assert!(!debug.contains("secret"));
        assert!(debug.contains("bundled_root_count: 1"));
        assert!(matches!(
            JsRuntimeResolver::new(JsRuntimeSearch::default().configured("deno")).resolve(),
            Err(DownloadError::InvalidJavaScriptRuntime(_))
        ));

        let runtime = ResolvedJsRuntime {
            path: PathBuf::from("C:/secret/deno.exe"),
            origin: BinaryOrigin::Configured,
        };
        assert!(!format!("{runtime:?}").contains("secret"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_binary_must_have_an_execute_bit() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("yt-dlp");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(resolve_candidate(&path, BinaryOrigin::Configured, None).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(resolve_candidate(&path, BinaryOrigin::Configured, None).is_ok());
    }
}
