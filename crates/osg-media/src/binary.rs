use crate::{MediaError, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryKind {
    Ffmpeg,
    Ffprobe,
}

impl fmt::Display for BinaryKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Ffmpeg => "ffmpeg",
            Self::Ffprobe => "ffprobe",
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryOrigin {
    Configured,
    Bundled,
    SystemPath,
}

#[derive(Clone)]
pub struct ResolvedBinary {
    pub(crate) kind: BinaryKind,
    pub(crate) path: PathBuf,
    pub(crate) origin: BinaryOrigin,
}

impl ResolvedBinary {
    #[must_use]
    pub fn kind(&self) -> BinaryKind {
        self.kind
    }

    #[must_use]
    pub fn origin(&self) -> BinaryOrigin {
        self.origin
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl fmt::Debug for ResolvedBinary {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedBinary")
            .field("kind", &self.kind)
            .field("origin", &self.origin)
            .field("path", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Default)]
pub struct BinarySearch {
    configured_ffmpeg: Option<PathBuf>,
    configured_ffprobe: Option<PathBuf>,
    bundled_roots: Vec<PathBuf>,
    allow_system_path: bool,
}

impl BinarySearch {
    #[must_use]
    pub fn configured_ffmpeg(mut self, path: impl Into<PathBuf>) -> Self {
        self.configured_ffmpeg = Some(path.into());
        self
    }

    #[must_use]
    pub fn configured_ffprobe(mut self, path: impl Into<PathBuf>) -> Self {
        self.configured_ffprobe = Some(path.into());
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
pub struct Toolchain {
    pub(crate) ffmpeg: ResolvedBinary,
    pub(crate) ffprobe: ResolvedBinary,
}

impl Toolchain {
    #[must_use]
    pub fn ffmpeg_origin(&self) -> BinaryOrigin {
        self.ffmpeg.origin
    }

    #[must_use]
    pub fn ffprobe_origin(&self) -> BinaryOrigin {
        self.ffprobe.origin
    }

    /// Returns the already-resolved canonical `FFmpeg` executable for another
    /// native subsystem. `Toolchain` is not serializable and its debug output
    /// remains path-redacted; callers must keep this capability native-only.
    #[must_use]
    pub fn ffmpeg_executable(&self) -> &Path {
        self.ffmpeg.path()
    }

    pub(crate) fn ffmpeg(&self) -> &ResolvedBinary {
        &self.ffmpeg
    }

    pub(crate) fn ffprobe(&self) -> &ResolvedBinary {
        &self.ffprobe
    }
}

#[derive(Clone, Debug)]
pub struct ToolchainResolver {
    search: BinarySearch,
}

impl ToolchainResolver {
    #[must_use]
    pub fn new(search: BinarySearch) -> Self {
        Self { search }
    }

    pub fn resolve(&self) -> Result<Toolchain> {
        Ok(Toolchain {
            ffmpeg: self.resolve_one(BinaryKind::Ffmpeg)?,
            ffprobe: self.resolve_one(BinaryKind::Ffprobe)?,
        })
    }

    fn resolve_one(&self, kind: BinaryKind) -> Result<ResolvedBinary> {
        let configured = match kind {
            BinaryKind::Ffmpeg => self.search.configured_ffmpeg.as_deref(),
            BinaryKind::Ffprobe => self.search.configured_ffprobe.as_deref(),
        };
        if let Some(path) = configured {
            return resolve_candidate(path, kind, BinaryOrigin::Configured, None);
        }

        let mut visited = HashSet::new();
        for root in &self.search.bundled_roots {
            for candidate in bundled_candidates(root, kind) {
                if !visited.insert(candidate.clone()) || !candidate.is_file() {
                    continue;
                }
                if let Ok(binary) =
                    resolve_candidate(&candidate, kind, BinaryOrigin::Bundled, Some(root))
                {
                    return Ok(binary);
                }
            }
        }

        if self.search.allow_system_path
            && let Some(path) = find_on_path(kind)
        {
            return resolve_candidate(&path, kind, BinaryOrigin::SystemPath, None);
        }
        Err(MediaError::BinaryNotFound(kind))
    }
}

fn resolve_candidate(
    path: &Path,
    kind: BinaryKind,
    origin: BinaryOrigin,
    root: Option<&Path>,
) -> Result<ResolvedBinary> {
    if !path.is_absolute() {
        return Err(MediaError::InvalidBinary {
            tool: kind,
            reason: "path must be absolute",
        });
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| MediaError::InvalidBinary {
        tool: kind,
        reason: "file is unavailable",
    })?;
    if !canonical.is_file() || !is_executable(&canonical) {
        return Err(MediaError::InvalidBinary {
            tool: kind,
            reason: "not an executable file",
        });
    }
    if let Some(root) = root {
        let canonical_root =
            std::fs::canonicalize(root).map_err(|_| MediaError::InvalidBinary {
                tool: kind,
                reason: "bundle root is unavailable",
            })?;
        if !canonical.starts_with(canonical_root) {
            return Err(MediaError::InvalidBinary {
                tool: kind,
                reason: "bundle symlink escapes its approved root",
            });
        }
    }
    Ok(ResolvedBinary {
        kind,
        path: canonical,
        origin,
    })
}

fn executable_name(kind: BinaryKind) -> &'static str {
    match (kind, cfg!(windows)) {
        (BinaryKind::Ffmpeg, true) => "ffmpeg.exe",
        (BinaryKind::Ffprobe, true) => "ffprobe.exe",
        (BinaryKind::Ffmpeg, false) => "ffmpeg",
        (BinaryKind::Ffprobe, false) => "ffprobe",
    }
}

fn bundled_candidates(root: &Path, kind: BinaryKind) -> Vec<PathBuf> {
    let name = executable_name(kind);
    let mut candidates = vec![
        root.join(name),
        root.join("bin").join(name),
        root.join("resources").join(name),
        root.join("resources").join("bin").join(name),
        root.join("ffmpeg").join("bin").join(name),
    ];

    let remotion = root.join("node_modules").join("@remotion");
    if let Ok(entries) = std::fs::read_dir(remotion) {
        for entry in entries.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("compositor-")
            {
                candidates.push(entry.path().join(name));
            }
        }
    }
    if kind == BinaryKind::Ffmpeg {
        let installer = root.join("node_modules").join("@ffmpeg-installer");
        if let Ok(entries) = std::fs::read_dir(installer) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join(name));
            }
        }
    }
    candidates
}

fn find_on_path(kind: BinaryKind) -> Option<PathBuf> {
    let name = executable_name(kind);
    env::split_paths(&env::var_os("PATH")?)
        .map(|directory| directory.join(name))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
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
    fn configured_paths_must_be_absolute() {
        let error = ToolchainResolver::new(
            BinarySearch::default()
                .configured_ffmpeg("ffmpeg")
                .configured_ffprobe("ffprobe"),
        )
        .resolve()
        .unwrap_err();
        assert!(matches!(error, MediaError::InvalidBinary { .. }));
    }

    #[test]
    fn debug_never_discloses_resolved_path() {
        let binary = ResolvedBinary {
            kind: BinaryKind::Ffmpeg,
            path: PathBuf::from("C:/private/ffmpeg.exe"),
            origin: BinaryOrigin::Configured,
        };
        let debug = format!("{binary:?}");
        assert!(!debug.contains("private"));
        assert!(debug.contains("<redacted>"));
    }

    #[test]
    fn toolchain_native_ffmpeg_accessor_is_exact_and_debug_redacted() {
        let ffmpeg_path = PathBuf::from("C:/private/ffmpeg.exe");
        let toolchain = Toolchain {
            ffmpeg: ResolvedBinary {
                kind: BinaryKind::Ffmpeg,
                path: ffmpeg_path.clone(),
                origin: BinaryOrigin::Configured,
            },
            ffprobe: ResolvedBinary {
                kind: BinaryKind::Ffprobe,
                path: PathBuf::from("C:/private/ffprobe.exe"),
                origin: BinaryOrigin::Configured,
            },
        };
        assert_eq!(toolchain.ffmpeg_executable(), ffmpeg_path);
        assert!(!format!("{toolchain:?}").contains("private"));
    }

    #[cfg(unix)]
    #[test]
    fn unix_configured_binary_requires_execute_permission() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ffmpeg");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(
            resolve_candidate(&path, BinaryKind::Ffmpeg, BinaryOrigin::Configured, None),
            Err(MediaError::InvalidBinary { .. })
        ));

        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            resolve_candidate(&path, BinaryKind::Ffmpeg, BinaryOrigin::Configured, None).is_ok()
        );
    }
}
