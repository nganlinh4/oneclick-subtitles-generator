use super::*;

#[test]
fn the_worker_environment_is_the_allowlist_plus_fixed_values_and_never_the_secret() {
    let cache = tempfile::tempdir().unwrap();
    let bootstrap = cache.path().join("speech_worker.py");
    let model_root = cache.path().join("models");
    std::fs::write(&bootstrap, b"# fixture").unwrap();
    std::fs::create_dir(&model_root).unwrap();
    let program = WorkerProgram::managed_bootstrap(
        &std::env::current_exe().unwrap(),
        &bootstrap,
        Some(&model_root),
    )
    .unwrap();
    let worker = LazySpeechWorker::new(program, SpeechBackend::GeminiLive)
        .with_provider_secret(SecretValue::new("super-secret").unwrap());
    let command = worker.worker_command(cache.path()).unwrap();

    let fixed = [
        "PYTHONUTF8",
        "PYTHONUNBUFFERED",
        "PYTHONDONTWRITEBYTECODE",
        "NUMBA_CACHE_DIR",
        "NO_COLOR",
        "OSG_SPEECH_MODEL_ROOT",
        "HF_HUB_OFFLINE",
        "HF_DATASETS_OFFLINE",
        "TRANSFORMERS_OFFLINE",
    ];
    let allowed = environment::allowlist(INHERITED_ENVIRONMENT).collect::<Vec<_>>();
    for (key, value) in command.get_envs() {
        let key = key.to_string_lossy();
        let value = value.unwrap_or_else(|| panic!("{key} is removed instead of never copied"));
        assert!(!value.to_string_lossy().contains("super-secret"), "{key}");
        assert!(
            allowed
                .iter()
                .chain(&fixed)
                .any(|name| name.eq_ignore_ascii_case(&key)),
            "{key} would reach the speech worker"
        );
    }
    for name in fixed {
        assert!(command.get_envs().any(|(key, _)| key == name), "{name}");
    }
    assert!(
        command
            .get_args()
            .all(|argument| !argument.to_string_lossy().contains("super-secret"))
    );
}

#[test]
fn only_gemini_frames_carry_the_provider_secret() {
    let program = WorkerProgram::native(&std::env::current_exe().unwrap()).unwrap();
    let secret = SecretValue::new("super-secret").unwrap();
    let gemini = LazySpeechWorker::new(program.clone(), SpeechBackend::GeminiLive)
        .with_provider_secret(secret.clone());
    let edge = LazySpeechWorker::new(program, SpeechBackend::EdgeTts).with_provider_secret(secret);
    assert!(gemini.frame_secret().is_some());
    assert!(edge.frame_secret().is_none());
}
