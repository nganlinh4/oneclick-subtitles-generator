use crate::{AsrEngineId, AsrError, Result};
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Clone)]
pub struct WorkerProgram {
    executable: PathBuf,
    script: Option<PathBuf>,
}

impl WorkerProgram {
    /// Resolve a packaged standalone worker executable.
    pub fn executable(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            executable: resolve_executable(path.as_ref())?,
            script: None,
        })
    }

    /// Resolve a pinned virtual-environment Python and the bundled worker script.
    pub fn python(
        python_executable: impl AsRef<Path>,
        worker_script: impl AsRef<Path>,
    ) -> Result<Self> {
        let executable = resolve_executable(python_executable.as_ref())?;
        let script = std::fs::canonicalize(worker_script).map_err(|_| AsrError::InvalidRuntime)?;
        if !script.is_file()
            || !script
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
        {
            return Err(AsrError::InvalidRuntime);
        }
        Ok(Self {
            executable,
            script: Some(script),
        })
    }

    pub(crate) fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        if let Some(script) = &self.script {
            // Isolated mode ignores ambient PYTHONPATH/user site-packages; the selected
            // virtual environment's installed packages remain available. Bytecode writes are
            // disabled because managed runtimes are integrity-checked, immutable package trees.
            command.args(["-I", "-B", "-u"]).arg(script);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.current_dir(
            self.script
                .as_deref()
                .and_then(Path::parent)
                .or_else(|| self.executable.parent())
                .unwrap_or_else(|| Path::new(".")),
        );
        apply_sanitized_environment(&mut command);
        command
    }
}

impl fmt::Debug for WorkerProgram {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WorkerProgram")
            .field("executable", &"<redacted>")
            .field("script", &self.script.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

#[derive(Clone)]
pub struct ModelAssets {
    engine: AsrEngineId,
    model_directory: PathBuf,
    aligner_directory: Option<PathBuf>,
}

impl ModelAssets {
    pub fn new(
        engine: AsrEngineId,
        model_directory: impl AsRef<Path>,
        aligner_directory: Option<&Path>,
    ) -> Result<Self> {
        let model_directory = resolve_directory(model_directory.as_ref())?;
        let aligner_directory = aligner_directory.map(resolve_directory).transpose()?;
        if engine.needs_aligner() != aligner_directory.is_some() {
            return Err(AsrError::InvalidRuntime);
        }
        Ok(Self {
            engine,
            model_directory,
            aligner_directory,
        })
    }

    #[must_use]
    pub const fn engine(&self) -> AsrEngineId {
        self.engine
    }

    pub(crate) fn model_directory(&self) -> &Path {
        &self.model_directory
    }

    pub(crate) fn aligner_directory(&self) -> Option<&Path> {
        self.aligner_directory.as_deref()
    }

    pub(crate) fn revalidate(&self) -> Result<()> {
        if !self.model_directory.is_dir()
            || self
                .aligner_directory
                .as_ref()
                .is_some_and(|path| !path.is_dir())
        {
            return Err(AsrError::InvalidRuntime);
        }
        Ok(())
    }
}

impl fmt::Debug for ModelAssets {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelAssets")
            .field("engine", &self.engine)
            .field("model_directory", &"<redacted>")
            .field(
                "aligner_directory",
                &self.aligner_directory.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

fn resolve_directory(path: &Path) -> Result<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|_| AsrError::InvalidRuntime)?;
    canonical
        .is_dir()
        .then_some(canonical)
        .ok_or(AsrError::InvalidRuntime)
}

fn resolve_executable(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(AsrError::InvalidRuntime);
    }
    let canonical = std::fs::canonicalize(path).map_err(|_| AsrError::InvalidRuntime)?;
    if !canonical.is_file() || !is_executable(&canonical) {
        return Err(AsrError::InvalidRuntime);
    }
    Ok(canonical)
}

pub(crate) fn native_process_path(path: &Path) -> Result<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AsrError::InvalidRuntime);
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};

        const DEVICE_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
        const UNC_PREFIX: &[u16] = &[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16];
        let encoded = path.as_os_str().encode_wide().collect::<Vec<_>>();
        if let Some(remainder) = encoded.strip_prefix(DEVICE_PREFIX) {
            let normalized = if let Some(unc) = remainder.strip_prefix(UNC_PREFIX) {
                let mut value = vec![u16::from(b'\\'), u16::from(b'\\')];
                value.extend_from_slice(unc);
                value
            } else {
                remainder.to_vec()
            };
            return Ok(PathBuf::from(std::ffi::OsString::from_wide(&normalized)));
        }
    }
    Ok(path.to_path_buf())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        extension.eq_ignore_ascii_case("exe") || extension.eq_ignore_ascii_case("com")
    })
}

fn apply_sanitized_environment(command: &mut Command) {
    command.env_clear();
    for key in [
        "SystemRoot",
        "WINDIR",
        "PATH",
        "PATHEXT",
        "TEMP",
        "TMP",
        "TMPDIR",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "CUDA_VISIBLE_DEVICES",
        "PYTORCH_CUDA_ALLOC_CONF",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.envs([
        ("PYTHONUTF8", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("HF_HUB_OFFLINE", "1"),
        ("TRANSFORMERS_OFFLINE", "1"),
        ("TOKENIZERS_PARALLELISM", "false"),
    ]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn python_workers_cannot_mutate_managed_packages_with_bytecode() {
        use std::ffi::OsStr;

        let runtime = tempfile::tempdir().unwrap();
        let python = runtime.path().join("python.exe");
        let worker = runtime.path().join("worker.py");
        std::fs::write(&python, b"managed python").unwrap();
        std::fs::write(&worker, b"# managed worker\n").unwrap();
        let program = WorkerProgram::python(&python, &worker).unwrap();
        let command = program.command();
        let args = command.get_args().collect::<Vec<_>>();
        assert!(
            args.windows(3)
                .any(|args| { args == [OsStr::new("-I"), OsStr::new("-B"), OsStr::new("-u")] })
        );
        assert!(command.get_envs().any(|(key, value)| {
            key == OsStr::new("PYTHONDONTWRITEBYTECODE") && value == Some(OsStr::new("1"))
        }));
    }

    #[cfg(windows)]
    #[test]
    fn python_library_paths_drop_only_the_windows_extended_length_prefix() {
        assert_eq!(
            native_process_path(Path::new(r"\\?\C:\managed\model")).unwrap(),
            PathBuf::from(r"C:\managed\model")
        );
        assert_eq!(
            native_process_path(Path::new(r"\\?\UNC\server\share\model")).unwrap(),
            PathBuf::from(r"\\server\share\model")
        );
        assert_eq!(
            native_process_path(Path::new(r"C:\managed\model")).unwrap(),
            PathBuf::from(r"C:\managed\model")
        );
        assert!(native_process_path(Path::new("relative")).is_err());
    }

    #[test]
    fn model_assets_require_the_qwen_aligner_and_redact_paths() {
        let model = tempfile::tempdir().unwrap();
        let aligner = tempfile::tempdir().unwrap();
        assert!(ModelAssets::new(AsrEngineId::Qwen3Asr0_6b, model.path(), None).is_err());
        let assets = ModelAssets::new(
            AsrEngineId::Qwen3Asr0_6b,
            model.path(),
            Some(aligner.path()),
        )
        .unwrap();
        let debug = format!("{assets:?}");
        assert!(!debug.contains(&model.path().display().to_string()));
        assert!(debug.contains("<redacted>"));
    }
}
