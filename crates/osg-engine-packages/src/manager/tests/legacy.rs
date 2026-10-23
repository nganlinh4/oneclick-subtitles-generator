//! Legacy adoption is offline, verified, and all-or-nothing.

use super::*;
#[test]
fn verified_legacy_install_is_adopted_without_network_access() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = temp.path().join("legacy-runtime");
    let model = temp.path().join("legacy-model");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&model).unwrap();
    fs::write(runtime.join("python.exe"), PYTHON_BYTES).unwrap();
    fs::write(model.join("config.json"), MODEL_BYTES).unwrap();
    let layout = LegacyLayout::new(&runtime, &model, None).unwrap();
    let fixture = fixture();
    let manager = manager(
        &temp,
        fixture.catalog,
        Arc::new(PanicFetcher),
        Arc::new(TestCoordinator::default()),
    );
    let adopted = manager
        .adopt_legacy(
            EngineId::Parakeet,
            &layout,
            &CancellationToken::default(),
            &|_| {},
        )
        .unwrap();
    assert_eq!(adopted.state, EnginePackageState::Installed);
}

#[test]
fn modified_legacy_install_is_rejected_without_partial_readiness() {
    let temp = tempfile::tempdir().unwrap();
    let runtime = temp.path().join("legacy-runtime");
    let model = temp.path().join("legacy-model");
    fs::create_dir_all(&runtime).unwrap();
    fs::create_dir_all(&model).unwrap();
    fs::write(runtime.join("python.exe"), PYTHON_BYTES).unwrap();
    fs::write(model.join("config.json"), b"other").unwrap();
    let layout = LegacyLayout::new(&runtime, &model, None).unwrap();
    let fixture = fixture();
    let manager = manager(
        &temp,
        fixture.catalog,
        Arc::new(PanicFetcher),
        Arc::new(TestCoordinator::default()),
    );
    assert_eq!(
        manager.adopt_legacy(
            EngineId::Parakeet,
            &layout,
            &CancellationToken::default(),
            &|_| {},
        ),
        Err(PackageError::InvalidInstall)
    );
    assert_eq!(
        manager.status(EngineId::Parakeet).state,
        EnginePackageState::Missing
    );
}
