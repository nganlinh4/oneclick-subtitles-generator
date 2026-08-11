use crate::{Result, SpeechError};
use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerOrigin {
    Configured,
    Bundled,
    SystemPath,
}

/// A trusted executable and optional fixed worker bootstrap. Neither value can
/// be serialized or supplied as an operation argument by a `WebView`.
#[derive(Clone)]
pub struct WorkerProgram {
    executable: PathBuf,
    bootstrap: Option<PathBuf>,
    model_root: Option<PathBuf>,
    origin: WorkerOrigin,
}

impl WorkerProgram {
    pub fn native(executable: &Path) -> Result<Self> {
        resolve_program(executable, None, None, WorkerOrigin::Configured, None)
    }

    pub fn bootstrap(executable: &Path, bootstrap: &Path) -> Result<Self> {
        resolve_program(
            executable,
            Some(bootstrap),
            None,
            WorkerOrigin::Configured,
            None,
        )
    }

    /// Builds a worker contract pinned to a native-managed, integrity-checked
    /// model directory. The path never crosses the `WebView` boundary.
    pub fn managed_bootstrap(
        executable: &Path,
        bootstrap: &Path,
        model_root: Option<&Path>,
    ) -> Result<Self> {
        resolve_program(
            executable,
            Some(bootstrap),
            model_root,
            WorkerOrigin::Configured,
            None,
        )
    }

    #[must_use]
    pub fn origin(&self) -> WorkerOrigin {
        self.origin
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }

    pub(crate) fn bootstrap_path(&self) -> Option<&Path> {
        self.bootstrap.as_deref()
    }

    pub(crate) fn model_root(&self) -> Option<&Path> {
        self.model_root.as_deref()
    }

    pub(crate) fn revalidate(&self) -> Result<()> {
        if !self.executable.is_file() || !is_executable(&self.executable) {
            return Err(SpeechError::InvalidWorker("worker executable changed"));
        }
        if self.bootstrap.as_ref().is_some_and(|path| {
            !path.is_file()
                || !path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
        }) {
            return Err(SpeechError::InvalidWorker("worker bootstrap changed"));
        }
        if self.model_root.as_ref().is_some_and(|path| !path.is_dir()) {
            return Err(SpeechError::InvalidWorker("worker model root changed"));
        }
        Ok(())
    }
}

impl fmt::Debug for WorkerProgram {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerProgram")
            .field("origin", &self.origin)
            .field("executable", &"<redacted>")
            .field("bootstrap", &self.bootstrap.as_ref().map(|_| "<redacted>"))
            .field(
                "model_root",
                &self.model_root.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

#[derive(Clone, Default)]
pub struct WorkerSearch {
    configured: Option<WorkerProgram>,
    bundled_roots: Vec<PathBuf>,
    allow_system_path: bool,
}

impl WorkerSearch {
    #[must_use]
    pub fn configured(mut self, program: WorkerProgram) -> Self {
        self.configured = Some(program);
        self
    }

    #[must_use]
    pub fn bundled_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.bundled_roots.push(root.into());
        self
    }

    #[must_use]
    pub fn allow_system_path(mut self, allow: bool) -> Self {
        self.allow_system_path = allow;
        self
    }
}

impl fmt::Debug for WorkerSearch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerSearch")
            .field("configured", &self.configured.is_some())
            .field("bundled_root_count", &self.bundled_roots.len())
            .field("allow_system_path", &self.allow_system_path)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct WorkerResolver {
    search: WorkerSearch,
}

impl WorkerResolver {
    #[must_use]
    pub fn new(search: WorkerSearch) -> Self {
        Self { search }
    }

    pub fn resolve(&self) -> Result<WorkerProgram> {
        if let Some(program) = &self.search.configured {
            return revalidate_program(program);
        }
        let mut visited = HashSet::new();
        for root in &self.search.bundled_roots {
            for candidate in bundled_candidates(root) {
                if !visited.insert(candidate.clone()) {
                    continue;
                }
                let result = match candidate {
                    Candidate::Native(executable) => {
                        resolve_program(&executable, None, None, WorkerOrigin::Bundled, Some(root))
                    }
                    Candidate::Bootstrap(executable, bootstrap) => resolve_program(
                        &executable,
                        Some(&bootstrap),
                        None,
                        WorkerOrigin::Bundled,
                        Some(root),
                    ),
                };
                if let Ok(program) = result {
                    return Ok(program);
                }
            }
        }
        if self.search.allow_system_path
            && let Some(executable) = find_on_path()
        {
            return resolve_program(&executable, None, None, WorkerOrigin::SystemPath, None);
        }
        Err(SpeechError::WorkerNotFound)
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
enum Candidate {
    Native(PathBuf),
    Bootstrap(PathBuf, PathBuf),
}

fn revalidate_program(program: &WorkerProgram) -> Result<WorkerProgram> {
    resolve_program(
        &program.executable,
        program.bootstrap.as_deref(),
        program.model_root.as_deref(),
        program.origin,
        None,
    )
}

fn resolve_program(
    executable: &Path,
    bootstrap: Option<&Path>,
    model_root: Option<&Path>,
    origin: WorkerOrigin,
    bundled_root: Option<&Path>,
) -> Result<WorkerProgram> {
    let executable = canonical_executable(executable)?;
    let bootstrap = bootstrap.map(canonical_bootstrap).transpose()?;
    let model_root = model_root.map(canonical_directory).transpose()?;
    if let Some(root) = bundled_root {
        let root = std::fs::canonicalize(root)
            .map_err(|_| SpeechError::InvalidWorker("bundle root is unavailable"))?;
        if !root.is_dir()
            || !executable.starts_with(&root)
            || bootstrap
                .as_ref()
                .is_some_and(|path| !path.starts_with(&root))
        {
            return Err(SpeechError::InvalidWorker(
                "bundle program escapes its approved root",
            ));
        }
    }
    Ok(WorkerProgram {
        executable,
        bootstrap,
        model_root,
        origin,
    })
}

fn canonical_executable(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(SpeechError::InvalidWorker(
            "executable path must be absolute",
        ));
    }
    // Preserve the final executable entry after canonicalizing its directory. Unix virtual
    // environments normally expose `bin/python3` as a symlink; resolving that last component to
    // the base interpreter would silently discard the venv's package context at process launch.
    let name = path
        .file_name()
        .ok_or(SpeechError::InvalidWorker("executable is unavailable"))?;
    let parent = path
        .parent()
        .ok_or(SpeechError::InvalidWorker("executable is unavailable"))?;
    let path = std::fs::canonicalize(parent)
        .map_err(|_| SpeechError::InvalidWorker("executable is unavailable"))?
        .join(name);
    if !path.is_file() || !is_executable(&path) {
        return Err(SpeechError::InvalidWorker(
            "worker is not an executable file",
        ));
    }
    Ok(path)
}

fn canonical_bootstrap(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(SpeechError::InvalidWorker(
            "bootstrap path must be absolute",
        ));
    }
    let path = std::fs::canonicalize(path)
        .map_err(|_| SpeechError::InvalidWorker("bootstrap is unavailable"))?;
    if !path.is_file()
        || !path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
    {
        return Err(SpeechError::InvalidWorker(
            "bootstrap must be a regular Python file",
        ));
    }
    Ok(path)
}

fn canonical_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(SpeechError::InvalidWorker(
            "model root path must be absolute",
        ));
    }
    let path = std::fs::canonicalize(path)
        .map_err(|_| SpeechError::InvalidWorker("model root is unavailable"))?;
    if !path.is_dir() {
        return Err(SpeechError::InvalidWorker("model root is unavailable"));
    }
    Ok(path)
}

fn bundled_candidates(root: &Path) -> Vec<Candidate> {
    let worker = worker_name();
    let python = python_name();
    let scripts = if cfg!(windows) { "Scripts" } else { "bin" };
    let bootstrap = root.join("speech_worker.py");
    vec![
        Candidate::Native(root.join(worker)),
        Candidate::Native(root.join("bin").join(worker)),
        Candidate::Native(root.join("resources").join(worker)),
        Candidate::Native(root.join("resources").join("bin").join(worker)),
        Candidate::Bootstrap(
            root.join(".venv").join(scripts).join(python),
            bootstrap.clone(),
        ),
        Candidate::Bootstrap(
            root.join("python-venv")
                .join("venv")
                .join(scripts)
                .join(python),
            bootstrap.clone(),
        ),
        Candidate::Bootstrap(
            root.join("bin")
                .join("python-wheelhouse")
                .join("venv")
                .join(scripts)
                .join(python),
            bootstrap,
        ),
    ]
}

fn find_on_path() -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .map(|directory| directory.join(worker_name()))
        .find(|candidate| candidate.is_file() && is_executable(candidate))
}

fn worker_name() -> &'static str {
    if cfg!(windows) {
        "osg-speech-worker.exe"
    } else {
        "osg-speech-worker"
    }
}

fn python_name() -> &'static str {
    if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    }
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
    fn relative_programs_are_rejected() {
        assert!(WorkerProgram::native(Path::new("worker.exe")).is_err());
    }

    #[test]
    fn search_and_program_debug_redact_paths() {
        let search = WorkerSearch::default().bundled_root("C:/private/models");
        assert!(!format!("{search:?}").contains("private"));
    }

    #[test]
    fn managed_program_revalidates_and_redacts_its_model_capability() {
        let directory = tempfile::tempdir().unwrap();
        let bootstrap = directory.path().join("speech_worker.py");
        let model_root = directory.path().join("private-models");
        std::fs::write(&bootstrap, b"# fixture").unwrap();
        std::fs::create_dir(&model_root).unwrap();

        let executable = std::env::current_exe().unwrap();
        let program =
            WorkerProgram::managed_bootstrap(&executable, &bootstrap, Some(&model_root)).unwrap();
        let debug = format!("{program:?}");
        assert!(!debug.contains("private-models"));
        assert!(!debug.contains(&executable.display().to_string()));
        assert!(program.revalidate().is_ok());

        std::fs::remove_dir(&model_root).unwrap();
        assert!(matches!(
            program.revalidate(),
            Err(SpeechError::InvalidWorker("worker model root changed"))
        ));
    }

    #[test]
    fn managed_program_rejects_relative_model_roots() {
        let directory = tempfile::tempdir().unwrap();
        let bootstrap = directory.path().join("speech_worker.py");
        std::fs::write(&bootstrap, b"# fixture").unwrap();
        let executable = std::env::current_exe().unwrap();

        assert!(matches!(
            WorkerProgram::managed_bootstrap(
                &executable,
                &bootstrap,
                Some(Path::new("relative-model-root")),
            ),
            Err(SpeechError::InvalidWorker(
                "model root path must be absolute"
            ))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn unix_worker_requires_execute_permission() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("osg-speech-worker");
        std::fs::write(&path, b"fixture").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(WorkerProgram::native(&path).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(WorkerProgram::native(&path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn unix_virtual_environment_symlink_is_preserved_for_launch() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let directory = tempfile::tempdir().unwrap();
        let runtime = directory.path().join("runtime-python");
        let environment = directory.path().join("venv/bin");
        std::fs::create_dir_all(&environment).unwrap();
        std::fs::write(&runtime, b"fixture").unwrap();
        std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
        let python = environment.join("python3");
        symlink(&runtime, &python).unwrap();

        let program = WorkerProgram::native(&python).unwrap();
        let expected = std::fs::canonicalize(&environment).unwrap().join("python3");
        assert_eq!(program.executable(), expected);
        assert!(
            std::fs::symlink_metadata(program.executable())
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
}
